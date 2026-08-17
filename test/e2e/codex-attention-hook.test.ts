import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deriveDisplayableNotificationText } from 'remote-notifier-shared';

interface HookResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

interface ReceivedRequest {
  url: string;
  authorization?: string;
  contentType?: string;
  payload: Record<string, unknown>;
}

const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const hookPath = path.resolve(
  __dirname,
  '../../packages/router/src/installer/codex-attention-hook.py',
);

describe('Codex attention hook', { timeout: 30_000 }, () => {
  let server: http.Server;
  let port: number;
  let testHome: string;
  let sessionFile: string;
  const token = 'codex_hook_test_token';
  const received: ReceivedRequest[] = [];

  beforeAll(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), 'rn-codex-hook-'));
    sessionFile = path.join(testHome, 'session.json');
    server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        received.push({
          url: request.url ?? '',
          authorization: request.headers.authorization,
          contentType: request.headers['content-type'],
          payload: JSON.parse(Buffer.concat(chunks).toString('utf-8')),
        });
        response.writeHead(202, { 'Content-Type': 'application/json' });
        response.end('{"ok":true,"queued":true}');
      });
    });
    port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
    });
    await fs.writeFile(sessionFile, JSON.stringify({ port, token }), 'utf-8');
  });

  beforeEach(() => {
    received.length = 0;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(testHome, { recursive: true, force: true });
  });

  it('forwards all installed lifecycle hooks to the authenticated event endpoint', async () => {
    const events = [
      { hook_event_name: 'SessionStart' },
      { hook_event_name: 'UserPromptSubmit', prompt: 'must not leave the hook process' },
      {
        hook_event_name: 'Stop',
        last_assistant_message: 'Implemented and tested.',
        transcript_path: path.join(testHome, 'transcript.jsonl'),
      },
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'request_user_input',
        tool_use_id: 'request-1',
        tool_input: { questions: [{ question: 'secret prompt' }] },
      },
      {
        hook_event_name: 'PermissionRequest',
        request_id: 'request-2',
        tool_input: { command: 'private command' },
      },
    ];

    for (const event of events) {
      const result = await runHook({
        session_id: 'session-1',
        turn_id: 'turn-1',
        cwd: '/work/repo',
        model: 'private-model',
        ...event,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('{"continue":true}');
      expect(result.stderr).toBe('');
    }

    expect(received).toHaveLength(5);
    expect(received.every((request) => request.url === '/codex/events')).toBe(true);
    expect(received.every((request) => request.authorization === `Bearer ${token}`)).toBe(true);
    expect(received.map((request) => request.payload.hook_event_name)).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'Stop',
      'PreToolUse',
      'PermissionRequest',
    ]);
    expect(received[3].payload.request_id).toBe('request-1');
    expect(received[4].payload.request_id).toBe('request-2');
    for (const request of received) {
      expect(request.payload).toMatchObject({
        version: 1,
        kind: 'hook',
        session_id: 'session-1',
        turn_id: 'turn-1',
        cwd: '/work/repo',
      });
      expect(Array.isArray(request.payload.process_ancestry)).toBe(true);
      expect(request.payload).not.toHaveProperty('prompt');
      expect(request.payload).not.toHaveProperty('tool_input');
      expect(request.payload).not.toHaveProperty('model');
      expect(request.payload).not.toHaveProperty('title');
      expect(request.payload).not.toHaveProperty('message');
    }
  });

  it('preserves exact Unicode through the simulated Remote SSH hook route', async () => {
    const fixture = '中文🙂e\u0301<&>涓枃棰勮';

    const result = await runHook({
      hook_event_name: 'Stop',
      session_id: 'session-unicode',
      turn_id: 'turn-unicode',
      last_assistant_message: fixture,
    });

    expect(result.exitCode).toBe(0);
    expect(received).toHaveLength(1);
    expect(received[0].contentType).toBe('application/json; charset=utf-8');
    expect(received[0].payload.last_assistant_message).toBe(fixture);
  });

  it('contains damaged Remote SSH display fields without dropping the event', async () => {
    const damaged = '\ud800\ufffd\u0001\udfff';

    const result = await runHook({
      hook_event_name: 'Stop',
      session_id: 'session-damaged',
      turn_id: 'turn-damaged',
      last_assistant_message: damaged,
    });

    expect(result.exitCode).toBe(0);
    expect(received).toHaveLength(1);
    expect(received[0].payload.last_assistant_message).toBe(damaged);
    expect(deriveDisplayableNotificationText('valid title', damaged).body).toBe(
      '请返回 Codex 查看详情',
    );
  });

  it('rejects a malformed UTF-8 Hook envelope as a whole', async () => {
    const malformed = Buffer.concat([
      Buffer.from('{"hook_event_name":"Stop","last_assistant_message":"', 'utf-8'),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('"}', 'utf-8'),
    ]);

    const result = await runRawHook(malformed);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('{"continue":true}');
    expect(received).toHaveLength(0);
  });

  it('does not read transcripts, the session index, or SQLite in the helper', async () => {
    const hugeTranscript = path.join(testHome, 'huge-transcript.jsonl');
    await fs.writeFile(hugeTranscript, Buffer.alloc(12 * 1024 * 1024, 0x78));
    await fs.writeFile(path.join(testHome, 'session_index.jsonl'), Buffer.alloc(2 * 1024 * 1024));
    await fs.writeFile(path.join(testHome, 'state_5.sqlite'), Buffer.alloc(2 * 1024 * 1024));

    const result = await runHook({
      hook_event_name: 'Stop',
      session_id: 'session-large',
      turn_id: 'turn-large',
      cwd: '/work/repo',
      transcript_path: hugeTranscript,
      last_assistant_message: 'Done',
    });

    expect(result.exitCode).toBe(0);
    expect(result.elapsedMs).toBeLessThan(1500);
    expect(received[0].payload.transcript_path).toBe(hugeTranscript);
    expect(received[0].payload.last_assistant_message).toBe('Done');

    const source = await fs.readFile(hookPath, 'utf-8');
    expect(source).not.toMatch(/\b(?:sqlite3|glob)\b/);
    expect(source).not.toContain('session_index.jsonl');
    expect(source).not.toContain('MAX_TRANSCRIPT');
  });

  it('marks protocol-sidecar hook events so the Router can suppress duplicates', async () => {
    await runHook(
      {
        hook_event_name: 'PermissionRequest',
        session_id: 'session-protocol',
        turn_id: 'turn-protocol',
      },
      { REMOTE_NOTIFIER_CODEX_PROTOCOL_SESSION: '1' },
    );

    expect(received[0].payload.protocol_authoritative).toBe(true);
  });

  it('ignores unrelated and malformed hook input', async () => {
    expect(
      (
        await runHook({
          hook_event_name: 'PreToolUse',
          tool_name: 'shell',
          session_id: 'session-1',
        })
      ).exitCode,
    ).toBe(0);
    expect((await runRawHook('{invalid')).exitCode).toBe(0);
    expect(received).toHaveLength(0);
  });

  it('uses the refreshed scoped session file before stale inherited Router variables', async () => {
    const result = await runHook(
      {
        hook_event_name: 'Stop',
        session_id: 'session-reloaded',
        turn_id: 'turn-reloaded',
        last_assistant_message: 'Done',
      },
      {
        REMOTE_NOTIFIER_URL: 'http://127.0.0.1:1/notify',
        REMOTE_NOTIFIER_TOKEN: 'stale-token',
      },
    );

    expect(result.exitCode).toBe(0);
    expect(received).toHaveLength(1);
    expect(received[0].payload.session_id).toBe('session-reloaded');
  });

  it('fails open with valid no-op JSON and respects its internal deadline when Router is offline', async () => {
    const result = await runHook(
      {
        hook_event_name: 'Stop',
        session_id: 'session-offline',
        turn_id: 'turn-offline',
        last_assistant_message: 'Done',
      },
      {
        REMOTE_NOTIFIER_SESSION_FILE: '',
        REMOTE_NOTIFIER_URL: 'http://127.0.0.1:1/notify',
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('{"continue":true}');
    expect(result.stderr).toBe('');
    expect(result.elapsedMs).toBeLessThan(1500);
  });

  it('drops oversized stdin with valid no-op JSON instead of blocking Codex', async () => {
    const result = await runRawHook(
      JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'x'.repeat(300 * 1024),
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('{"continue":true}');
    expect(result.stderr).toBe('');
    expect(received).toHaveLength(0);
  });

  it('keeps the Windows wrapper output valid even when Python output is suppressed', async () => {
    if (process.platform !== 'win32') {
      return;
    }

    const wrapperDirectory = await fs.mkdtemp(path.join(testHome, 'wrapper-'));
    const wrapperPath = path.join(wrapperDirectory, 'codex-attention-hook.cmd');
    await Promise.all([
      fs.copyFile(hookPath, path.join(wrapperDirectory, 'codex-attention-hook')),
      fs.copyFile(
        path.resolve(__dirname, '../../packages/router/src/installer/codex-attention-hook.cmd'),
        wrapperPath,
      ),
    ]);

    const result = await runProcess(
      'cmd.exe',
      ['/d', '/c', 'call', wrapperPath],
      JSON.stringify({
        hook_event_name: 'PermissionRequest',
        session_id: 'session-wrapper',
        request_id: 'request-wrapper',
      }),
      {
        ...process.env,
        HOME: testHome,
        USERPROFILE: testHome,
        REMOTE_NOTIFIER_SESSION_FILE: sessionFile,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('{"continue":true}');
    expect(result.stderr).toBe('');
    expect(received.at(-1)?.payload).toMatchObject({
      hook_event_name: 'PermissionRequest',
      session_id: 'session-wrapper',
      request_id: 'request-wrapper',
    });
  });

  function runHook(
    payload: Record<string, unknown>,
    env: Record<string, string> = {},
  ): Promise<HookResult> {
    return runRawHook(JSON.stringify(payload), env);
  }

  function runRawHook(
    stdin: string | Buffer,
    env: Record<string, string> = {},
  ): Promise<HookResult> {
    return runProcess(python, [hookPath], stdin, {
      ...process.env,
      HOME: testHome,
      USERPROFILE: testHome,
      REMOTE_NOTIFIER_URL: `http://127.0.0.1:${port}/notify`,
      REMOTE_NOTIFIER_TOKEN: token,
      REMOTE_NOTIFIER_SESSION_FILE: sessionFile,
      ...env,
    });
  }
});

function runProcess(
  command: string,
  args: string[],
  stdin: string | Buffer,
  env: NodeJS.ProcessEnv,
): Promise<HookResult> {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) =>
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
        elapsedMs: performance.now() - startedAt,
      }),
    );
    child.stdin.end(stdin);
  });
}
