import { spawn, SpawnOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Socket } from 'node:net';

import {
  assertMatchingPresentationReceipt,
  AttentionPresentationPort,
  parsePresentationExchange,
  PresentationExchange,
  PresentationReceipt,
} from 'remote-notifier-shared';

import {
  BrokerConnectionError,
  BrokerRuntimePaths,
  PRESENTATION_BROKER_PROTOCOL_VERSION,
  PresentationBrokerDiscovery,
  readBrokerDiscovery,
  removeOwnedBrokerDiscovery,
} from './broker/BrokerProtocol';
import {
  BrokerClientMessage,
  BrokerJsonChannel,
  BrokerServerMessage,
  parseBrokerServerMessage,
} from './broker/BrokerWire';

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_DISCOVERY_POLL_MS = 25;

export interface BrokerConnectionInfo {
  epochReset: boolean;
  presentationEpoch: string;
}

export interface BrokerStatusEvent {
  code: 'incompatible-epoch-reset' | 'stale-discovery';
  previousEpoch?: string;
}

export interface PresentationBrokerClientOptions {
  paths: BrokerRuntimePaths;
  connectTimeoutMs?: number;
  discoveryPollMs?: number;
  launch: () => Promise<void>;
  claimReturnTarget?: (returnTarget: string) => Promise<boolean>;
  onStatus?: (event: BrokerStatusEvent) => void;
  protocolVersion?: number;
}

export interface DetachedBrokerLaunchOptions {
  executable?: string;
  paths: BrokerRuntimePaths;
  protocolVersion?: number;
  scriptPath: string;
  sound?: boolean;
  spawnProcess?: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => { unref(): void };
}

export class PresentationBrokerClient implements AttentionPresentationPort {
  private readonly connectTimeoutMs: number;
  private readonly discoveryPollMs: number;
  private readonly protocolVersion: number;
  private connection?: BrokerClientConnection;
  private connectionInfo?: BrokerConnectionInfo;
  private connecting?: Promise<BrokerConnectionInfo>;
  private disposed = false;

  constructor(private readonly options: PresentationBrokerClientOptions) {
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.discoveryPollMs = options.discoveryPollMs ?? DEFAULT_DISCOVERY_POLL_MS;
    this.protocolVersion = options.protocolVersion ?? PRESENTATION_BROKER_PROTOCOL_VERSION;
  }

  async start(): Promise<BrokerConnectionInfo> {
    if (this.disposed) throw new BrokerConnectionError('unavailable', 'Broker client is disposed');
    if (this.connection?.isOpen && this.connectionInfo !== undefined) return this.connectionInfo;
    this.connecting ??= this.connectOrLaunch().finally(() => {
      this.connecting = undefined;
    });
    return await this.connecting;
  }

  async exchange(input: PresentationExchange): Promise<PresentationReceipt> {
    const exchange = parsePresentationExchange(input);
    await this.start();
    const connection = this.connection;
    if (connection === undefined) {
      throw new BrokerConnectionError('unavailable', 'Broker connection is unavailable');
    }
    try {
      return await connection.exchange(exchange);
    } catch (error) {
      this.clearConnection(connection);
      throw new BrokerConnectionError(
        'unavailable',
        error instanceof Error ? error.message : 'Broker exchange failed',
      );
    }
  }

  async redeemActivation(
    presentationEpoch: string,
    activationId: string,
  ): Promise<'focused' | 'failed'> {
    try {
      await this.start();
      const connection = this.connection;
      if (connection === undefined) return 'failed';
      return await connection.redeemActivation(presentationEpoch, activationId);
    } catch {
      if (this.connection !== undefined) this.clearConnection(this.connection);
      return 'failed';
    }
  }

  dispose(): void {
    this.disposed = true;
    this.connection?.close();
    this.connection = undefined;
    this.connectionInfo = undefined;
  }

  private async connectOrLaunch(): Promise<BrokerConnectionInfo> {
    let epochReset = false;
    let discovery = await this.readDiscoveryForConnection();
    if (discovery !== undefined) {
      const existingDiscovery = discovery;
      try {
        const connection = await BrokerClientConnection.connect(
          existingDiscovery,
          this.protocolVersion,
          this.connectTimeoutMs,
          this.options.claimReturnTarget,
        );
        if (connection.compatible) {
          return this.adopt(connection, epochReset);
        }
        const previousEpoch = existingDiscovery.presentationEpoch;
        await connection.stop(this.connectTimeoutMs);
        epochReset = true;
        this.options.onStatus?.({ code: 'incompatible-epoch-reset', previousEpoch });
        discovery = undefined;
      } catch (error) {
        if (error instanceof BrokerConnectionError && error.code === 'authentication-failed') {
          throw error;
        }
        epochReset = true;
        this.options.onStatus?.({
          code: 'stale-discovery',
          previousEpoch: existingDiscovery.presentationEpoch,
        });
        await removeOwnedBrokerDiscovery(
          this.options.paths.discoveryFile,
          existingDiscovery.presentationEpoch,
        );
        discovery = undefined;
      }
    }

    if (discovery === undefined) await this.options.launch();
    const deadline = Date.now() + this.connectTimeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      const candidate = await this.readDiscoveryForConnection().catch((error) => {
        lastError = error;
        return undefined;
      });
      if (candidate !== undefined) {
        try {
          const connection = await BrokerClientConnection.connect(
            candidate,
            this.protocolVersion,
            Math.max(1, deadline - Date.now()),
            this.options.claimReturnTarget,
          );
          if (!connection.compatible) {
            connection.close();
            throw new BrokerConnectionError(
              'incompatible-protocol',
              'Replacement broker protocol is incompatible',
            );
          }
          return this.adopt(connection, epochReset);
        } catch (error) {
          lastError = error;
          if (
            error instanceof BrokerConnectionError &&
            (error.code === 'authentication-failed' || error.code === 'incompatible-protocol')
          ) {
            throw error;
          }
        }
      }
      await delay(this.discoveryPollMs);
    }
    throw new BrokerConnectionError(
      'unavailable',
      lastError instanceof Error ? lastError.message : 'Timed out waiting for the broker',
    );
  }

  private adopt(connection: BrokerClientConnection, epochReset: boolean): BrokerConnectionInfo {
    this.connection?.close();
    this.connection = connection;
    this.connectionInfo = {
      epochReset,
      presentationEpoch: connection.presentationEpoch,
    };
    connection.whenClosed.then(() => this.clearConnection(connection)).catch(() => undefined);
    return this.connectionInfo;
  }

  private clearConnection(connection: BrokerClientConnection): void {
    if (this.connection !== connection) return;
    connection.close();
    this.connection = undefined;
    this.connectionInfo = undefined;
  }

  private async readDiscoveryForConnection(): Promise<PresentationBrokerDiscovery | undefined> {
    try {
      const discovery = await readBrokerDiscovery(this.options.paths.discoveryFile);
      if (discovery !== undefined && discovery.pipeAddress !== this.options.paths.pipeAddress) {
        throw new BrokerConnectionError(
          'invalid-discovery',
          'Broker discovery names an unexpected pipe',
        );
      }
      return discovery;
    } catch (error) {
      if (error instanceof BrokerConnectionError && error.code === 'invalid-discovery') {
        this.options.onStatus?.({ code: 'stale-discovery' });
        return undefined;
      }
      throw error;
    }
  }
}

export function launchDetachedPresentationBroker(options: DetachedBrokerLaunchOptions): void {
  const spawnProcess = options.spawnProcess ?? spawn;
  const child = spawnProcess(options.executable ?? process.execPath, [options.scriptPath], {
    detached: true,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      REMOTE_NOTIFIER_BROKER_DISCOVERY_FILE: options.paths.discoveryFile,
      REMOTE_NOTIFIER_BROKER_PIPE_ADDRESS: options.paths.pipeAddress,
      REMOTE_NOTIFIER_BROKER_PROTOCOL_VERSION: String(
        options.protocolVersion ?? PRESENTATION_BROKER_PROTOCOL_VERSION,
      ),
      REMOTE_NOTIFIER_BROKER_SOUND: options.sound === false ? '0' : '1',
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

class BrokerClientConnection {
  private constructor(
    private readonly socket: Socket,
    private readonly channel: BrokerJsonChannel<BrokerServerMessage>,
    readonly compatible: boolean,
    readonly presentationEpoch: string,
    private readonly claimReturnTarget?: (returnTarget: string) => Promise<boolean>,
  ) {
    channel.onMessage((message) => {
      if (message.kind !== 'focus-offer') return;
      void this.answerFocusOffer(message.requestId, message.returnTarget);
    });
  }

  get isOpen(): boolean {
    return !this.socket.destroyed;
  }

  get whenClosed(): Promise<void> {
    return this.channel.whenClosed;
  }

  static async connect(
    discovery: PresentationBrokerDiscovery,
    protocolVersion: number,
    timeoutMs: number,
    claimReturnTarget?: (returnTarget: string) => Promise<boolean>,
  ): Promise<BrokerClientConnection> {
    const socket = await connectSocket(discovery.pipeAddress, timeoutMs);
    const channel = new BrokerJsonChannel(socket, parseBrokerServerMessage);
    const responsePromise = channel.waitFor(
      (message) => message.kind === 'hello' || message.kind === 'error',
      timeoutMs,
    );
    try {
      await channel.send({
        kind: 'hello',
        protocolVersion,
        credential: discovery.credential,
      });
      const response = await responsePromise;
      if (response.kind === 'error' && response.code === 'authentication-failed') {
        throw new BrokerConnectionError(
          'authentication-failed',
          'Broker rejected the epoch credential',
        );
      }
      if (response.kind !== 'hello' || response.presentationEpoch !== discovery.presentationEpoch) {
        throw new BrokerConnectionError('unavailable', 'Broker returned an invalid handshake');
      }
      return new BrokerClientConnection(
        socket,
        channel,
        response.status === 'ready',
        response.presentationEpoch,
        claimReturnTarget,
      );
    } catch (error) {
      channel.close();
      await responsePromise.catch(() => undefined);
      throw error;
    }
  }

  async exchange(exchange: PresentationExchange): Promise<PresentationReceipt> {
    const requestId = randomBytes(16).toString('hex');
    const response = await this.request(
      { kind: 'exchange', requestId, exchange },
      (message) => 'requestId' in message && message.requestId === requestId,
      DEFAULT_CONNECT_TIMEOUT_MS,
    );
    if (response.kind !== 'exchange-receipt') throw new Error('Invalid broker exchange response');
    assertMatchingPresentationReceipt(exchange, response.receipt);
    return response.receipt;
  }

  async redeemActivation(
    presentationEpoch: string,
    activationId: string,
  ): Promise<'focused' | 'failed'> {
    const requestId = randomBytes(16).toString('hex');
    const response = await this.request(
      {
        kind: 'redeem-activation',
        requestId,
        presentationEpoch,
        activationId,
      },
      (message) => 'requestId' in message && message.requestId === requestId,
      DEFAULT_CONNECT_TIMEOUT_MS,
    );
    if (response.kind !== 'activation-result') throw new Error('Invalid activation response');
    return response.status;
  }

  async stop(timeoutMs: number): Promise<void> {
    const requestId = randomBytes(16).toString('hex');
    const response = await this.request(
      { kind: 'stop', requestId },
      (message) => 'requestId' in message && message.requestId === requestId,
      timeoutMs,
    );
    if (
      response.kind !== 'stopped' ||
      response.epochReset !== true ||
      response.presentationEpoch !== this.presentationEpoch
    ) {
      throw new BrokerConnectionError('unavailable', 'Broker did not confirm the epoch reset');
    }
    await withTimeout(this.whenClosed, timeoutMs);
  }

  close(): void {
    this.channel.close();
  }

  private async answerFocusOffer(requestId: string, returnTarget: string): Promise<void> {
    const focused = await Promise.resolve()
      .then(() => this.claimReturnTarget?.(returnTarget) ?? false)
      .catch(() => false);
    await this.channel.send({ kind: 'focus-result', requestId, focused }).catch(() => undefined);
  }

  private async request(
    message: BrokerClientMessage,
    match: (message: BrokerServerMessage) => boolean,
    timeoutMs: number,
  ): Promise<BrokerServerMessage> {
    const responsePromise = this.channel.waitFor(match, timeoutMs);
    try {
      await this.channel.send(message);
      return await responsePromise;
    } catch (error) {
      this.channel.close();
      await responsePromise.catch(() => undefined);
      throw error;
    }
  }
}

function connectSocket(pipeAddress: string, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new BrokerConnectionError('stale-discovery', 'Timed out connecting to the broker'));
    }, timeoutMs);
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(new BrokerConnectionError('stale-discovery', error.message));
    });
    socket.connect(pipeAddress, () => {
      clearTimeout(timer);
      socket.removeAllListeners('error');
      socket.setNoDelay(true);
      resolve(socket);
    });
  });
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withTimeout(operation: Promise<void>, timeoutMs: number): Promise<void> {
  await Promise.race([
    operation,
    new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('Timed out waiting for broker close')), timeoutMs),
    ),
  ]);
}
