import { ChildProcess, spawn, SpawnOptions } from 'child_process';
import { randomBytes, timingSafeEqual } from 'crypto';
import * as fs from 'fs/promises';
import * as http from 'http';
import * as path from 'path';

import WebSocket, { WebSocketServer } from 'ws';

import type {
  CodexProtocolEvent,
  ObservationExchange,
  ObservationExchangeReceipt,
  SanitizedAttentionObservation,
  SourceScope,
} from 'remote-notifier-shared';
import { parseObservationExchangeReceipt } from 'remote-notifier-shared/attentionExchange';
import { ENV_CODEX_PROTOCOL_SESSION } from 'remote-notifier-shared/constants';

import { CodexAttentionProtocolCapture } from '../codex/CodexAttentionProtocolCapture';
import { CodexProtocolCapture, JsonLineFramer } from '../codex/CodexProtocolCapture';
import {
  injectRemoteArguments,
  isCodexProtocolVersion,
  planCodexInvocation,
} from '../codex/CodexShimArguments';

const TOKEN_ENVIRONMENT_VARIABLE = 'REMOTE_NOTIFIER_CODEX_REMOTE_TOKEN';
const ELECTRON_NODE_MARKER = 'REMOTE_NOTIFIER_CODEX_ELECTRON_NODE_SHIM';
const MAX_WEBSOCKET_CLIENTS = 8;
const MAX_PENDING_CLIENT_LINES = 256;
const MAX_BUFFERED_CLIENT_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_SERVER_LINES = 256;
const MAX_OUTBOUND_LINES = 1024;
const MAX_BUFFERED_SERVER_BYTES = 144 * 1024 * 1024;
const MAX_ROUTER_EVENTS = 4096;
const MAX_WEBSOCKET_MESSAGE_BYTES = 128 * 1024 * 1024;
const HTTP_TIMEOUT_MS = 500;
const CLOSE_TIMEOUT_MS = 500;
const LAUNCHER_LOOKUP_TIMEOUT_MS = 1000;
const VERSION_PROBE_TIMEOUT_MS = 1500;
const ANCESTRY_PROBE_TIMEOUT_MS = 750;
const ROUTER_DRAIN_TIMEOUT_MS = 5000;

interface Launcher {
  command: string;
  prefixArgs: string[];
  commandShell?: boolean;
}

interface ExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface BridgeConnection {
  readonly attentionCapture?: CodexAttentionProtocolCapture;
  readonly primary: boolean;
  readonly framer: JsonLineFramer;
  pendingClientLines: string[];
  pendingClientBytes: number;
  pendingServerLines: string[];
  pendingServerBytes: number;
  outboundLines: string[];
  outboundBytes: number;
  sending: boolean;
  closed: boolean;
  webSocket?: WebSocket;
  appServer?: ChildProcess;
}

type AppendObservationExchange = Extract<ObservationExchange, { kind: 'append' }>;

export interface CodexAttentionBridgeOptions {
  invocationId: string;
  router: Pick<CodexAttentionRouterClient, 'post'>;
  version: string;
}

type RouterDeliveryOutcome = 'applied' | 'drop' | 'retry';

abstract class RetainedRouterClient<T> {
  private readonly queue: T[] = [];
  private emptyWaiters: Array<() => void> = [];
  private pumping = false;
  private retryDelayMs = 100;
  private stopped = false;
  private wakeRetry?: () => void;

  constructor(
    private readonly environment: NodeJS.ProcessEnv,
    protected readonly diagnostics: (message: string) => void,
  ) {}

  protected get capacityReached(): boolean {
    return this.queue.length >= MAX_ROUTER_EVENTS;
  }

  protected discardOldest(): void {
    this.queue.shift();
  }

  protected async drainQueue(
    timeoutMs: number,
    undeliveredMessage: (count: number) => string,
  ): Promise<void> {
    if (this.queue.length === 0 && !this.pumping) return;
    this.retryDelayMs = 100;
    this.wakeRetry?.();
    await Promise.race([
      new Promise<void>((resolve) => this.emptyWaiters.push(resolve)),
      delay(timeoutMs),
    ]);
    if (this.queue.length > 0) {
      this.diagnostics(undeliveredMessage(this.queue.length));
    }
  }

  protected enqueue(item: T): boolean {
    if (this.stopped) return false;
    this.queue.push(item);
    void this.pump();
    return true;
  }

  protected rejectionMessage(_item: T): string | undefined {
    return undefined;
  }

  stop(): void {
    this.stopped = true;
    this.wakeRetry?.();
    this.resolveEmptyWaiters();
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.stopped) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0 && !this.stopped) {
        const item = this.queue[0];
        const endpoint = await resolveRouterEndpoint(this.environment);
        const outcome = endpoint ? await this.deliver(item, endpoint) : 'retry';
        if (outcome === 'applied' || outcome === 'drop') {
          if (outcome === 'drop') {
            const message = this.rejectionMessage(item);
            if (message !== undefined) this.diagnostics(message);
          }
          this.queue.shift();
          this.retryDelayMs = 100;
          continue;
        }
        await this.waitBeforeRetry();
        this.retryDelayMs = Math.min(2000, this.retryDelayMs * 2);
      }
    } finally {
      this.pumping = false;
      if (this.queue.length === 0) this.resolveEmptyWaiters();
      else if (!this.stopped) void this.pump();
    }
  }

  protected abstract deliver(
    item: T,
    endpoint: { url: URL; token: string },
  ): Promise<RouterDeliveryOutcome>;

  private resolveEmptyWaiters(): void {
    const waiters = this.emptyWaiters;
    this.emptyWaiters = [];
    for (const resolve of waiters) resolve();
  }

  private waitBeforeRetry(): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        if (this.wakeRetry === finish) this.wakeRetry = undefined;
        resolve();
      };
      const timer = setTimeout(finish, this.retryDelayMs);
      this.wakeRetry = finish;
    });
  }
}

export class CodexRouterClient extends RetainedRouterClient<CodexProtocolEvent> {
  constructor(
    environment: NodeJS.ProcessEnv = process.env,
    diagnostics: (message: string) => void = () => {},
  ) {
    super(environment, diagnostics);
  }

  post(event: CodexProtocolEvent): void {
    if (this.capacityReached) {
      this.discardOldest();
      this.diagnostics('Router event queue reached its safety limit; oldest event was dropped');
    }
    this.enqueue(event);
  }

  drain(timeoutMs: number): Promise<void> {
    return this.drainQueue(
      timeoutMs,
      (count) =>
        `Router did not recover before shutdown; ${count} sanitized event(s) could not be delivered`,
    );
  }

  protected async deliver(
    event: CodexProtocolEvent,
    endpoint: { url: URL; token: string },
  ): Promise<RouterDeliveryOutcome> {
    const outcome = await postJson(endpoint.url, endpoint.token, event);
    return outcome === 'accepted' ? 'applied' : outcome;
  }

  protected rejectionMessage(event: CodexProtocolEvent): string {
    return `Router rejected a sanitized ${event.method} event`;
  }
}

export class CodexAttentionRouterClient extends RetainedRouterClient<AppendObservationExchange> {
  private readonly deliveryGeneration = randomBytes(16).toString('hex');

  constructor(
    environment: NodeJS.ProcessEnv = process.env,
    diagnostics: (message: string) => void = () => {},
  ) {
    super(environment, diagnostics);
  }

  post(scope: SourceScope, observation: SanitizedAttentionObservation): void {
    if (this.capacityReached) {
      this.diagnostics(
        'Router attention queue reached its safety limit; newest observation was discarded',
      );
      return;
    }
    this.enqueue({
      kind: 'append',
      deliveryGeneration: this.deliveryGeneration,
      scope,
      fromSequence: observation.sourceSequence,
      observations: [observation],
    });
  }

  drain(timeoutMs: number): Promise<void> {
    return this.drainQueue(
      timeoutMs,
      (count) => `Router did not apply ${count} attention observation(s) before shutdown`,
    );
  }

  protected async deliver(
    exchange: AppendObservationExchange,
    endpoint: { url: URL; token: string },
  ): Promise<RouterDeliveryOutcome> {
    const outcome = await postAttentionJson(endpoint.url, endpoint.token, exchange);
    if (outcome.kind !== 'receipt') return outcome.kind;
    const through = exchange.observations.at(-1)?.sourceSequence ?? exchange.fromSequence;
    return (outcome.receipt.appliedThrough ?? 0) >= through ? 'applied' : 'retry';
  }

  protected rejectionMessage(exchange: AppendObservationExchange): string {
    return `Router rejected attention observation ${exchange.scope.invocationId}:${exchange.fromSequence}`;
  }
}

export class CodexWebSocketBridge {
  private readonly server = http.createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  private readonly webSockets = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WEBSOCKET_MESSAGE_BYTES,
  });
  private readonly connections = new Set<BridgeConnection>();
  private primaryConnection?: BridgeConnection;
  private createAdditionalAppServer?: () => Promise<ChildProcess>;
  private closing = false;

  constructor(
    private readonly token: string,
    private readonly capture: CodexProtocolCapture,
    private readonly router: CodexRouterClient,
    private readonly attention?: CodexAttentionBridgeOptions,
  ) {
    this.server.on('upgrade', (request, socket, head) => {
      if (!this.authorized(request.headers.authorization)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      if (this.closing || this.webSockets.clients.size >= MAX_WEBSOCKET_CLIENTS) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      this.webSockets.handleUpgrade(request, socket, head, (webSocket) => {
        this.webSockets.emit('connection', webSocket, request);
      });
    });
    this.webSockets.on('connection', (webSocket) => this.onConnection(webSocket));
  }

  async listen(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.server.once('error', onError);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', onError);
        resolve();
      });
    });
    const bound = this.server.address();
    if (!bound || typeof bound === 'string') throw new Error('WebSocket bridge did not bind');
    return `ws://127.0.0.1:${bound.port}`;
  }

  get threadEstablished(): boolean {
    return this.capture.threadEstablished;
  }

  attach(appServer: ChildProcess, createAdditionalAppServer?: () => Promise<ChildProcess>): void {
    if (this.primaryConnection) throw new Error('primary app-server is already attached');
    const connection = this.createConnection(true);
    this.primaryConnection = connection;
    this.createAdditionalAppServer = createAdditionalAppServer;
    this.connections.add(connection);
    this.attachProcess(connection, appServer);
  }

  async close(): Promise<void> {
    this.closing = true;
    const connections = [...this.connections];
    for (const connection of connections) {
      connection.closed = true;
      connection.webSocket?.terminate();
      connection.appServer?.stdin?.end();
    }
    await Promise.all(
      connections
        .filter((connection) => !connection.primary && connection.appServer)
        .map((connection) => stopChild(connection.appServer as ChildProcess)),
    );
    this.connections.clear();
    for (const client of this.webSockets.clients) client.terminate();
    await Promise.race([
      new Promise<void>((resolve) => this.webSockets.close(() => resolve())),
      delay(CLOSE_TIMEOUT_MS),
    ]);
    this.server.closeAllConnections?.();
    await Promise.race([
      new Promise<void>((resolve) => this.server.close(() => resolve())),
      delay(CLOSE_TIMEOUT_MS),
    ]);
  }

  private createConnection(primary: boolean): BridgeConnection {
    const connectionId = randomBytes(16).toString('hex');
    const authorityEpoch = randomBytes(16).toString('hex');
    return {
      primary,
      ...(this.attention === undefined
        ? {}
        : {
            attentionCapture: new CodexAttentionProtocolCapture({
              invocationId: this.attention.invocationId,
              connectionId,
              authorityEpoch,
              version: this.attention.version,
              primary,
            }),
          }),
      framer: new JsonLineFramer(),
      pendingClientLines: [],
      pendingClientBytes: 0,
      pendingServerLines: [],
      pendingServerBytes: 0,
      outboundLines: [],
      outboundBytes: 0,
      sending: false,
      closed: false,
    };
  }

  private attachProcess(connection: BridgeConnection, appServer: ChildProcess): void {
    if (!appServer.stdout || !appServer.stdin) {
      throw new Error('app-server stdio pipes are unavailable');
    }
    connection.appServer = appServer;
    appServer.stdout.on('data', (chunk: Buffer) => {
      try {
        for (const line of connection.framer.push(chunk)) {
          this.onServerLine(connection, line);
        }
      } catch {
        connection.webSocket?.close(1011, 'oversized app-server frame');
        appServer.kill();
      }
    });
    appServer.stdout.on('end', () => {
      try {
        for (const line of connection.framer.end()) {
          this.onServerLine(connection, line);
        }
      } catch {
        connection.webSocket?.close(1011, 'malformed app-server frame');
      }
      this.closeClientForAppServerFailure(connection, 'app-server output closed');
    });
    appServer.stdout.on('error', () =>
      this.closeClientForAppServerFailure(connection, 'app-server output failed'),
    );
    appServer.stdin.on('drain', () => connection.webSocket?.resume());
    appServer.stdin.on('error', () =>
      this.closeClientForAppServerFailure(connection, 'app-server input failed'),
    );
    appServer.once('exit', () =>
      this.closeClientForAppServerFailure(connection, 'app-server exited'),
    );
    appServer.once('error', () =>
      this.closeClientForAppServerFailure(connection, 'app-server failed'),
    );

    const pending = connection.pendingClientLines;
    connection.pendingClientLines = [];
    connection.pendingClientBytes = 0;
    for (const line of pending) this.forwardClientLine(connection, line);
  }

  private onConnection(webSocket: WebSocket): void {
    const primary = this.primaryConnection;
    const connection =
      primary && !primary.webSocket && !primary.closed
        ? primary
        : this.createAdditionalConnection();
    connection.webSocket = webSocket;

    webSocket.on('message', (data, isBinary) => {
      if (isBinary) {
        webSocket.close(1003, 'text JSON-RPC frames required');
        return;
      }
      const text = data.toString();
      this.postAttention(connection, connection.attentionCapture?.observeClientText(text) ?? []);
      for (const event of this.capture.observeClientText(text)) this.router.post(event);
      this.forwardClientLine(connection, text);
    });
    webSocket.on('close', () => {
      if (connection.webSocket === webSocket) connection.webSocket = undefined;
      connection.closed = true;
      this.connections.delete(connection);
      connection.appServer?.stdin?.end();
      if (!this.closing && !connection.primary && connection.appServer) {
        void stopChild(connection.appServer);
      }
    });
    webSocket.on('error', () => {});

    const pending = connection.pendingServerLines;
    connection.pendingServerLines = [];
    connection.pendingServerBytes = 0;
    for (const line of pending) this.enqueueOutbound(connection, line);
  }

  private createAdditionalConnection(): BridgeConnection {
    const connection = this.createConnection(false);
    this.connections.add(connection);
    const factory = this.createAdditionalAppServer;
    if (!factory) {
      queueMicrotask(() =>
        connection.webSocket?.close(1011, 'additional app-server is unavailable'),
      );
      return connection;
    }
    void factory()
      .then(async (appServer) => {
        if (this.closing || connection.closed) {
          await stopChild(appServer);
          return;
        }
        try {
          this.attachProcess(connection, appServer);
        } catch {
          await stopChild(appServer);
          connection.webSocket?.close(1011, 'additional app-server failed');
        }
      })
      .catch(() => connection.webSocket?.close(1011, 'additional app-server failed'));
    return connection;
  }

  private forwardClientLine(connection: BridgeConnection, line: string): void {
    if (!connection.appServer?.stdin) {
      const bytes = Buffer.byteLength(line);
      if (
        connection.pendingClientLines.length >= MAX_PENDING_CLIENT_LINES ||
        connection.pendingClientBytes + bytes > MAX_BUFFERED_CLIENT_BYTES
      ) {
        connection.webSocket?.close(1011, 'app-server input queue limit reached');
        return;
      }
      connection.pendingClientLines.push(line);
      connection.pendingClientBytes += bytes;
      return;
    }
    if (!connection.appServer.stdin.write(`${line}\n`, 'utf-8')) {
      connection.webSocket?.pause();
    }
  }

  private onServerLine(connection: BridgeConnection, line: string): void {
    const observations = connection.attentionCapture?.observeServerText(line) ?? [];
    this.postAttention(connection, observations);
    const exactSuccess = observations.some(
      (observation) => observation.kind === 'terminal-result' && observation.result === 'success',
    );
    for (const event of this.capture.observeServerText(line)) {
      if (exactSuccess && event.method === 'turn/completed' && event.status === 'completed')
        continue;
      this.router.post(event);
    }
    if (!connection.webSocket || connection.webSocket.readyState !== WebSocket.OPEN) {
      this.bufferPendingServerLine(connection, line);
      return;
    }
    this.enqueueOutbound(connection, line);
  }

  private postAttention(
    connection: BridgeConnection,
    observations: SanitizedAttentionObservation[],
  ): void {
    const capture = connection.attentionCapture;
    if (capture === undefined || this.attention === undefined) return;
    for (const observation of observations) this.attention.router.post(capture.scope, observation);
  }

  private enqueueOutbound(connection: BridgeConnection, line: string): void {
    const bytes = Buffer.byteLength(line);
    if (
      connection.outboundLines.length >= MAX_OUTBOUND_LINES ||
      connection.outboundBytes + bytes > MAX_BUFFERED_SERVER_BYTES
    ) {
      connection.webSocket?.close(1011, 'app-server output backpressure limit reached');
      return;
    }
    connection.outboundLines.push(line);
    connection.outboundBytes += bytes;
    if (
      connection.outboundLines.length > MAX_OUTBOUND_LINES / 2 ||
      connection.outboundBytes > MAX_BUFFERED_SERVER_BYTES / 2
    ) {
      connection.appServer?.stdout?.pause();
    }
    this.sendNext(connection);
  }

  private sendNext(connection: BridgeConnection): void {
    if (connection.sending) return;
    const line = connection.outboundLines.shift();
    if (line === undefined) {
      connection.appServer?.stdout?.resume();
      return;
    }
    if (!connection.webSocket || connection.webSocket.readyState !== WebSocket.OPEN) {
      connection.outboundBytes = Math.max(0, connection.outboundBytes - Buffer.byteLength(line));
      this.bufferPendingServerLine(connection, line);
      return;
    }
    connection.sending = true;
    try {
      connection.webSocket.send(line, (error) => {
        connection.sending = false;
        connection.outboundBytes = Math.max(0, connection.outboundBytes - Buffer.byteLength(line));
        if (error) {
          connection.webSocket?.close(1011, 'failed to forward app-server output');
          return;
        }
        if (
          connection.outboundLines.length < MAX_OUTBOUND_LINES / 4 &&
          connection.outboundBytes < MAX_BUFFERED_SERVER_BYTES / 4
        ) {
          connection.appServer?.stdout?.resume();
        }
        this.sendNext(connection);
      });
    } catch {
      connection.sending = false;
      connection.outboundBytes = Math.max(0, connection.outboundBytes - Buffer.byteLength(line));
      connection.webSocket?.close(1011, 'failed to forward app-server output');
    }
  }

  private authorized(header: string | undefined): boolean {
    const expected = `Bearer ${this.token}`;
    if (!header || header.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(header), Buffer.from(expected));
  }

  private closeClientForAppServerFailure(connection: BridgeConnection, reason: string): void {
    if (
      connection.webSocket?.readyState === WebSocket.OPEN ||
      connection.webSocket?.readyState === WebSocket.CONNECTING
    ) {
      connection.webSocket.close(1011, reason);
    }
  }

  private bufferPendingServerLine(connection: BridgeConnection, line: string): void {
    const bytes = Buffer.byteLength(line);
    while (
      connection.pendingServerLines.length > 0 &&
      (connection.pendingServerLines.length >= MAX_PENDING_SERVER_LINES ||
        connection.pendingServerBytes + bytes > MAX_BUFFERED_SERVER_BYTES)
    ) {
      const removed = connection.pendingServerLines.shift();
      if (removed !== undefined) {
        connection.pendingServerBytes -= Buffer.byteLength(removed);
      }
    }
    if (bytes > MAX_BUFFERED_SERVER_BYTES) return;
    connection.pendingServerLines.push(line);
    connection.pendingServerBytes += bytes;
  }
}

export async function runSidecar(argv = process.argv.slice(2)): Promise<ExitResult> {
  const separator = argv.indexOf('--');
  const sidecarArgs = separator < 0 ? [] : argv.slice(0, separator);
  const codexArgs = separator < 0 ? argv : argv.slice(separator + 1);
  const shimDirectory = readSidecarOption(sidecarArgs, '--shim-dir');
  const environment = withoutShimPath(process.env, shimDirectory);
  const launcher = await resolveCodexLauncher(environment, shimDirectory);
  delete environment.REMOTE_NOTIFIER_CODEX_REAL;
  const invocation = planCodexInvocation(codexArgs, process.cwd());

  if (invocation.mode === 'passthrough') {
    return runCodex(launcher, invocation.tuiArgs, {
      cwd: process.cwd(),
      env: environment,
      stdio: 'inherit',
    });
  }

  const version = await captureCodexOutput(launcher, ['--version'], environment).catch(() => '');
  if (!isCodexProtocolVersion(version)) {
    return runCodex(launcher, invocation.tuiArgs, {
      cwd: process.cwd(),
      env: environment,
      stdio: 'inherit',
    });
  }

  const invocationId = randomBytes(16).toString('hex');
  const token = randomBytes(32).toString('hex');
  const ancestry = await processAncestry();
  const capture = new CodexProtocolCapture(invocationId, ancestry);
  const router = new CodexRouterClient(environment, (message) =>
    process.stderr.write(`[remote-notifier] ${message}\n`),
  );
  const attentionRouter = new CodexAttentionRouterClient(environment, (message) =>
    process.stderr.write(`[remote-notifier] ${message}\n`),
  );
  const bridge = new CodexWebSocketBridge(token, capture, router, {
    invocationId,
    version,
    router: attentionRouter,
  });
  let address: string;
  try {
    address = await bridge.listen();
  } catch {
    attentionRouter.stop();
    return runCodex(launcher, invocation.tuiArgs, {
      cwd: process.cwd(),
      env: environment,
      stdio: 'inherit',
    });
  }

  const appServerEnvironment = {
    ...environment,
    [ENV_CODEX_PROTOCOL_SESSION]: '1',
  };
  const tuiEnvironment = {
    ...appServerEnvironment,
    [TOKEN_ENVIRONMENT_VARIABLE]: token,
  };
  const startAppServer = async (): Promise<ChildProcess> => {
    const child = spawnCodex(launcher, invocation.appServerArgs, {
      cwd: invocation.cwd,
      env: appServerEnvironment,
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    await waitForSpawn(child);
    return child;
  };
  let appServer: ChildProcess;
  try {
    appServer = await startAppServer();
  } catch {
    await bridge.close().catch(() => {});
    attentionRouter.stop();
    return runCodex(launcher, invocation.tuiArgs, {
      cwd: process.cwd(),
      env: environment,
      stdio: 'inherit',
    });
  }
  try {
    bridge.attach(appServer, startAppServer);
  } catch {
    await stopChild(appServer);
    await bridge.close().catch(() => {});
    attentionRouter.stop();
    return runCodex(launcher, invocation.tuiArgs, {
      cwd: process.cwd(),
      env: environment,
      stdio: 'inherit',
    });
  }

  router.post(capture.lifecycle('session/started'));
  const tuiArgs = injectRemoteArguments(invocation, address, TOKEN_ENVIRONMENT_VARIABLE);
  let tui: ChildProcess;
  try {
    tui = spawnCodex(launcher, tuiArgs, {
      cwd: process.cwd(),
      env: tuiEnvironment,
      stdio: 'inherit',
    });
    await waitForSpawn(tui);
  } catch {
    await stopChild(appServer);
    await bridge.close().catch(() => {});
    router.post(capture.lifecycle('session/ended'));
    await Promise.all([
      router.drain(ROUTER_DRAIN_TIMEOUT_MS),
      attentionRouter.drain(ROUTER_DRAIN_TIMEOUT_MS),
    ]);
    router.stop();
    attentionRouter.stop();
    return runCodex(launcher, invocation.tuiArgs, {
      cwd: process.cwd(),
      env: environment,
      stdio: 'inherit',
    });
  }

  const disposeSignals = forwardSignals(tui);
  let result: ExitResult;
  try {
    result = await waitForExit(tui);
  } catch {
    result = { code: 1, signal: null };
  } finally {
    disposeSignals();
  }
  const shouldFailOpen = result.code !== null && result.code !== 0 && !bridge.threadEstablished;
  await stopChild(appServer);
  await bridge.close().catch(() => {});
  router.post(capture.lifecycle('session/ended'));
  await Promise.all([
    router.drain(ROUTER_DRAIN_TIMEOUT_MS),
    attentionRouter.drain(ROUTER_DRAIN_TIMEOUT_MS),
  ]);
  router.stop();
  attentionRouter.stop();
  if (shouldFailOpen) {
    return runCodex(launcher, invocation.tuiArgs, {
      cwd: process.cwd(),
      env: environment,
      stdio: 'inherit',
    });
  }
  return result;
}

async function main(): Promise<void> {
  try {
    const result = await runSidecar();
    if (result.signal && process.platform !== 'win32') {
      process.removeAllListeners(result.signal);
      process.kill(process.pid, result.signal);
      return;
    }
    process.exitCode = result.code ?? 1;
  } catch (error) {
    process.stderr.write(
      `[remote-notifier] Codex shim failed open: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}

async function resolveCodexLauncher(
  environment: NodeJS.ProcessEnv,
  shimDirectory?: string,
): Promise<Launcher> {
  const configured = environment.REMOTE_NOTIFIER_CODEX_REAL?.trim();
  const candidates = configured
    ? [configured]
    : await locateCodexCommands(environment, shimDirectory);
  const executable = candidates[0];
  if (!executable) throw new Error('could not locate the original Codex executable');

  const npmScript = path.join(
    path.dirname(executable),
    'node_modules',
    '@openai',
    'codex',
    'bin',
    'codex.js',
  );
  try {
    await fs.access(npmScript);
    const bundledNode =
      process.platform === 'win32'
        ? path.join(path.dirname(executable), 'node.exe')
        : path.join(path.dirname(executable), 'node');
    const nodeCommand = await fs
      .access(bundledNode)
      .then(() => bundledNode)
      .catch(() => resolveNpmNodeRuntime());
    return { command: nodeCommand, prefixArgs: [npmScript] };
  } catch {
    const extension = path.extname(executable).toLowerCase();
    return {
      command: executable,
      prefixArgs: [],
      ...(extension === '.cmd' || extension === '.bat' ? { commandShell: true } : {}),
    };
  }
}

async function locateCodexCommands(
  environment: NodeJS.ProcessEnv,
  shimDirectory?: string,
): Promise<string[]> {
  const command = process.platform === 'win32' ? 'where.exe' : 'which';
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(command, ['codex'], {
      env: environment,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: LAUNCHER_LOOKUP_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    let stdout = '';
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < 64 * 1024) {
        stdout += chunk.toString().slice(0, 64 * 1024 - stdout.length);
      }
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve(stdout) : reject(new Error('Codex was not found on PATH')),
    );
  });
  const normalizedShim = shimDirectory ? normalizePath(shimDirectory) : undefined;
  return output
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => !normalizedShim || normalizePath(path.dirname(entry)) !== normalizedShim);
}

function spawnCodex(launcher: Launcher, args: string[], options: SpawnOptions): ChildProcess {
  const completeArgs = [...launcher.prefixArgs, ...args];
  if (!launcher.commandShell) return spawn(launcher.command, completeArgs, options);
  const commandLine = [launcher.command, ...completeArgs].map(quoteCmdArgument).join(' ');
  return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', commandLine], options);
}

function runCodex(launcher: Launcher, args: string[], options: SpawnOptions): Promise<ExitResult> {
  const child = spawnCodex(launcher, args, options);
  return waitForExit(child);
}

function captureCodexOutput(
  launcher: Launcher,
  args: string[],
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnCodex(launcher, args, {
      env: environment,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: VERSION_PROBE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    let output = '';
    child.stdout?.on('data', (chunk) => {
      if (output.length < 4096) {
        output += chunk.toString().slice(0, 4096 - output.length);
      }
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve(output) : reject(new Error('Codex version probe failed')),
    );
  });
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
}

function waitForExit(child: ChildProcess): Promise<ExitResult> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.stdin?.end();
  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }
  await Promise.race([
    waitForExit(child).then(
      () => {},
      () => {},
    ),
    delay(500),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill('SIGKILL');
      await Promise.race([
        waitForExit(child).then(
          () => {},
          () => {},
        ),
        delay(500),
      ]);
    } catch {
      // The process exited between the state check and the signal.
    }
  }
}

function forwardSignals(child: ChildProcess): () => void {
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of signals) {
    if (process.platform === 'win32' && signal === 'SIGHUP') continue;
    const handler = () => child.kill(signal);
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
}

async function processAncestry(): Promise<number[]> {
  if (process.platform === 'win32') {
    const script =
      '$p=Get-CimInstance Win32_Process; $m=@{}; $p|%{$m[[int]$_.ProcessId]=[int]$_.ParentProcessId};' +
      `$id=${process.pid};$a=@();for($i=0;$i -lt 24;$i++){` +
      'if(!$m.ContainsKey($id)){break};$id=$m[$id];if($id -le 1){break};$a+=$id};$a -join ","';
    try {
      const output = await runSmallCommand('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        script,
      ]);
      return output
        .trim()
        .split(',')
        .map(Number)
        .filter((value) => Number.isSafeInteger(value) && value > 0)
        .slice(0, 24);
    } catch {
      return process.ppid > 1 ? [process.ppid] : [];
    }
  }

  const ancestry: number[] = [];
  let processId = process.pid;
  for (let index = 0; index < 24; index++) {
    try {
      const stat = await fs.readFile(`/proc/${processId}/stat`, 'utf-8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/);
      const parentId = Number(fields[1]);
      if (!Number.isSafeInteger(parentId) || parentId <= 1) break;
      ancestry.push(parentId);
      processId = parentId;
    } catch {
      if (processId === process.pid && process.ppid > 1) ancestry.push(process.ppid);
      break;
    }
  }
  return ancestry;
}

function runSmallCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: ANCESTRY_PROBE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    let output = '';
    child.stdout?.on('data', (chunk) => {
      if (output.length < 8192) {
        output += chunk.toString().slice(0, 8192 - output.length);
      }
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve(output) : reject(new Error(`${command} failed`)),
    );
  });
}

function withoutShimPath(
  environment: NodeJS.ProcessEnv,
  shimDirectory?: string,
): NodeJS.ProcessEnv {
  const result = { ...environment };
  if (
    result[ELECTRON_NODE_MARKER] === '1' ||
    (result.ELECTRON_RUN_AS_NODE === '1' && !isNodeRuntime(process.execPath))
  ) {
    delete result.ELECTRON_RUN_AS_NODE;
  }
  delete result[ELECTRON_NODE_MARKER];
  const pathKey = Object.keys(result).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  const normalizedShim = shimDirectory ? normalizePath(shimDirectory) : undefined;
  const entries = String(result[pathKey] ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .filter((entry) => !normalizedShim || normalizePath(entry) !== normalizedShim);
  result[pathKey] = entries.join(path.delimiter);
  return result;
}

export function resolveNpmNodeRuntime(
  currentExecutable = process.execPath,
  platform = process.platform,
): string {
  return isNodeRuntime(currentExecutable)
    ? currentExecutable
    : platform === 'win32'
      ? 'node.exe'
      : 'node';
}

function isNodeRuntime(executable: string): boolean {
  const name = path.basename(executable).toLowerCase();
  return name === 'node' || name === 'node.exe';
}

function readSidecarOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function normalizePath(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function quoteCmdArgument(value: string): string {
  const quoted = value
    .replace(/%/g, '%%')
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\+)$/g, '$1$1');
  return `"${quoted}"`;
}

function postJson(
  url: URL,
  token: string,
  event: CodexProtocolEvent,
): Promise<'accepted' | 'retry' | 'drop'> {
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify(event), 'utf-8');
    const request = http.request(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': body.length,
        },
      },
      (response) => {
        response.resume();
        if (response.statusCode === 202) resolve('accepted');
        else if (
          response.statusCode === 401 ||
          response.statusCode === 404 ||
          response.statusCode === 408 ||
          (response.statusCode !== undefined && response.statusCode >= 500)
        ) {
          resolve('retry');
        } else {
          resolve('drop');
        }
      },
    );
    request.setTimeout(HTTP_TIMEOUT_MS, () => request.destroy());
    request.once('error', () => resolve('retry'));
    request.end(body);
  });
}

function postAttentionJson(
  url: URL,
  token: string,
  exchange: ObservationExchange,
): Promise<
  { kind: 'drop' } | { kind: 'receipt'; receipt: ObservationExchangeReceipt } | { kind: 'retry' }
> {
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify(exchange), 'utf-8');
    const request = http.request(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': body.length,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let responseBytes = 0;
        response.on('data', (chunk: Buffer) => {
          responseBytes += chunk.length;
          if (responseBytes <= 64 * 1024) chunks.push(chunk);
        });
        response.on('end', () => {
          if (response.statusCode === 200 && responseBytes <= 64 * 1024) {
            try {
              const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
                Buffer.concat(chunks),
              );
              resolve({
                kind: 'receipt',
                receipt: parseObservationExchangeReceipt(JSON.parse(decoded)),
              });
              return;
            } catch {
              resolve({ kind: 'retry' });
              return;
            }
          }
          if (
            response.statusCode === 401 ||
            response.statusCode === 404 ||
            response.statusCode === 408 ||
            (response.statusCode !== undefined && response.statusCode >= 500)
          ) {
            resolve({ kind: 'retry' });
          } else {
            resolve({ kind: 'drop' });
          }
        });
      },
    );
    request.setTimeout(HTTP_TIMEOUT_MS, () => request.destroy());
    request.once('error', () => resolve({ kind: 'retry' }));
    request.end(body);
  });
}

async function resolveRouterEndpoint(
  environment: NodeJS.ProcessEnv,
): Promise<{ url: URL; token: string } | undefined> {
  const sessionFile = environment.REMOTE_NOTIFIER_SESSION_FILE;
  if (sessionFile) {
    try {
      const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        await fs.readFile(sessionFile),
      );
      if (raw.length <= 64 * 1024) {
        const session = JSON.parse(raw) as Record<string, unknown>;
        if (
          Number.isSafeInteger(session.port) &&
          Number(session.port) > 0 &&
          typeof session.token === 'string' &&
          session.token.length > 0
        ) {
          return {
            url: new URL(`http://127.0.0.1:${Number(session.port)}/codex/events`),
            token: session.token,
          };
        }
      }
    } catch {
      // Extension reloads can briefly replace the session file.
    }
  }

  const rawUrl = environment.REMOTE_NOTIFIER_URL;
  const token = environment.REMOTE_NOTIFIER_TOKEN;
  if (!rawUrl || !token) return undefined;
  try {
    const url = new URL(rawUrl);
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return undefined;
    url.pathname = '/codex/events';
    url.search = '';
    url.hash = '';
    return { url, token };
  } catch {
    return undefined;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
