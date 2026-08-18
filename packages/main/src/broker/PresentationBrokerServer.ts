import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, Server, Socket } from 'node:net';

import {
  PresentationExchange,
  PresentationReceipt,
  PresentationRecord,
} from 'remote-notifier-shared/attentionExchange';

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
import {
  NativePresentationExchange,
  NativePresentationMutation,
} from './NativeWindowsAttentionAdapter';
import { PresentationActivationRegistry } from './PresentationActivationRegistry';
import { PresentationLedger } from './PresentationLedger';

const DEFAULT_NAVIGATION_TIMEOUT_MS = 1_500;

export interface NativePresentationAdapterPort {
  exchange(input: NativePresentationExchange): Promise<void>;
  cleanup(): Promise<void>;
}

export interface PresentationBrokerServerOptions {
  paths: BrokerRuntimePaths;
  cleanupEpochItems?: (records: PresentationRecord[]) => Promise<void>;
  drainTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  idleTimeoutMs?: number;
  navigationTimeoutMs?: number;
  presentationAdapter?: NativePresentationAdapterPort;
  presentationAdapterFactory?: (presentationEpoch: string) => NativePresentationAdapterPort;
  protocolVersion?: number;
}

export type BrokerStartOutcome = 'existing' | 'started';
export type BrokerStopReason = 'controlled' | 'idle' | 'incompatible-replacement' | 'test-cleanup';

export class PresentationBrokerServer {
  private readonly cleanupEpochItems: (records: PresentationRecord[]) => Promise<void>;
  private readonly drainTimeoutMs: number;
  private readonly handshakeTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly navigationTimeoutMs: number;
  private readonly ledger: PresentationLedger;
  private readonly activations: PresentationActivationRegistry;
  private readonly presentationAdapter: NativePresentationAdapterPort;
  private readonly protocolVersion: number;
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private readonly authenticatedSockets = new Set<Socket>();
  private readonly compatibleClients = new Map<Socket, BrokerJsonChannel<BrokerClientMessage>>();
  private readonly focusAttempts = new Map<
    string,
    {
      pending: Set<Socket>;
      resolve: (focused: boolean) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private activeExchanges = 0;
  private credential = createEpochCredential();
  private idleTimer?: NodeJS.Timeout;
  private resolveClosed!: (reason: BrokerStopReason) => void;
  private running = false;
  private stopPromise?: Promise<void>;
  private exchangeTail: Promise<void> = Promise.resolve();

  readonly closed: Promise<BrokerStopReason>;
  readonly presentationEpoch = createPresentationEpoch();

  constructor(private readonly options: PresentationBrokerServerOptions) {
    this.cleanupEpochItems = options.cleanupEpochItems ?? (async () => undefined);
    this.drainTimeoutMs = options.drainTimeoutMs ?? PRESENTATION_BROKER_DRAIN_TIMEOUT_MS;
    this.handshakeTimeoutMs =
      options.handshakeTimeoutMs ?? PRESENTATION_BROKER_HANDSHAKE_TIMEOUT_MS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? PRESENTATION_BROKER_IDLE_TIMEOUT_MS;
    this.navigationTimeoutMs = options.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS;
    this.protocolVersion = options.protocolVersion ?? PRESENTATION_BROKER_PROTOCOL_VERSION;
    this.ledger = new PresentationLedger(this.presentationEpoch);
    this.activations = new PresentationActivationRegistry(this.presentationEpoch);
    this.presentationAdapter = options.presentationAdapter ??
      options.presentationAdapterFactory?.(this.presentationEpoch) ?? {
        cleanup: async () => undefined,
        exchange: async () => undefined,
      };
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
          if (compatible) this.compatibleClients.set(socket, channel);
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
        if (message.kind === 'focus-result') {
          this.acceptFocusResult(socket, message.requestId, message.focused);
          return;
        }
        if (message.kind === 'redeem-activation') {
          this.activeExchanges += 1;
          let status: 'focused' | 'failed';
          try {
            status =
              this.stopPromise === undefined
                ? await this.redeemActivation(message.presentationEpoch, message.activationId)
                : 'failed';
          } finally {
            this.activeExchanges -= 1;
          }
          await channel.send({
            kind: 'activation-result',
            requestId: message.requestId,
            status,
          });
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
          const receipt = await this.serializedExchange(message.exchange);
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
      this.compatibleClients.delete(socket);
      this.removeFocusClient(socket);
      this.scheduleIdleExit();
    });
  }

  private async serializedExchange(exchange: PresentationExchange): Promise<PresentationReceipt> {
    const result = this.exchangeTail.then(() => this.applyExchange(exchange));
    this.exchangeTail = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }

  private async applyExchange(exchange: PresentationExchange): Promise<PresentationReceipt> {
    const before = this.ledger.currentRecords();
    const receipt = await this.ledger.exchange(exchange);
    if (receipt.kind !== 'applied') return receipt;

    const after = this.ledger.currentRecords();
    this.activations.reconcile(after);
    const mutations = this.nativeMutations(before, after);
    if (mutations.length > 0) {
      await this.presentationAdapter
        .exchange({ kind: 'apply', transactionId: exchange.transactionId, mutations })
        .catch(() => undefined);
    }
    return receipt;
  }

  private nativeMutations(
    before: PresentationRecord[],
    after: PresentationRecord[],
  ): NativePresentationMutation[] {
    const previous = new Map(before.map((record) => [record.key, record]));
    const current = new Map(after.map((record) => [record.key, record]));
    const mutations: NativePresentationMutation[] = [];
    for (const key of previous.keys()) {
      if (!current.has(key)) mutations.push({ kind: 'withdraw', key });
    }
    for (const record of after) {
      const prior = previous.get(record.key);
      if (prior !== undefined && recordsMatch(prior, record)) continue;
      mutations.push({
        kind: prior === undefined ? 'create' : 'update',
        record: this.activations.nativeRecord(record),
      });
    }
    return mutations;
  }

  private async redeemActivation(
    presentationEpoch: string,
    activationId: string,
  ): Promise<'focused' | 'failed'> {
    const acknowledged = this.exchangeTail.then(() =>
      this.acknowledgeActivation(presentationEpoch, activationId),
    );
    this.exchangeTail = acknowledged.then(
      () => undefined,
      () => undefined,
    );
    const returnTarget = await acknowledged;
    if (returnTarget === undefined) return 'failed';
    return (await this.broadcastReturnTarget(returnTarget)) ? 'focused' : 'failed';
  }

  private async acknowledgeActivation(
    presentationEpoch: string,
    activationId: string,
  ): Promise<string | undefined> {
    const activation = this.activations.redeem(presentationEpoch, activationId);
    if (activation === undefined) return undefined;
    if (!this.ledger.acknowledge(activation.key, activation.revision)) return undefined;

    this.activations.reconcile(this.ledger.currentRecords());
    await this.presentationAdapter
      .exchange({
        kind: 'apply',
        transactionId: `activation-${activationId}`,
        mutations: [{ kind: 'withdraw', key: activation.key }],
      })
      .catch(() => undefined);
    return activation.returnTarget;
  }

  private async broadcastReturnTarget(returnTarget: string): Promise<boolean> {
    const clients = [...this.compatibleClients.entries()];
    if (clients.length === 0) return false;
    const requestId = randomBytes(16).toString('hex');
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(
        () => this.finishFocusAttempt(requestId, false),
        this.navigationTimeoutMs,
      );
      timer.unref();
      this.focusAttempts.set(requestId, {
        pending: new Set(clients.map(([socket]) => socket)),
        resolve,
        timer,
      });
      for (const [socket, channel] of clients) {
        void channel
          .send({ kind: 'focus-offer', requestId, returnTarget })
          .catch(() => this.acceptFocusResult(socket, requestId, false));
      }
    });
  }

  private acceptFocusResult(socket: Socket, requestId: string, focused: boolean): void {
    const attempt = this.focusAttempts.get(requestId);
    if (attempt === undefined || !attempt.pending.delete(socket)) return;
    if (focused) {
      this.finishFocusAttempt(requestId, true);
      return;
    }
    if (attempt.pending.size === 0) this.finishFocusAttempt(requestId, false);
  }

  private removeFocusClient(socket: Socket): void {
    for (const [requestId, attempt] of this.focusAttempts) {
      if (!attempt.pending.delete(socket)) continue;
      if (attempt.pending.size === 0) this.finishFocusAttempt(requestId, false);
    }
  }

  private finishFocusAttempt(requestId: string, focused: boolean): void {
    const attempt = this.focusAttempts.get(requestId);
    if (attempt === undefined) return;
    clearTimeout(attempt.timer);
    this.focusAttempts.delete(requestId);
    attempt.resolve(focused);
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
    await runUntil(() => this.presentationAdapter.cleanup(), deadline);
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

function recordsMatch(left: PresentationRecord, right: PresentationRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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
