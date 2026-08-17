import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import * as path from 'path';
import * as http from 'http';
import * as net from 'net';

describe('code-notify shell helper', { timeout: 30000 }, () => {
  let server: http.Server;
  let port: number;
  const token = 'test_token_abc123def456';
  const receivedRequests: Array<{ headers: http.IncomingHttpHeaders; body: string }> = [];
  const isWindows = process.platform === 'win32';
  const scriptPath = path.resolve(
    __dirname,
    '../../packages/router/src/installer',
    isWindows ? 'code-notify.cmd' : 'code-notify.sh',
  );

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        receivedRequests.push({
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf-8'),
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id: 'notif_test123' }));
      });
    });

    port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as net.AddressInfo;
        resolve(addr.port);
      });
    });
  });

  afterAll(() => {
    server.close();
  });

  function runNotify(
    args: string[],
    env?: Record<string, string>,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const fullEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      REMOTE_NOTIFIER_PORT: String(port),
      REMOTE_NOTIFIER_TOKEN: token,
      REMOTE_NOTIFIER_URL: `http://127.0.0.1:${port}/notify`,
      ...env,
    };
    return new Promise((resolve) => {
      let child;
      if (isWindows) {
        // Build a single command line string to have full control over quoting.
        // Node's spawn with shell:true and an array is often unreliable on Windows.
        const escapedArgs = args.map((arg) => {
          // Use double quotes and escape internal quotes as "" (CMD standard)
          return `"${arg.replace(/"/g, '""')}"`;
        });
        const commandLine = `"${scriptPath}" ${escapedArgs.join(' ')}`;
        child = spawn(commandLine, {
          env: fullEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: true,
        });
      } else {
        child = spawn('bash', [scriptPath, ...args], {
          env: fullEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      }

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stderr += d.toString()));

      child.on('error', (err) => {
        resolve({ stdout: '', stderr: err.message, exitCode: 1 });
      });
      child.on('close', (code) => {
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      });
    });
  }

  it('sends a basic notification', async () => {
    receivedRequests.length = 0;
    const result = await runNotify(['Hello world']);
    expect(result.exitCode).toBe(0);
    expect(receivedRequests).toHaveLength(1);
    const body = JSON.parse(receivedRequests[0].body);
    expect(body.message).toBe('Hello world');
    expect(body.level).toBe('information');
  });

  it('sends notification with level flag', async () => {
    receivedRequests.length = 0;
    await runNotify(['-l', 'warning', 'Watch out']);
    const body = JSON.parse(receivedRequests[0].body);
    expect(body.level).toBe('warning');
    expect(body.message).toBe('Watch out');
  });

  it('sends notification with title', async () => {
    receivedRequests.length = 0;
    await runNotify(['Build', 'Completed']);
    const body = JSON.parse(receivedRequests[0].body);
    expect(body.title).toBe('Build');
    expect(body.message).toBe('Completed');
  });

  it('sends exact UTF-8 notification text with an explicit charset', async () => {
    receivedRequests.length = 0;
    const fixture = '中文🙂e\u0301<&>';
    await runNotify([fixture, fixture]);

    const body = JSON.parse(receivedRequests[0].body);
    expect(receivedRequests[0].headers['content-type']).toContain('charset=utf-8');
    expect(body.title).toBe(fixture);
    expect(body.message).toBe(fixture);
  });

  it('sends notification with display hint', async () => {
    receivedRequests.length = 0;
    await runNotify(['-d', 'app', 'Message']);
    const body = JSON.parse(receivedRequests[0].body);
    expect(body.display_hint).toBe('app');
    expect(body.message).toBe('Message');
  });

  it('sends notification with icon key', async () => {
    receivedRequests.length = 0;
    await runNotify(['-i', 'bell', 'Message']);
    const body = JSON.parse(receivedRequests[0].body);
    expect(body.icon).toBe('bell');
    expect(body.message).toBe('Message');
  });

  it('sends notification with all flags combined', async () => {
    receivedRequests.length = 0;
    await runNotify(['-l', 'error', '-d', 'system', 'CI', 'Pipeline failed']);
    const body = JSON.parse(receivedRequests[0].body);
    expect(body.level).toBe('error');
    expect(body.display_hint).toBe('system');
    expect(body.title).toBe('CI');
    expect(body.message).toBe('Pipeline failed');
  });

  it('includes bearer token in authorization header', async () => {
    receivedRequests.length = 0;
    await runNotify(['auth test']);
    expect(receivedRequests[0].headers.authorization).toBe(`Bearer ${token}`);
  });

  it('escapes quotes in message', async () => {
    receivedRequests.length = 0;
    await runNotify(['He said "hello"']);
    const body = JSON.parse(receivedRequests[0].body);
    expect(body.message).toBe('He said "hello"');
  });

  it('escapes backslashes in message', async () => {
    receivedRequests.length = 0;
    await runNotify(['path\\to\\file']);
    const body = JSON.parse(receivedRequests[0].body);
    expect(body.message).toBe('path\\to\\file');
  });

  it('fails with error when message is empty', async () => {
    const result = await runNotify([]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('message is required');
  });

  it('fails when server is unreachable', async () => {
    const result = await runNotify(['test'], {
      REMOTE_NOTIFIER_PORT: '1',
      REMOTE_NOTIFIER_TOKEN: token,
      REMOTE_NOTIFIER_URL: 'http://127.0.0.1:1/notify',
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('could not connect');
  });

  it('fails when no session info available', async () => {
    const result = await runNotify(['test'], {
      REMOTE_NOTIFIER_PORT: '',
      REMOTE_NOTIFIER_TOKEN: '',
      REMOTE_NOTIFIER_URL: '',
      HOME: '/nonexistent',
      USERPROFILE: 'C:\\nonexistent',
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('cannot find');
  });
});
