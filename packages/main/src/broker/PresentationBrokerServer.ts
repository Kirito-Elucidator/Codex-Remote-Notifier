import { timingSafeEqual } from 'node:crypto';
import { createServer, Server, Socket } from 'node:net';

import {
  parsePresentationExchange,
  PresentationRecord,
} from 'remote-notifier-shared/attentionExchange';

import {
  BrokerRuntimePaths,
  createEpochCredential,
  createPresentationEpoch,
  PRESENTATION_BROKER_DRAIN_TIMEOUT_MS,
  PRESENTATION_BROKER_IDLE_TIMEOUT_MS,
  PRESENTATION_BROKER_PROTOCOL_VERSION,
  removeOwnedBrokerDiscovery,
  writeBrokerDiscovery,
} from './BrokerProtocol';
import { PresentationLedger } from './PresentationLedger';

const MAXIMUM_WIRE_MESSAGE_BYTES = 70 * 1024;

export interface PresentationBrokerServerOptions {
  paths: BrokerRuntimePaths;
  cleanupEpochItems?: (records: PresentationRecord[]) => Promise<void>;
  drainTimeoutMs?: number;
  idleTimeoutMs?: number;
  protocolVersion?: number;
}

export type BrokerStartOutcome = 'existing' | 'started';
export type BrokerStopReason = 'controlled' | 'idle' | 'incompatible-replacement' | 'test-cleanup';

export class PresentationBrokerServer {
  private readonly cleanupEpochItems: (records: PresentationRecord[]) => Promise<void>;
  private readonly drainTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly ledger: PresentationLedger;
  private readonly protocolVersion: number;
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private activeExchanges = 0;
  private credential = createEpochCredential();
  private idleTimer?: NodeJS.Timeout;
  private resolveClosed!: (reason: BrokerStopReason) => void;
  private running = false;
  private stopPromise?: Promise<void>;

  readonly closed: Promise<BrokerStopReason>;
  readonly presentationEpoch = createPresentationEpoch();

  constructor(private readonly options: PresentationBrokerServerOptions) {
    this.cleanupEpochItems = options.cleanupEpochItems ?? (async () => undefined);
    this.drainTimeoutMs = options.drainTimeoutMs ?? PRESENTATION_BROKER_DRAIN_TIMEOUT_MS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? PRESENTATION_BROKER_IDLE_TIMEOUT_MS;
    this.protocolVersion = options.protocolVersion ?? PRESENTATION_BROKER_PROTOCOL_VERSION;
    this.ledger = new PresentationLedger(this.presentationEpoch);
    this.server = createServer((socket) => this.accept(socket));
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  get isRunning(): boolean {
    return this.running && this.stopPromise === undefined;
  }

  async start(): Promise<BrokerStartOutcome> {
    if (this.running) return 'started';
    const outcome = await listen(this.server, this.options.paths.pipeAddress);
    if (outcome === 'existing') return outcome;
    this.running = true;
    try {
      await writeBrokerDiscovery(this.options.paths.discoveryFile, {
        protocolVersion: this.protocolVersion,
        processId: process.pid,
        presentationEpoch: this.presentationEpoch,
        pipeAddress: this.options.paths.pipeAddress,
        credential: this.credential,
      });
    } catch (error) {
      await closeServer(this.server, this.sockets);
      this.running = false;
      throw error;
    }
    this.scheduleIdleExit();
    return 'started';
  }

  async stop(reason: BrokerStopReason = 'controlled'): Promise<void> {
    if (!this.running) return;
    this.stopPromise ??= this.finishStop(reason);
    await this.stopPromise;
  }

  private accept(socket: Socket): void {
    if (!this.isRunning) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    this.cancelIdleExit();
    socket.setNoDelay(true);
    const channel = new JsonLineChannel(socket);
    let authenticated = false;
    let compatible = false;

    channel.onMessage(async (message) => {
      try {
        if (!authenticated) {
          const hello = parseHello(message);
          if (!credentialsMatch(hello.credential, this.credential)) {
            await channel.send({ kind: 'error', code: 'authentication-failed' });
            socket.end();
            return;
          }
          authenticated = true;
          compatible = hello.protocolVersion === this.protocolVersion;
          await channel.send({
            kind: 'hello',
            status: compatible ? 'ready' : 'incompatible',
            protocolVersion: this.protocolVersion,
            presentationEpoch: this.presentationEpoch,
          });
          return;
        }
        const request = expectWireObject(message);
        if (request.kind === 'stop') {
          const requestId = expectRequestId(request.requestId);
          const reason = compatible ? 'controlled' : 'incompatible-replacement';
          void this.stopWithResponse(channel, requestId, reason);
          return;
        }
        if (!compatible) {
          await channel.send({ kind: 'error', code: 'incompatible-protocol' });
          return;
        }
        if (request.kind !== 'exchange') throw new Error('Unsupported broker request');
        const requestId = expectRequestId(request.requestId);
        const exchange = parsePresentationExchange(request.exchange);
        this.activeExchanges += 1;
        try {
          const receipt = await this.ledger.exchange(exchange);
          await channel.send({ kind: 'exchange-receipt', requestId, receipt });
        } finally {
          this.activeExchanges -= 1;
        }
      } catch {
        await channel.send({ kind: 'error', code: 'invalid-request' }).catch(() => undefined);
        socket.end();
      }
    });
    channel.onFailure(() => socket.destroy());
    socket.once('close', () => {
      channel.dispose();
      this.sockets.delete(socket);
      this.scheduleIdleExit();
    });
  }

  private async stopWithResponse(
    channel: JsonLineChannel,
    requestId: string,
    reason: BrokerStopReason,
  ): Promise<void> {
    if (this.stopPromise !== undefined) return;
    this.stopPromise = this.finishStop(reason, async () => {
      await channel.send({
        kind: 'stopped',
        requestId,
        presentationEpoch: this.presentationEpoch,
        epochReset: true,
      });
    });
    await this.stopPromise;
  }

  private async finishStop(
    reason: BrokerStopReason,
    beforeDisconnect?: () => Promise<void>,
  ): Promise<void> {
    this.cancelIdleExit();
    const deadline = Date.now() + this.drainTimeoutMs;
    this.server.close();
    await waitFor(() => this.activeExchanges === 0, deadline);
    const records = this.ledger.currentRecords();
    await runUntil(() => this.cleanupEpochItems(records), deadline);
    if (beforeDisconnect !== undefined) await runUntil(beforeDisconnect, deadline);
    await removeOwnedBrokerDiscovery(this.options.paths.discoveryFile, this.presentationEpoch);
    for (const socket of this.sockets) socket.end();
    await closeServer(this.server, this.sockets);
    this.running = false;
    this.credential = '';
    this.resolveClosed(reason);
  }

  private scheduleIdleExit(): void {
    if (!this.isRunning || this.sockets.size > 0 || !this.ledger.isEmpty()) return;
    this.cancelIdleExit();
    this.idleTimer = setTimeout(() => void this.stop('idle'), this.idleTimeoutMs);
    this.idleTimer.unref();
  }

  private cancelIdleExit(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }
}

class JsonLineChannel {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private readonly failureListeners = new Set<(error: Error) => void>();
  private readonly messageListeners = new Set<(message: unknown) => void>();
  private buffer = '';

  constructor(private readonly socket: Socket) {
    socket.on('data', this.handleData);
    socket.on('error', this.handleFailure);
  }

  dispose(): void {
    this.socket.off('data', this.handleData);
    this.socket.off('error', this.handleFailure);
    this.failureListeners.clear();
    this.messageListeners.clear();
  }

  onFailure(listener: (error: Error) => void): void {
    this.failureListeners.add(listener);
  }

  onMessage(listener: (message: unknown) => void): void {
    this.messageListeners.add(listener);
  }

  async send(message: unknown): Promise<void> {
    const payload = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(payload, 'utf8') > MAXIMUM_WIRE_MESSAGE_BYTES) {
      throw new Error('Broker message exceeds the wire limit');
    }
    await new Promise<void>((resolve, reject) => {
      this.socket.write(payload, 'utf8', (error) => (error ? reject(error) : resolve()));
    });
  }

  private readonly handleData = (chunk: Buffer): void => {
    try {
      this.buffer += this.decoder.decode(chunk, { stream: true });
      if (Buffer.byteLength(this.buffer, 'utf8') > MAXIMUM_WIRE_MESSAGE_BYTES) {
        throw new Error('Broker message exceeds the wire limit');
      }
      let newline = this.buffer.indexOf('\n');
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (line.length > 0) {
          const message: unknown = JSON.parse(line);
          for (const listener of this.messageListeners) listener(message);
        }
        newline = this.buffer.indexOf('\n');
      }
    } catch (error) {
      this.handleFailure(error instanceof Error ? error : new Error(String(error)));
    }
  };

  private readonly handleFailure = (error: Error): void => {
    for (const listener of this.failureListeners) listener(error);
  };
}

function parseHello(value: unknown): { credential: string; protocolVersion: number } {
  const input = expectWireObject(value);
  if (
    input.kind !== 'hello' ||
    Object.keys(input).some((key) => !['kind', 'protocolVersion', 'credential'].includes(key)) ||
    !Number.isSafeInteger(input.protocolVersion) ||
    (input.protocolVersion as number) < 0 ||
    typeof input.credential !== 'string'
  ) {
    throw new Error('Invalid broker hello');
  }
  return { credential: input.credential, protocolVersion: input.protocolVersion as number };
}

function expectWireObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Broker request must be an object');
  }
  return value as Record<string, unknown>;
}

function expectRequestId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{32}$/.test(value)) {
    throw new Error('Invalid broker request id');
  }
  return value;
}

function credentialsMatch(candidate: string, expected: string): boolean {
  const candidateBytes = Buffer.from(candidate, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return (
    candidateBytes.length === expectedBytes.length && timingSafeEqual(candidateBytes, expectedBytes)
  );
}

async function listen(server: Server, pipeAddress: string): Promise<BrokerStartOutcome> {
  return await new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off('listening', onListening);
      if (error.code === 'EADDRINUSE') resolve('existing');
      else reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve('started');
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(pipeAddress);
  });
}

async function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function waitFor(predicate: () => boolean, deadline: number): Promise<void> {
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function runUntil(operation: () => Promise<void>, deadline: number): Promise<void> {
  const remaining = Math.max(0, deadline - Date.now());
  await Promise.race([
    operation().catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, remaining)),
  ]);
}
