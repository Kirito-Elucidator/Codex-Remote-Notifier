import { spawn, SpawnOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { Socket } from 'node:net';

import {
  assertMatchingPresentationReceipt,
  AttentionPresentationPort,
  parsePresentationExchange,
  parsePresentationReceipt,
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

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_DISCOVERY_POLL_MS = 25;
const MAXIMUM_WIRE_MESSAGE_BYTES = 70 * 1024;

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
  onStatus?: (event: BrokerStatusEvent) => void;
  protocolVersion?: number;
}

export interface DetachedBrokerLaunchOptions {
  executable?: string;
  paths: BrokerRuntimePaths;
  protocolVersion?: number;
  scriptPath: string;
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
        await rm(this.options.paths.discoveryFile, { force: true });
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
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

class BrokerClientConnection {
  private readonly channel: ClientJsonLineChannel;

  private constructor(
    private readonly socket: Socket,
    readonly compatible: boolean,
    readonly presentationEpoch: string,
  ) {
    this.channel = new ClientJsonLineChannel(socket);
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
  ): Promise<BrokerClientConnection> {
    const socket = await connectSocket(discovery.pipeAddress, timeoutMs);
    const channel = new ClientJsonLineChannel(socket);
    try {
      await channel.send({
        kind: 'hello',
        protocolVersion,
        credential: discovery.credential,
      });
      const response = expectWireObject(
        await channel.waitFor((message) => {
          const input = asWireObject(message);
          return input?.kind === 'hello' || input?.kind === 'error';
        }, timeoutMs),
      );
      if (response.kind === 'error' && response.code === 'authentication-failed') {
        throw new BrokerConnectionError(
          'authentication-failed',
          'Broker rejected the epoch credential',
        );
      }
      if (
        response.kind !== 'hello' ||
        (response.status !== 'ready' && response.status !== 'incompatible') ||
        typeof response.presentationEpoch !== 'string' ||
        response.presentationEpoch !== discovery.presentationEpoch
      ) {
        throw new BrokerConnectionError('unavailable', 'Broker returned an invalid handshake');
      }
      channel.detach();
      return new BrokerClientConnection(
        socket,
        response.status === 'ready',
        response.presentationEpoch,
      );
    } catch (error) {
      channel.close();
      throw error;
    }
  }

  async exchange(exchange: PresentationExchange): Promise<PresentationReceipt> {
    const requestId = randomBytes(16).toString('hex');
    await this.channel.send({ kind: 'exchange', requestId, exchange });
    const response = expectWireObject(
      await this.channel.waitFor(
        (message) => asWireObject(message)?.requestId === requestId,
        DEFAULT_CONNECT_TIMEOUT_MS,
      ),
    );
    if (response.kind !== 'exchange-receipt') throw new Error('Invalid broker exchange response');
    const receipt = parsePresentationReceipt(response.receipt);
    assertMatchingPresentationReceipt(exchange, receipt);
    return receipt;
  }

  async stop(timeoutMs: number): Promise<void> {
    const requestId = randomBytes(16).toString('hex');
    await this.channel.send({ kind: 'stop', requestId });
    const response = expectWireObject(
      await this.channel.waitFor(
        (message) => asWireObject(message)?.requestId === requestId,
        timeoutMs,
      ),
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
}

class ClientJsonLineChannel {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private readonly waiters = new Set<{
    match: (message: unknown) => boolean;
    reject: (error: Error) => void;
    resolve: (message: unknown) => void;
    timer: NodeJS.Timeout;
  }>();
  private buffer = '';
  private resolveClosed!: () => void;
  readonly whenClosed: Promise<void>;

  constructor(private readonly socket: Socket) {
    this.whenClosed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    socket.on('data', this.handleData);
    socket.on('error', this.handleFailure);
    socket.once('close', this.handleClose);
  }

  detach(): void {
    this.socket.off('data', this.handleData);
    this.socket.off('error', this.handleFailure);
    this.socket.off('close', this.handleClose);
  }

  close(): void {
    this.socket.destroy();
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

  async waitFor(match: (message: unknown) => boolean, timeoutMs: number): Promise<unknown> {
    return await new Promise((resolve, reject) => {
      const waiter = {
        match,
        reject,
        resolve,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error('Timed out waiting for the broker response'));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  private readonly handleData = (chunk: Buffer): void => {
    try {
      this.buffer += this.decoder.decode(chunk, { stream: true });
      let newline = this.buffer.indexOf('\n');
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (Buffer.byteLength(line, 'utf8') > MAXIMUM_WIRE_MESSAGE_BYTES) {
          throw new Error('Broker message exceeds the wire limit');
        }
        if (line.length > 0) this.dispatch(JSON.parse(line));
        newline = this.buffer.indexOf('\n');
      }
      if (Buffer.byteLength(this.buffer, 'utf8') > MAXIMUM_WIRE_MESSAGE_BYTES) {
        throw new Error('Broker message exceeds the wire limit');
      }
    } catch (error) {
      this.handleFailure(error instanceof Error ? error : new Error(String(error)));
    }
  };

  private readonly handleFailure = (error: Error): void => {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  };

  private readonly handleClose = (): void => {
    this.handleFailure(new Error('Broker connection closed'));
    this.resolveClosed();
  };

  private dispatch(message: unknown): void {
    const waiter = [...this.waiters].find(({ match }) => match(message));
    if (waiter === undefined) return;
    clearTimeout(waiter.timer);
    this.waiters.delete(waiter);
    waiter.resolve(message);
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

function asWireObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function expectWireObject(value: unknown): Record<string, unknown> {
  const result = asWireObject(value);
  if (result === undefined) throw new Error('Invalid broker response');
  return result;
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
