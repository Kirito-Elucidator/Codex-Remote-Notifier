import { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';

import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CodexProtocolCapture } from '../../src/codex/CodexProtocolCapture';
import {
  CodexAttentionRouterClient,
  CodexRouterClient,
  CodexWebSocketBridge,
  resolveNpmNodeRuntime,
  runSidecar,
} from '../../src/sidecar/codex-notifier-sidecar';

describe('CodexWebSocketBridge', () => {
  const bridges: CodexWebSocketBridge[] = [];

  afterEach(async () => {
    await Promise.all(bridges.splice(0).map((bridge) => bridge.close().catch(() => {})));
  });

  it('authenticates one client and forwards protocol text exactly in both directions', async () => {
    const token = 'private-capability-token';
    const captured: unknown[] = [];
    const router = { post: vi.fn((event) => captured.push(event)) };
    const bridge = new CodexWebSocketBridge(
      token,
      new CodexProtocolCapture('instance-1', [101]),
      router as unknown as CodexRouterClient,
    );
    bridges.push(bridge);
    const address = await bridge.listen();
    const appServer = fakeAppServer();
    bridge.attach(appServer.process);

    await expectUnauthorized(address);

    const client = await connectWebSocket(address, token);
    const clientRequest = '{"id":1,"method":"initialize","params":{"clientInfo":{}}}';
    const appInput = onceText(appServer.stdin);
    client.send(clientRequest);
    await expect(appInput).resolves.toBe(`${clientRequest}\n`);

    const approval =
      '{"id":"approval-1","method":"item/fileChange/requestApproval","params":' +
      '{"threadId":"thread-1","turnId":"turn-1","reason":"private"}}';
    const received: string[] = [];
    client.on('message', (value) => received.push(value.toString()));
    appServer.stdout.write(approval.slice(0, 40));
    await delay(10);
    expect(received).toEqual([]);
    appServer.stdout.write(`${approval.slice(40)}\n`);
    await waitFor(() => received.length === 1);

    expect(received).toEqual([approval]);
    expect(captured).toEqual([
      expect.objectContaining({
        method: 'item/fileChange/requestApproval',
        request_id: 'approval-1',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
      }),
    ]);
    expect(JSON.stringify(captured)).not.toContain('private');

    client.close();
    await onceClose(client);
  });

  it('gives a nested session picker its own app-server connection', async () => {
    const router = { post: vi.fn() };
    const bridge = new CodexWebSocketBridge(
      'token',
      new CodexProtocolCapture('instance-1', []),
      router as unknown as CodexRouterClient,
    );
    bridges.push(bridge);
    const address = await bridge.listen();
    const primary = fakeAppServer();
    const picker = fakeAppServer();
    bridge.attach(primary.process, async () => picker.process);

    const tui = await connectWebSocket(address, 'token');
    const tuiInput = onceText(primary.stdin);
    tui.send('{"id":1,"method":"initialize","params":{"clientInfo":{"name":"tui"}}}');
    await expect(tuiInput).resolves.toContain('"name":"tui"');

    const sessionPicker = await connectWebSocket(address, 'token');
    const pickerInput = onceText(picker.stdin);
    sessionPicker.send('{"id":1,"method":"initialize","params":{"clientInfo":{"name":"picker"}}}');
    await expect(pickerInput).resolves.toContain('"name":"picker"');

    const tuiMessages: string[] = [];
    const pickerMessages: string[] = [];
    tui.on('message', (value) => tuiMessages.push(value.toString()));
    sessionPicker.on('message', (value) => pickerMessages.push(value.toString()));
    picker.stdout.write('{"id":1,"result":{"picker":true}}\n');
    await waitFor(() => pickerMessages.length === 1);

    expect(pickerMessages).toEqual(['{"id":1,"result":{"picker":true}}']);
    expect(tuiMessages).toEqual([]);
    expect(tui.readyState).toBe(WebSocket.OPEN);

    tui.close();
    sessionPicker.close();
    await Promise.all([onceClose(tui), onceClose(sessionPicker)]);
  });

  it('replays an audited primary protocol success as scoped source-neutral observations', async () => {
    const attention = { post: vi.fn() };
    const bridge = new CodexWebSocketBridge(
      'token',
      new CodexProtocolCapture('0123456789abcdef0123456789abcdef', []),
      { post: vi.fn() } as unknown as CodexRouterClient,
      {
        invocationId: '0123456789abcdef0123456789abcdef',
        version: 'codex-cli 0.147.0',
        router: attention as unknown as CodexAttentionRouterClient,
      },
    );
    bridges.push(bridge);
    const address = await bridge.listen();
    const appServer = fakeAppServer();
    bridge.attach(appServer.process);
    const client = await connectWebSocket(address, 'token');

    client.send(
      '{"id":1,"method":"initialize","params":{"clientInfo":{"name":"codex-tui","version":"0.147.0"},"capabilities":{"experimentalApi":true}}}',
    );
    await onceText(appServer.stdin);
    appServer.stdout.write(
      '{"id":1,"result":{"userAgent":"codex_cli_rs/0.147.0","codexHome":"/home/test/.codex","platformFamily":"unix","platformOs":"linux"}}\n',
    );
    client.send('{"method":"initialized"}');
    client.send('{"id":2,"method":"thread/start","params":{"cwd":"/repo"}}');
    await onceText(appServer.stdin);
    appServer.stdout.write(
      [
        '{"method":"thread/started","params":{"thread":{"id":"thread-1","sessionId":"session-root","parentThreadId":null,"source":"cli"}}}',
        '{"id":2,"result":{"thread":{"id":"thread-1"}}}',
        '{"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1"}}}',
        '{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"completed","items":[{"type":"agentMessage","text":"audited success"}]}}}',
      ].join('\n') + '\n',
    );

    await waitFor(() => attention.post.mock.calls.length === 3);
    const calls = attention.post.mock.calls;
    expect(calls.map(([, observation]) => observation)).toEqual([
      expect.objectContaining({ kind: 'connection-qualification', sourceSequence: 1 }),
      expect.objectContaining({ kind: 'turn-start', sourceSequence: 2, turnKey: 'turn-1' }),
      expect.objectContaining({
        kind: 'terminal-result',
        sourceSequence: 3,
        canonicalBody: 'audited success',
      }),
    ]);
    const scopes = calls.map(([scope]) => scope);
    expect(new Set(scopes.map((scope) => scope.connectionId)).size).toBe(1);
    expect(scopes[0]).toEqual({
      invocationId: '0123456789abcdef0123456789abcdef',
      connectionId: expect.stringMatching(/^[0-9a-f]{32}$/),
      authorityEpoch: expect.stringMatching(/^[0-9a-f]{32}$/),
    });

    client.close();
    await onceClose(client);
  });

  it('closes a stalled client when the bounded outbound queue is exhausted', async () => {
    const router = { post: vi.fn() };
    const bridge = new CodexWebSocketBridge(
      'token',
      new CodexProtocolCapture('instance-1', []),
      router as unknown as CodexRouterClient,
    );
    bridges.push(bridge);
    const address = await bridge.listen();
    const appServer = fakeAppServer();
    const pause = vi.spyOn(appServer.stdout, 'pause');
    bridge.attach(appServer.process);
    const client = await connectWebSocket(address, 'token');

    const closed = onceClose(client);
    appServer.stdout.write(`${Array.from({ length: 1026 }, () => '{}').join('\n')}\n`);

    await expect(closed).resolves.toBe(1011);
    expect(pause).toHaveBeenCalled();
  });
});

describe('CodexRouterClient', () => {
  it('posts sanitized events to the authenticated internal endpoint', async () => {
    let received:
      | { path?: string; authorization?: string; body: Record<string, unknown> }
      | undefined;
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        received = {
          path: request.url,
          authorization: request.headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString('utf-8')),
        };
        response.writeHead(202);
        response.end();
      });
    });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');

    const client = new CodexRouterClient({
      REMOTE_NOTIFIER_URL: `http://127.0.0.1:${address.port}/notify`,
      REMOTE_NOTIFIER_TOKEN: 'router-token',
    });
    client.post({
      version: 1,
      kind: 'protocol',
      method: 'session/started',
      instance_id: 'instance-1',
    });
    await client.drain(2000);
    client.stop();
    await closeServer(server);

    expect(received).toEqual({
      path: '/codex/events',
      authorization: 'Bearer router-token',
      body: expect.objectContaining({
        method: 'session/started',
        instance_id: 'instance-1',
      }),
    });
  });

  it('retries a transient missing endpoint during Router activation', async () => {
    let attempts = 0;
    const attempted: Array<Record<string, unknown>> = [];
    const accepted: Array<Record<string, unknown>> = [];
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        attempts++;
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        attempted.push(body);
        if (attempts === 1) {
          response.writeHead(404);
          response.end();
          return;
        }
        accepted.push(body);
        response.writeHead(202);
        response.end();
      });
    });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    const client = new CodexRouterClient({
      REMOTE_NOTIFIER_URL: `http://127.0.0.1:${address.port}/notify`,
      REMOTE_NOTIFIER_TOKEN: 'router-token',
    });

    try {
      client.post({
        version: 1,
        kind: 'protocol',
        method: 'error',
        instance_id: 'instance-retry',
        thread_id: 'thread-retry',
        turn_id: 'turn-retry',
        occurrence_id: 'error-1',
        will_retry: true,
        error: {
          message: 'temporary disconnect',
          code: 'responseStreamDisconnected',
        },
      });
      await client.drain(2000);
      expect(attempts).toBe(2);
      expect(attempted.map((event) => event.occurrence_id)).toEqual(['error-1', 'error-1']);
      expect(accepted).toEqual([
        expect.objectContaining({
          method: 'error',
          instance_id: 'instance-retry',
          occurrence_id: 'error-1',
        }),
      ]);
    } finally {
      client.stop();
      await closeServer(server);
    }
  });

  it('bounds its retry queue while the Router is unavailable', () => {
    const diagnostics = vi.fn();
    const client = new CodexRouterClient({}, diagnostics);
    const event = {
      version: 1,
      kind: 'protocol',
      method: 'session/started',
      instance_id: 'instance-1',
    } as const;

    for (let index = 0; index < 4100; index++) client.post(event);
    client.stop();

    expect(diagnostics).toHaveBeenCalledWith(
      'Router event queue reached its safety limit; oldest event was dropped',
    );
  });

  it('keeps queued events through a Router session-file replacement', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-notifier-router-reload-'));
    const sessionFile = path.join(root, 'session.json');
    const events: Array<Record<string, unknown>> = [];
    const diagnostics = vi.fn();
    const client = new CodexRouterClient(
      {
        REMOTE_NOTIFIER_SESSION_FILE: sessionFile,
      },
      diagnostics,
    );
    const server = createEventServer(events);

    try {
      client.post({
        version: 1,
        kind: 'protocol',
        method: 'turn/completed',
        instance_id: 'instance-reload',
        thread_id: 'thread-reload',
        turn_id: 'turn-reload',
        status: 'failed',
        error: {
          message: 'stream closed before response.completed',
          code: 'responseStreamDisconnected',
        },
      });
      const drained = client.drain(2000);
      await delay(150);

      await listen(server);
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('test server did not bind');
      await fs.writeFile(
        sessionFile,
        JSON.stringify({ port: address.port, token: 'replacement-token' }),
        'utf-8',
      );

      await drained;
      expect(events).toEqual([
        expect.objectContaining({
          method: 'turn/completed',
          status: 'failed',
        }),
      ]);
      expect(diagnostics).not.toHaveBeenCalledWith(
        expect.stringContaining('could not be delivered'),
      );
    } finally {
      client.stop();
      await closeServer(server).catch(() => {});
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('CodexAttentionRouterClient', () => {
  it('retains a stable observation exchange until the Router reports end-to-end application', async () => {
    const attempts: Array<Record<string, unknown>> = [];
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        const exchange = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        attempts.push(exchange);
        const through = exchange.observations.at(-1).sourceSequence;
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(
          JSON.stringify({
            receivedThrough: through,
            appliedThrough: attempts.length === 1 ? through - 1 : through,
            monitoring: 'exact',
          }),
        );
      });
    });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    const client = new CodexAttentionRouterClient({
      REMOTE_NOTIFIER_URL: `http://127.0.0.1:${address.port}/notify`,
      REMOTE_NOTIFIER_TOKEN: 'router-token',
    });
    const scope = {
      invocationId: '0123456789abcdef0123456789abcdef',
      connectionId: 'connection-1',
      authorityEpoch: 'authority-1',
    };

    try {
      client.post(scope, {
        kind: 'turn-start',
        sourceSequence: 1,
        turnKey: 'turn-1',
        returnTarget: 'opaque-route',
      });
      await client.drain(2_000);

      expect(attempts).toHaveLength(2);
      expect(attempts[1]).toEqual(attempts[0]);
      expect(attempts[0]).toMatchObject({
        kind: 'append',
        deliveryGeneration: expect.stringMatching(/^[0-9a-f]{32}$/),
        scope,
        fromSequence: 1,
      });
    } finally {
      client.stop();
      await closeServer(server);
    }
  });
});

describe('runSidecar passthrough', () => {
  it('never uses an Electron host as the Node runtime for an npm Codex launcher', () => {
    expect(resolveNpmNodeRuntime('C:\\Program Files\\Microsoft VS Code\\Code.exe', 'win32')).toBe(
      'node.exe',
    );
    expect(resolveNpmNodeRuntime('/usr/share/code/code', 'linux')).toBe('node');
    expect(resolveNpmNodeRuntime('D:\\Node\\node.exe', 'win32')).toBe('D:\\Node\\node.exe');
  });

  it('removes only the shim path and preserves the configured real executable', async () => {
    const previous = process.env.REMOTE_NOTIFIER_CODEX_REAL;
    process.env.REMOTE_NOTIFIER_CODEX_REAL = process.execPath;
    try {
      await expect(runSidecar(['--shim-dir', process.cwd(), '--', '--version'])).resolves.toEqual({
        code: 0,
        signal: null,
      });
    } finally {
      if (previous === undefined) delete process.env.REMOTE_NOTIFIER_CODEX_REAL;
      else process.env.REMOTE_NOTIFIER_CODEX_REAL = previous;
    }
  });

  it('runs the exact bridge, forwards sanitized events, cleans up, and preserves the TUI exit code', async () => {
    const fake = await createFakeCodex();
    const events: Array<Record<string, unknown>> = [];
    const server = createEventServer(events);
    await listen(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');

    const restore = replaceEnvironment({
      REMOTE_NOTIFIER_CODEX_REAL: fake.launcher,
      REMOTE_NOTIFIER_URL: `http://127.0.0.1:${address.port}/notify`,
      REMOTE_NOTIFIER_TOKEN: 'router-token',
      REMOTE_NOTIFIER_SESSION_FILE: undefined,
      REMOTE_NOTIFIER_CODEX_ELECTRON_NODE_SHIM: '1',
      ELECTRON_RUN_AS_NODE: '1',
      FAKE_CODEX_LOG: fake.logPath,
      FAKE_REMOTE_EXIT_CODE: '23',
      FAKE_REMOTE_MODE: 'connect',
      FAKE_PASSTHROUGH_EXIT_CODE: '7',
      NODE_PATH: path.resolve('node_modules'),
    });

    try {
      await expect(runSidecar(['--shim-dir', path.join(fake.root, 'shim'), '--'])).resolves.toEqual(
        {
          code: 23,
          signal: null,
        },
      );
      await waitFor(() => events.some((event) => event.method === 'session/ended'));

      const methods = events.map((event) => event.method);
      expect(methods).toEqual(
        expect.arrayContaining([
          'session/started',
          'thread/started',
          'turn/started',
          'item/commandExecution/requestApproval',
          'session/ended',
        ]),
      );
      expect(methods.at(-1)).toBe('session/ended');
      const exactObservations = events
        .filter((event) => event.kind === 'append')
        .flatMap((event) => event.observations as Array<Record<string, unknown>>);
      expect(exactObservations.map((observation) => observation.kind)).toEqual([
        'connection-qualification',
        'turn-start',
        'terminal-result',
      ]);
      expect(exactObservations.at(-1)).toMatchObject({
        result: 'success',
        canonicalBody: 'audited success',
      });
      expect(JSON.stringify(events)).not.toContain('private-command');

      const log = await readJsonLines(fake.logPath);
      expect(log.map((entry) => entry.mode)).toEqual(
        expect.arrayContaining([
          'version',
          'app-server',
          'remote',
          'remote-exit',
          'app-server-exit',
        ]),
      );
      expect(log.some((entry) => entry.mode === 'ordinary')).toBe(false);
      expect(log.every((entry) => entry.electronNode === null)).toBe(true);
    } finally {
      restore();
      await closeServer(server);
      await fs.rm(fake.root, { recursive: true, force: true });
    }
  });

  it('starts an isolated app-server for a nested TUI session picker', async () => {
    const fake = await createFakeCodex();
    const events: Array<Record<string, unknown>> = [];
    const server = createEventServer(events);
    await listen(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');

    const restore = replaceEnvironment({
      REMOTE_NOTIFIER_CODEX_REAL: fake.launcher,
      REMOTE_NOTIFIER_URL: `http://127.0.0.1:${address.port}/notify`,
      REMOTE_NOTIFIER_TOKEN: 'router-token',
      REMOTE_NOTIFIER_SESSION_FILE: undefined,
      FAKE_CODEX_LOG: fake.logPath,
      FAKE_REMOTE_EXIT_CODE: '0',
      FAKE_REMOTE_MODE: 'nested-connect',
      FAKE_PASSTHROUGH_EXIT_CODE: '7',
      NODE_PATH: path.resolve('node_modules'),
    });

    try {
      await expect(runSidecar(['--shim-dir', path.join(fake.root, 'shim'), '--'])).resolves.toEqual(
        {
          code: 0,
          signal: null,
        },
      );

      const log = await readJsonLines(fake.logPath);
      expect(log.filter((entry) => entry.mode === 'app-server')).toHaveLength(2);
      expect(log.map((entry) => entry.mode)).toEqual(
        expect.arrayContaining(['remote', 'nested-picker-exit']),
      );
    } finally {
      restore();
      await closeServer(server);
      await fs.rm(fake.root, { recursive: true, force: true });
    }
  });

  it('fails open to the original invocation when the remote TUI cannot establish a session', async () => {
    const fake = await createFakeCodex();
    const events: Array<Record<string, unknown>> = [];
    const server = createEventServer(events);
    await listen(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');

    const restore = replaceEnvironment({
      REMOTE_NOTIFIER_CODEX_REAL: fake.launcher,
      REMOTE_NOTIFIER_URL: `http://127.0.0.1:${address.port}/notify`,
      REMOTE_NOTIFIER_TOKEN: 'router-token',
      REMOTE_NOTIFIER_SESSION_FILE: undefined,
      FAKE_CODEX_LOG: fake.logPath,
      FAKE_REMOTE_EXIT_CODE: '42',
      FAKE_REMOTE_MODE: 'fail-before-connect',
      FAKE_PASSTHROUGH_EXIT_CODE: '7',
      NODE_PATH: path.resolve('node_modules'),
    });

    try {
      await expect(runSidecar(['--shim-dir', path.join(fake.root, 'shim'), '--'])).resolves.toEqual(
        {
          code: 7,
          signal: null,
        },
      );

      const log = await readJsonLines(fake.logPath);
      expect(log.map((entry) => entry.mode)).toEqual(
        expect.arrayContaining(['version', 'app-server', 'remote-failed', 'ordinary']),
      );
      const appServer = log.find((entry) => entry.mode === 'app-server');
      expect(isProcessRunning(Number(appServer?.pid))).toBe(false);
    } finally {
      restore();
      await closeServer(server);
      await fs.rm(fake.root, { recursive: true, force: true });
    }
  });

  it('fails open when initialization responds but no Codex thread is established', async () => {
    const fake = await createFakeCodex();
    const events: Array<Record<string, unknown>> = [];
    const server = createEventServer(events);
    await listen(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');

    const restore = replaceEnvironment({
      REMOTE_NOTIFIER_CODEX_REAL: fake.launcher,
      REMOTE_NOTIFIER_URL: `http://127.0.0.1:${address.port}/notify`,
      REMOTE_NOTIFIER_TOKEN: 'router-token',
      REMOTE_NOTIFIER_SESSION_FILE: undefined,
      FAKE_CODEX_LOG: fake.logPath,
      FAKE_REMOTE_EXIT_CODE: '42',
      FAKE_REMOTE_MODE: 'fail-after-initialize',
      FAKE_PASSTHROUGH_EXIT_CODE: '7',
      NODE_PATH: path.resolve('node_modules'),
    });

    try {
      await expect(runSidecar(['--shim-dir', path.join(fake.root, 'shim'), '--'])).resolves.toEqual(
        {
          code: 7,
          signal: null,
        },
      );

      const log = await readJsonLines(fake.logPath);
      expect(log.map((entry) => entry.mode)).toEqual(
        expect.arrayContaining(['version', 'app-server', 'remote-exit', 'ordinary']),
      );
    } finally {
      restore();
      await closeServer(server);
      await fs.rm(fake.root, { recursive: true, force: true });
    }
  });
});

function fakeAppServer(): {
  process: ChildProcess;
  stdin: PassThrough;
  stdout: PassThrough;
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const process = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
  }) as unknown as ChildProcess;
  return { process, stdin, stdout };
}

function connectWebSocket(address: string, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(address, {
      headers: { Authorization: `Bearer ${token}` },
    });
    client.once('open', () => resolve(client));
    client.once('error', reject);
  });
}

function expectUnauthorized(address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(address);
    client.once('unexpected-response', (_request, response) => {
      response.resume();
      try {
        expect(response.statusCode).toBe(401);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    client.once('error', () => {});
  });
}

function onceText(stream: PassThrough): Promise<string> {
  return new Promise((resolve) => stream.once('data', (chunk) => resolve(chunk.toString())));
}

function onceClose(client: WebSocket): Promise<number> {
  if (client.readyState === WebSocket.CLOSED) return Promise.resolve(1005);
  return new Promise((resolve) => client.once('close', (code) => resolve(code)));
}

function listen(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function createEventServer(events: Array<Record<string, unknown>>): http.Server {
  return http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      events.push(body);
      if (body.kind === 'append') {
        const through = body.observations.at(-1).sourceSequence;
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(
          JSON.stringify({
            receivedThrough: through,
            appliedThrough: through,
            monitoring: 'exact',
          }),
        );
        return;
      }
      response.writeHead(202);
      response.end();
    });
  });
}

async function createFakeCodex(): Promise<{
  root: string;
  launcher: string;
  logPath: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-notifier-fake-codex-'));
  const launcher = path.join(root, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  const scriptPath = path.join(root, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  const logPath = path.join(root, 'calls.jsonl');
  await fs.mkdir(path.dirname(scriptPath), { recursive: true });
  await fs.writeFile(launcher, '', 'utf-8');
  await fs.writeFile(
    scriptPath,
    [
      "const fs = require('fs');",
      "const WebSocket = require('ws');",
      'const args = process.argv.slice(2);',
      'const log = (mode, extra = {}) => {',
      "  fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ mode, electronNode: process.env.ELECTRON_RUN_AS_NODE || null, ...extra }) + '\\n');",
      '};',
      "if (args.length === 1 && args[0] === '--version') {",
      "  log('version');",
      "  process.stdout.write('codex-cli 0.145.0\\n');",
      "} else if (args[0] === 'app-server') {",
      "  log('app-server', { pid: process.pid });",
      "  let pending = '';",
      "  process.stdin.setEncoding('utf8');",
      "  process.stdin.on('data', (chunk) => {",
      '    pending += chunk;',
      "    let newline = pending.indexOf('\\n');",
      '    while (newline >= 0) {',
      '      const line = pending.slice(0, newline);',
      '      pending = pending.slice(newline + 1);',
      '      if (line) {',
      '        const request = JSON.parse(line);',
      "        if (request.method === 'initialize') {",
      "          process.stdout.write(JSON.stringify({ id: request.id, result: { userAgent: 'codex_cli_rs/0.145.0', codexHome: process.cwd(), platformFamily: process.platform === 'win32' ? 'windows' : 'unix', platformOs: process.platform } }) + '\\n');",
      "        } else if (request.method === 'thread/start' && process.env.FAKE_REMOTE_MODE !== 'fail-after-initialize') {",
      "          process.stdout.write(JSON.stringify({ method: 'thread/started', params: { thread: { id: 'thread-1', sessionId: 'session-root', cwd: process.cwd(), name: 'Fake session', parentThreadId: null, source: 'cli' } } }) + '\\n');",
      "          process.stdout.write(JSON.stringify({ id: request.id, result: { thread: { id: 'thread-1' } } }) + '\\n');",
      "          process.stdout.write(JSON.stringify({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } }) + '\\n');",
      "          process.stdout.write(JSON.stringify({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', command: 'private-command' } }) + '\\n');",
      "          process.stdout.write(JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [{ type: 'agentMessage', text: 'audited success' }] } } }) + '\\n');",
      '        }',
      '      }',
      "      newline = pending.indexOf('\\n');",
      '    }',
      '  });',
      "  process.stdin.on('end', () => { log('app-server-exit'); process.exit(0); });",
      '  process.stdin.resume();',
      "} else if (args.includes('--remote')) {",
      "  if (process.env.FAKE_REMOTE_MODE === 'fail-before-connect') {",
      "    log('remote-failed');",
      '    process.exit(Number(process.env.FAKE_REMOTE_EXIT_CODE || 42));',
      '  } else {',
      "    log('remote');",
      "    const address = args[args.indexOf('--remote') + 1];",
      "    const tokenName = args[args.indexOf('--remote-auth-token-env') + 1];",
      "    const client = new WebSocket(address, { headers: { Authorization: 'Bearer ' + process.env[tokenName] } });",
      '    let messages = 0;',
      "    client.on('open', () => client.send(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'codex-tui', version: '0.145.0' }, capabilities: { experimentalApi: true } } })));",
      '    let nestedPickerStarted = false;',
      "    client.on('message', () => {",
      '      messages += 1;',
      "      if (process.env.FAKE_REMOTE_MODE === 'fail-after-initialize') { client.close(); return; }",
      "      if (messages === 1) { client.send(JSON.stringify({ method: 'initialized' })); client.send(JSON.stringify({ id: 2, method: 'thread/start', params: {} })); return; }",
      '      if (messages < 6) return;',
      "      if (process.env.FAKE_REMOTE_MODE !== 'nested-connect') { client.close(); return; }",
      '      if (nestedPickerStarted) return;',
      '      nestedPickerStarted = true;',
      "      const picker = new WebSocket(address, { headers: { Authorization: 'Bearer ' + process.env[tokenName] } });",
      '      let pickerMessages = 0;',
      "      picker.on('open', () => picker.send(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'codex-tui', version: '0.145.0' }, capabilities: { experimentalApi: true } } })));",
      "      picker.on('message', () => { pickerMessages += 1; if (pickerMessages === 1) { picker.send(JSON.stringify({ method: 'initialized' })); picker.send(JSON.stringify({ id: 2, method: 'thread/start', params: {} })); return; } if (pickerMessages >= 6) picker.close(); });",
      "      picker.on('close', () => { log('nested-picker-exit', { pickerMessages }); client.close(); });",
      "      picker.on('error', () => { log('nested-picker-error'); process.exit(44); });",
      '    });',
      "    client.on('close', () => { log('remote-exit', { messages }); process.exit(Number(process.env.FAKE_REMOTE_EXIT_CODE || 0)); });",
      "    client.on('error', () => { log('remote-error'); process.exit(42); });",
      "    setTimeout(() => { log('remote-timeout', { messages }); process.exit(43); }, 5000).unref();",
      '  }',
      '} else {',
      "  log('ordinary');",
      '  process.exit(Number(process.env.FAKE_PASSTHROUGH_EXIT_CODE || 0));',
      '}',
      '',
    ].join('\n'),
    'utf-8',
  );
  return { root, launcher, logPath };
}

function replaceEnvironment(values: Record<string, string | undefined>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

async function readJsonLines(filePath: string): Promise<Array<Record<string, unknown>>> {
  const raw = await fs.readFile(filePath, 'utf-8');
  return raw
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function isProcessRunning(processId: number): boolean {
  if (!Number.isSafeInteger(processId) || processId <= 0) return false;
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error('condition was not reached');
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
