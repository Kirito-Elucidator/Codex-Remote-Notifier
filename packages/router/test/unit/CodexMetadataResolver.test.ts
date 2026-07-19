import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cleanVisibleText,
  CodexMetadataResolver,
  truncateVisible,
} from '../../src/codex/CodexMetadataResolver';

describe('CodexMetadataResolver', () => {
  let testDirectory: string;
  let codexHome: string;

  beforeEach(async () => {
    testDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'rn-codex-metadata-'));
    codexHome = path.join(testDirectory, '.codex');
    await fs.mkdir(codexHome, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDirectory, { recursive: true, force: true });
  });

  it('reads only the bounded transcript tail and correlates plan data to the current turn', async () => {
    const transcript = path.join(testDirectory, 'rollout.jsonl');
    const currentContext = {
      type: 'turn_context',
      payload: { turn_id: 'turn-current', collaboration_mode: { mode: 'plan' } },
    };
    const currentPlan = {
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        turn_id: 'turn-current',
        item: { type: 'Plan', text: '# Current plan' },
      },
    };
    const oldError = {
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'turn-old',
        error: { message: 'old failure' },
      },
    };
    await fs.writeFile(
      transcript,
      `${'x'.repeat(8 * 1024 * 1024 + 128)}\n{malformed\n${JSON.stringify(
        oldError,
      )}\n${JSON.stringify(currentContext)}\n${JSON.stringify(currentPlan)}\n`,
      'utf-8',
    );

    const resolver = new CodexMetadataResolver(codexHome);
    await expect(resolver.readTranscript(transcript, 'turn-current')).resolves.toEqual({
      isPlanMode: true,
      hasPlanItem: true,
      completionObserved: false,
      planText: '# Current plan',
    });
  });

  it('finds persisted task_complete.error after the Hook has returned', async () => {
    const transcript = path.join(testDirectory, 'failure.jsonl');
    await fs.writeFile(
      transcript,
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-failed',
          last_agent_message: 'Partial answer',
          error: {
            message: 'stream disconnected',
            codex_error_info: {
              response_stream_disconnected: { httpStatusCode: 502 },
            },
          },
        },
      }) + '\n',
      'utf-8',
    );

    const resolver = new CodexMetadataResolver(codexHome);
    expect(await resolver.readTranscript(transcript, 'turn-failed')).toMatchObject({
      completionObserved: true,
      lastAssistantMessage: 'Partial answer',
      terminalError: {
        message: 'stream disconnected',
        code: 'responseStreamDisconnected',
        http_status_code: 502,
      },
    });
  });

  it('normalizes legacy and snake-case HTTP error shapes from persisted transcripts', async () => {
    const transcript = path.join(testDirectory, 'legacy-failures.jsonl');
    await fs.writeFile(
      transcript,
      [
        {
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            turn_id: 'turn-legacy',
            error: {
              message: 'rate limited',
              codex_error_info: {
                type: 'HttpConnectionFailed',
                http_status_code: 429,
              },
            },
          },
        },
        {
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            turn_id: 'turn-snake',
            error: {
              message: 'service unavailable',
              codex_error_info: {
                response_stream_connection_failed: { http_status_code: 503 },
              },
            },
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n') + '\n',
      'utf-8',
    );

    const resolver = new CodexMetadataResolver(codexHome);
    await expect(resolver.readTranscript(transcript, 'turn-legacy')).resolves.toMatchObject({
      terminalError: {
        code: 'httpConnectionFailed',
        http_status_code: 429,
      },
    });
    await expect(resolver.readTranscript(transcript, 'turn-snake')).resolves.toMatchObject({
      terminalError: {
        code: 'responseStreamConnectionFailed',
        http_status_code: 503,
      },
    });
  });

  it('prefers the newest session index rename and falls back to an async SQLite query', async () => {
    await fs.writeFile(
      path.join(codexHome, 'session_index.jsonl'),
      [
        JSON.stringify({ id: 'thread-index', thread_name: 'Old title' }),
        JSON.stringify({ id: 'thread-index', thread_name: 'Newest title' }),
      ].join('\n') + '\n',
      'utf-8',
    );
    await fs.writeFile(path.join(codexHome, 'state_5.sqlite'), 'placeholder', 'utf-8');
    const sqlite = vi.fn().mockResolvedValue('SQLite fallback');
    const resolver = new CodexMetadataResolver(codexHome, sqlite);

    expect(await resolver.readSessionTitle('thread-index')).toBe('Newest title');
    expect(sqlite).not.toHaveBeenCalled();
    expect(await resolver.readSessionTitle('thread-sqlite')).toBe('SQLite fallback');
    expect(sqlite).toHaveBeenCalledWith([path.join(codexHome, 'state_5.sqlite')], 'thread-sqlite');
  });
});

describe('Codex visible text helpers', () => {
  it('removes ANSI/control text and collapses whitespace', () => {
    expect(cleanVisibleText('\u001b[31mHello\u001b[0m\n\tworld\u0000')).toBe('Hello world');
  });

  it('truncates by grapheme rather than splitting combining characters or emoji', () => {
    expect(truncateVisible('A\u0301B🙂C', 3)).toBe('A\u0301B🙂');
  });
});
