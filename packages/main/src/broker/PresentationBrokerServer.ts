import { timingSafeEqual } from 'node:crypto';
import { createServer, Server, Socket } from 'node:net';

import { PresentationRecord } from 'remote-notifier-shared/attentionExchange';

import {
  BrokerRuntimePaths,
  createEpochCredential,
  createPresentationEpoch,
  PRESENTATION_BROKER_DRAIN_TIMEOUT_MS,
  PRESENTATION_BROKER_HANDSHAKE_TIMEOUT_MS,
  PRESENTATION_BROKER_IDLE_TIMEOUT_MS,
  PRESENTATION_BROKER_PROTOCOL_VERSION,
  removeOwnedBrokerDiscovery,
  writeBrokerDiscovery,
} from './BrokerProtocol';
import { BrokerClientMessage, BrokerJsonChannel, parseBrokerClientMessage } from './BrokerWire';
import { PresentationLedger } from './PresentationLedger';

export interface PresentationBrokerServerOptions {
  paths: BrokerRuntimePaths;
  cleanupEpochItems?: (records: PresentationRecord[]) => Promise<void>;
  drainTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  idleTimeoutMs?: number;
  protocolVersion?: number;
}

export type BrokerStartOutcome = 'existing' | 'started';
export type BrokerStopReason = 'controlled' | 'idle' | 'incompatible-replacement' | 'test-cleanup';

export class PresentationBrokerServer {
  private readonly cleanupEpochItems: (records: PresentationRecord[]) => Promise<void>;
  private readonly drainTimeoutMs: number;
  private readonly handshakeTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly ledger: PresentationLedger;
  private readonly protocolVersion: number;
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private readonly authenticatedSockets = new Set<Socket>();
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
    this.handshakeTimeoutMs =
      options.handshakeTimeoutMs ?? PRESENTATION_BROKER_HANDSHAKE_TIMEOUT_MS;
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
    socket.setNoDelay(true);
    const channel = new BrokerJsonChannel(socket, parseBrokerClientMessage);
    let authenticated = false;
    let compatible = false;
    const handshakeTimer = setTimeout(() => socket.destroy(), this.handshakeTimeoutMs);
    handshakeTimer.unref();

    channel.onMessage(async (message) => {
      try {
        if (!authenticated) {
          if (message.kind !== 'hello') throw new Error('Expected broker hello');
          if (!credentialsMatch(message.credential, this.credential)) {
            await channel.send({ kind: 'error', code: 'authentication-failed' });
            socket.end();
            return;
          }
          authenticated = true;
          clearTimeout(handshakeTimer);
          this.authenticatedSockets.add(socket);
          this.cancelIdleExit();
          compatible = message.protocolVersion === this.protocolVersion;
          await channel.send({
            kind: 'hello',
            status: compatible ? 'ready' : 'incompatible',
            protocolVersion: this.protocolVersion,
            presentationEpoch: this.presentationEpoch,
          });
          return;
        }
        if (message.kind === 'stop') {
          const reason = compatible ? 'controlled' : 'incompatible-replacement';
          void this.stopWithResponse(channel, message.requestId, reason);
          return;
        }
        if (!compatible) {
          await channel.send({ kind: 'error', code: 'incompatible-protocol' });
          return;
        }
        if (message.kind !== 'exchange') throw new Error('Unsupported broker request');
        if (this.stopPromise !== undefined) {
          await channel.send({
            kind: 'exchange-receipt',
            requestId: message.requestId,
            receipt: {
              kind: 'rejected',
              transactionId: message.exchange.transactionId,
              reason: 'unavailable',
            },
          });
          return;
        }
        this.activeExchanges += 1;
        try {
          const receipt = await this.ledger.exchange(message.exchange);
          await channel.send({
            kind: 'exchange-receipt',
            requestId: message.requestId,
            receipt,
          });
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
      clearTimeout(handshakeTimer);
      channel.dispose();
      this.sockets.delete(socket);
      this.authenticatedSockets.delete(socket);
      this.scheduleIdleExit();
    });
  }

  private async stopWithResponse(
    channel: BrokerJsonChannel<BrokerClientMessage>,
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
    if (beforeDisconnect !== undefined) await beforeDisconnect().catch(() => undefined);
    await removeOwnedBrokerDiscovery(this.options.paths.discoveryFile, this.presentationEpoch);
    for (const socket of this.sockets) socket.end();
    await closeServer(this.server, this.sockets);
    this.running = false;
    this.credential = '';
    this.resolveClosed(reason);
  }

  private scheduleIdleExit(): void {
    if (!this.isRunning || this.authenticatedSockets.size > 0 || !this.ledger.isEmpty()) return;
    this.cancelIdleExit();
    this.idleTimer = setTimeout(() => void this.stop('idle'), this.idleTimeoutMs);
    this.idleTimer.unref();
  }

  private cancelIdleExit(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }
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
