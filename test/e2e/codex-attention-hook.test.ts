import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

interface HookResult {
  exitCode: number;
  stdout: string;
  stderr: string;
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
  let codexHome: string;
  const token = 'codex_hook_test_token';
  const received: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), 'rn-codex-hook-'));
    codexHome = path.join(testHome, '.codex');
    await fs.mkdir(codexHome, { recursive: true });

    server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        received.push(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{"ok":true}');
      });
    });
    port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
    });

    const dbPath = path.join(codexHome, 'state_5.sqlite');
    await runPython(
      [
        'import sqlite3, sys',
        'db = sqlite3.connect(sys.argv[1])',
        'db.execute("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL)")',
        'db.execute("INSERT INTO threads VALUES (?, ?)", ("session-sqlite", "中文会话名称abcdef"))',
        'db.execute("INSERT INTO threads VALUES (?, ?)", ("session-unrenamed", "原始问题标题"))',
        'db.commit()',
      ].join(';'),
      [dbPath],
    );
    await fs.writeFile(
      path.join(codexHome, 'session_index.jsonl'),
      [
        JSON.stringify({ id: 'session-json', thread_name: '旧名称', updated_at: '1' }),
        JSON.stringify({ id: 'session-json', thread_name: 'JSON回退会话', updated_at: '2' }),
        JSON.stringify({ id: 'session-sqlite', thread_name: '重命名后的会话', updated_at: '3' }),
      ].join('\n') + '\n',
      'utf-8',
    );
  });

  beforeEach(() => {
    received.length = 0;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(testHome, { recursive: true, force: true });
  });

  it('maps all five Codex notifications and retains proposed-plan compatibility', async () => {
    const common = { session_id: 'session-sqlite', cwd: '/work/repo', model: 'test' };
    const planContinueTranscript = await writeTranscript('plan-continue', [
      {
        type: 'turn_context',
        payload: {
          turn_id: 'turn-plan-continue',
          collaboration_mode: { mode: 'plan' },
        },
      },
    ]);
    const events = [
      {
        ...common,
        turn_id: 'turn-task',
        hook_event_name: 'Stop',
        last_assistant_message: 'Implemented and tested.',
      },
      {
        ...common,
        turn_id: 'turn-answer',
        hook_event_name: 'PreToolUse',
        tool_name: 'request_user_input',
        tool_input: { questions: [] },
      },
      {
        ...common,
        turn_id: 'turn-plan-continue',
        hook_event_name: 'Stop',
        transcript_path: planContinueTranscript,
        last_assistant_message: 'The plan still needs a decision.',
      },
      {
        ...common,
        turn_id: 'turn-plan',
        hook_event_name: 'Stop',
        last_assistant_message: '<proposed_plan>\n# Plan\n</proposed_plan>',
      },
      {
        ...common,
        turn_id: 'turn-permission',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'make test' },
      },
    ];

    for (const event of events) {
      expect((await runHook(event)).exitCode).toBe(0);
    }

    expect(received.map((payload) => payload.title)).toEqual([
      '[任务完成]',
      '[等待回答]',
      '[计划继续]',
      '[计划完成]',
      '[等待授权]',
    ]);
    expect(received.map((payload) => payload.event_key)).toEqual([
      'task-complete',
      'waiting-answer',
      'plan-continue',
      'plan-complete',
      'waiting-permission',
    ]);
    expect(received.every((payload) => payload.source === 'codex')).toBe(true);
    expect(received.every((payload) => Array.isArray(payload.process_ancestry))).toBe(true);
    expect(
      received.every(
        (payload) =>
          (payload.process_ancestry as number[]).length > 0 &&
          (payload.process_ancestry as number[]).every(
            (processId) => Number.isSafeInteger(processId) && processId > 0,
          ),
      ),
    ).toBe(true);
    expect(received[0].message).toMatch(/ · 重命名后的会话 · Implemented and$/);
  });

  it('detects a structured Plan item when Stop omits the assistant message', async () => {
    const transcriptPath = await writeTranscript('structured-plan', [
      {
        type: 'turn_context',
        payload: {
          turn_id: 'turn-structured-plan',
          collaboration_mode: { mode: 'plan' },
        },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          turn_id: 'turn-structured-plan',
          item: { type: 'Plan', text: '# Complete plan' },
        },
      },
    ]);

    await runHook({
      session_id: 'session-sqlite',
      turn_id: 'turn-structured-plan',
      hook_event_name: 'Stop',
      transcript_path: transcriptPath,
      last_assistant_message: null,
      cwd: '/work/repo',
    });

    expect(received[0].title).toBe('[计划完成]');
    expect(received[0].event_key).toBe('plan-complete');
    expect(received[0].message).toMatch(/ · 重命名后的会话 · # Complete plan$/);
  });

  it('uses the structured Plan text when the session has not been renamed', async () => {
    const transcriptPath = await writeTranscript('unrenamed-structured-plan', [
      {
        type: 'turn_context',
        payload: {
          turn_id: 'turn-unrenamed-structured-plan',
          collaboration_mode: { mode: 'plan' },
        },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          turn_id: 'turn-unrenamed-structured-plan',
          item: { type: 'Plan', text: '这是没有重命名的完整计划正文内容示例' },
        },
      },
    ]);

    await runHook({
      session_id: 'session-no-title',
      turn_id: 'turn-unrenamed-structured-plan',
      hook_event_name: 'Stop',
      transcript_path: transcriptPath,
      last_assistant_message: null,
      cwd: '/work/repo',
    });

    expect(received[0].title).toBe('[计划完成]');
    expect(received[0].message).toMatch(/ · 这是没有重命名的完整计划正文内容$/);
  });

  it('does not reuse a structured Plan item from another turn', async () => {
    const transcriptPath = await writeTranscript('other-turn-plan', [
      {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          turn_id: 'turn-old-plan',
          item: { type: 'Plan', text: '# Old plan' },
        },
      },
      {
        type: 'turn_context',
        payload: {
          turn_id: 'turn-current-plan',
          collaboration_mode: { mode: 'plan' },
        },
      },
    ]);

    await runHook({
      session_id: 'session-sqlite',
      turn_id: 'turn-current-plan',
      hook_event_name: 'Stop',
      transcript_path: transcriptPath,
      last_assistant_message: 'Still discussing the plan.',
      cwd: '/work/repo',
    });

    expect(received[0].title).toBe('[计划继续]');
    expect(received[0].event_key).toBe('plan-continue');
  });

  it('reads a bounded transcript tail and skips malformed JSONL', async () => {
    const transcriptPath = path.join(testHome, 'bounded-plan.jsonl');
    const context = JSON.stringify({
      type: 'turn_context',
      payload: {
        turn_id: 'turn-bounded-plan',
        collaboration_mode: { mode: 'plan' },
      },
    });
    await fs.writeFile(
      transcriptPath,
      `${'x'.repeat(8 * 1024 * 1024 + 128)}\n${context}\n`,
      'utf-8',
    );

    await runHook({
      session_id: 'session-sqlite',
      turn_id: 'turn-bounded-plan',
      hook_event_name: 'Stop',
      transcript_path: transcriptPath,
      last_assistant_message: 'Still planning.',
      cwd: '/work/repo',
    });

    expect(received[0].title).toBe('[计划继续]');
    expect(received[0].event_key).toBe('plan-continue');
  });

  it('falls back to task completion when the transcript cannot be read', async () => {
    await runHook({
      session_id: 'session-sqlite',
      turn_id: 'turn-missing-transcript',
      hook_event_name: 'Stop',
      transcript_path: path.join(testHome, 'missing.jsonl'),
      last_assistant_message: 'Done',
      cwd: '/work/repo',
    });

    expect(received[0].title).toBe('[任务完成]');
    expect(received[0].event_key).toBe('task-complete');
  });

  it('prefers the newest JSONL rename over a stale SQLite title', async () => {
    await runHook({
      session_id: 'session-sqlite',
      turn_id: 'turn-renamed',
      hook_event_name: 'Stop',
      last_assistant_message: 'Done',
      cwd: '/work/repo',
    });

    expect(received[0].message).toMatch(/ · 重命名后的会话 · Done$/);
  });

  it('uses the newest JSONL rename when SQLite has no matching row', async () => {
    await runHook({
      session_id: 'session-json',
      turn_id: 'turn-json',
      hook_event_name: 'Stop',
      last_assistant_message: 'Done',
      cwd: '/work/repo',
    });

    expect(received[0].message).toMatch(/ · JSON回退会话 · Done$/);
  });

  it('shows the answer preview when the session has not been renamed', async () => {
    await runHook(
      {
        session_id: 'session-unrenamed',
        turn_id: 'turn-unrenamed',
        hook_event_name: 'Stop',
        last_assistant_message: '这是没有重命名的回答内容',
        cwd: '/work/repo',
      },
      { REMOTE_NOTIFIER_CODEX_PREVIEW_LENGTH: '10' },
    );

    expect(received[0].message).toMatch(/ · 这是没有重命名的回答$/);
  });

  it('honors the configured visible-character preview length', async () => {
    await runHook(
      {
        session_id: 'session-sqlite',
        turn_id: 'turn-short',
        hook_event_name: 'Stop',
        last_assistant_message: 'Done',
        cwd: '/work/repo',
      },
      { REMOTE_NOTIFIER_CODEX_PREVIEW_LENGTH: '4' },
    );

    expect(received[0].message).toMatch(/ · 重命名后 · Done$/);
  });

  it('ignores unrelated PreToolUse events', async () => {
    const result = await runHook({
      session_id: 'session-sqlite',
      turn_id: 'turn-shell',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      cwd: '/work/repo',
    });

    expect(result.exitCode).toBe(0);
    expect(received).toHaveLength(0);
  });

  it('exits successfully when the Router is unavailable', async () => {
    const result = await runHook(
      {
        session_id: 'session-sqlite',
        turn_id: 'turn-offline',
        hook_event_name: 'Stop',
        last_assistant_message: 'Done',
        cwd: '/work/repo',
      },
      {
        REMOTE_NOTIFIER_URL: 'http://127.0.0.1:1/notify',
      },
    );

    expect(result.exitCode).toBe(0);
  });

  it('retries the current session file after a VS Code reload invalidates terminal env vars', async () => {
    const sessionDirectory = path.join(testHome, '.remote-notifier');
    await fs.mkdir(sessionDirectory, { recursive: true });
    await fs.writeFile(
      path.join(sessionDirectory, 'session.json'),
      JSON.stringify({ port, token, codexPreviewLength: 16 }),
      'utf-8',
    );

    const result = await runHook(
      {
        session_id: 'session-sqlite',
        turn_id: 'turn-reloaded-window',
        hook_event_name: 'Stop',
        last_assistant_message: 'Reload recovery',
        cwd: '/work/repo',
      },
      {
        REMOTE_NOTIFIER_URL: 'http://127.0.0.1:1/notify',
        REMOTE_NOTIFIER_TOKEN: 'stale-token',
      },
    );

    expect(result.exitCode).toBe(0);
    expect(received).toHaveLength(1);
    expect(received[0].turn_id).toBe('turn-reloaded-window');
  });

  it('routes a stale terminal to the Router matching its workspace', async () => {
    const workspaceRoot = path.join(testHome, 'workspaces', 'VUDG');
    const scopedReceived: Array<Record<string, unknown>> = [];
    const staleRequests: string[] = [];
    const staleServer = http.createServer((request, response) => {
      staleRequests.push(request.url ?? '');
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end('{"ok":false}');
    });
    const stalePort = await new Promise<number>((resolve) => {
      staleServer.listen(0, '127.0.0.1', () =>
        resolve((staleServer.address() as net.AddressInfo).port),
      );
    });
    const scopedServer = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        scopedReceived.push(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
        response.writeHead(202, { 'Content-Type': 'application/json' });
        response.end('{"ok":true,"queued":true}');
      });
    });
    const scopedPort = await new Promise<number>((resolve) => {
      scopedServer.listen(0, '127.0.0.1', () =>
        resolve((scopedServer.address() as net.AddressInfo).port),
      );
    });

    try {
      const sessionDirectory = path.join(testHome, '.remote-notifier');
      const scopedDirectory = path.join(sessionDirectory, 'sessions');
      await fs.mkdir(scopedDirectory, { recursive: true });
      await fs.writeFile(
        path.join(sessionDirectory, 'session.json'),
        JSON.stringify({
          port,
          token,
          workspaceFolder: path.join(testHome, 'workspaces', 'RTL'),
          createdAt: '2026-07-15T10:00:00.000Z',
        }),
        'utf-8',
      );
      await fs.writeFile(
        path.join(scopedDirectory, 'vudg.json'),
        JSON.stringify({
          port: scopedPort,
          token: 'vudg-token',
          workspaceFolder: workspaceRoot,
          workspaceFolders: [workspaceRoot],
          createdAt: '2026-07-15T11:00:00.000Z',
          codexPreviewLength: 16,
        }),
        'utf-8',
      );

      const result = await runHook(
        {
          session_id: 'session-sqlite',
          turn_id: 'turn-vudg-window',
          hook_event_name: 'Stop',
          last_assistant_message: 'Workspace routing',
          cwd: path.join(workspaceRoot, 'src'),
        },
        {
          REMOTE_NOTIFIER_URL: `http://127.0.0.1:${stalePort}/notify`,
          REMOTE_NOTIFIER_TOKEN: 'stale-token',
        },
      );

      expect(result.exitCode).toBe(0);
      expect(staleRequests).toHaveLength(0);
      expect(received).toHaveLength(0);
      expect(scopedReceived).toHaveLength(1);
      expect(scopedReceived[0].turn_id).toBe('turn-vudg-window');
    } finally {
      await Promise.all(
        [staleServer, scopedServer].map(
          (serverToClose) => new Promise<void>((resolve) => serverToClose.close(() => resolve())),
        ),
      );
    }
  });

  async function writeTranscript(
    name: string,
    records: Array<Record<string, unknown>>,
  ): Promise<string> {
    const transcriptPath = path.join(testHome, `${name}.jsonl`);
    await fs.writeFile(
      transcriptPath,
      records.map((record) => JSON.stringify(record)).join('\n') + '\n',
      'utf-8',
    );
    return transcriptPath;
  }

  function runHook(
    payload: Record<string, unknown>,
    env: Record<string, string> = {},
  ): Promise<HookResult> {
    return runProcess(python, [hookPath], JSON.stringify(payload), {
      ...process.env,
      HOME: testHome,
      USERPROFILE: testHome,
      CODEX_HOME: codexHome,
      REMOTE_NOTIFIER_URL: `http://127.0.0.1:${port}/notify`,
      REMOTE_NOTIFIER_TOKEN: token,
      REMOTE_NOTIFIER_SESSION_FILE: '',
      REMOTE_NOTIFIER_CODEX_PREVIEW_LENGTH: '16',
      ...env,
    });
  }
});

async function runPython(script: string, args: string[]): Promise<void> {
  const result = await runProcess(python, ['-c', script, ...args], '', process.env);
  if (result.exitCode !== 0) throw new Error(result.stderr);
}

function runProcess(
  command: string,
  args: string[],
  stdin: string,
  env: NodeJS.ProcessEnv,
): Promise<HookResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
    child.stdin.end(stdin);
  });
}
