import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CodexErrorCode, CodexProtocolEvent, NotificationPayload } from 'remote-notifier-shared';

import {
  classifyCodexError,
  CodexEventHandler,
  sanitizeUpstreamError,
} from '../../src/codex/CodexEventHandler';
import { CodexMetadataResolver } from '../../src/codex/CodexMetadataResolver';
import { Configuration } from '../../src/config/Configuration';
import { NotificationHandler } from '../../src/handler/NotificationHandler';

describe('CodexEventHandler', () => {
  let delivered: NotificationPayload[];
  let notifications: {
    handle: ReturnType<typeof vi.fn>;
    trackCodexSession: ReturnType<typeof vi.fn>;
  };
  let metadata: {
    resolvePreviewParts: ReturnType<typeof vi.fn>;
    readTranscript: ReturnType<typeof vi.fn>;
  };
  let handler: CodexEventHandler;

  beforeEach(() => {
    delivered = [];
    notifications = {
      handle: vi.fn(async (payload: NotificationPayload) => {
        delivered.push(payload);
        return { ok: true, id: 'notification-1' };
      }),
      trackCodexSession: vi.fn().mockResolvedValue(undefined),
    };
    metadata = {
      resolvePreviewParts: vi.fn(
        async (_sessionId: string, _cwd: string, answer: string | undefined) => ({
          sessionTitle: 'Session title',
          answer,
          cwdName: 'repo',
        }),
      ),
      readTranscript: vi.fn().mockResolvedValue({
        isPlanMode: false,
        hasPlanItem: false,
        completionObserved: true,
      }),
    };
    handler = new CodexEventHandler(
      notifications as unknown as NotificationHandler,
      { codexPreviewLength: 32 } as Configuration,
      metadata as unknown as CodexMetadataResolver,
    );
  });

  afterEach(() => {
    handler.dispose();
  });

  it('notifies only on safety UI off-to-on transitions for the active turn', async () => {
    await handler.handle(protocol('turn/started'));
    await handler.handle(protocol('model/safetyBuffering/updated', { show_buffering_ui: true }));
    await handler.handle(protocol('model/safetyBuffering/updated', { show_buffering_ui: true }));
    await handler.handle(protocol('model/safetyBuffering/updated', { show_buffering_ui: false }));
    await handler.handle(protocol('model/safetyBuffering/updated', { show_buffering_ui: true }));
    await handler.handle(protocol('turn/started', { turn_id: 'turn-2' }));
    await handler.handle(
      protocol('model/safetyBuffering/updated', {
        turn_id: 'turn-2',
        show_buffering_ui: true,
      }),
    );
    await handler.handle(
      protocol('model/safetyBuffering/updated', {
        turn_id: 'turn-1',
        show_buffering_ui: true,
      }),
    );

    expect(delivered.map((payload) => payload.title)).toEqual([
      '[等待安全检查]',
      '[等待安全检查]',
      '[等待安全检查]',
    ]);
    expect(delivered.every((payload) => payload.level === 'warning')).toBe(true);
  });

  it('retries a repeated safety transition when the first presentation failed', async () => {
    await handler.handle(protocol('turn/started'));
    const buffering = protocol('model/safetyBuffering/updated', {
      show_buffering_ui: true,
    });
    notifications.handle.mockResolvedValueOnce({
      ok: false,
      error: 'presenter_error',
      details: 'temporary disconnect',
    });

    await expect(handler.handle(buffering)).rejects.toThrow('temporary disconnect');
    await handler.handle(buffering);

    expect(delivered).toEqual([
      expect.objectContaining({
        title: '[等待安全检查]',
      }),
    ]);
  });

  it('delivers every distinct request id and suppresses only replays of the same id', async () => {
    await handler.handle(protocol('turn/started'));
    await handler.handle(protocol('item/tool/requestUserInput', { request_id: 'request-1' }));
    await handler.handle(protocol('item/tool/requestUserInput', { request_id: 'request-1' }));
    await handler.handle(protocol('item/tool/requestUserInput', { request_id: 'request-2' }));
    await handler.handle(protocol('serverRequest/resolved', { request_id: 'request-1' }));
    await handler.handle(protocol('item/tool/requestUserInput', { request_id: 'request-1' }));

    expect(delivered).toHaveLength(2);
    expect(delivered.map((payload) => payload.event_key)).toEqual([
      'request:instance-1:string:request-1',
      'request:instance-1:string:request-2',
    ]);
  });

  it('does not suppress a request replay when the first presentation failed', async () => {
    const request = protocol('item/tool/requestUserInput', { request_id: 'request-retry' });
    notifications.handle.mockResolvedValueOnce({
      ok: false,
      error: 'presenter_error',
      details: 'temporary disconnect',
    });

    await expect(handler.handle(request)).rejects.toThrow('temporary disconnect');
    await handler.handle(request);

    expect(delivered).toEqual([
      expect.objectContaining({
        event_key: 'request:instance-1:string:request-retry',
      }),
    ]);
  });

  it('treats numeric and string JSON-RPC ids as distinct requests', async () => {
    await handler.handle(protocol('item/tool/requestUserInput', { request_id: 1 }));
    await handler.handle(protocol('item/tool/requestUserInput', { request_id: '1' }));

    expect(delivered).toHaveLength(2);
    expect(new Set(delivered.map((payload) => payload.event_key)).size).toBe(2);
  });

  it('bounds notification metadata for maximum-length request ids', async () => {
    await handler.handle(protocol('item/tool/requestUserInput', { request_id: 'x'.repeat(200) }));

    expect(delivered[0].event_key).toHaveLength(199);
  });

  it.each([
    ['item/tool/requestUserInput', '[等待回答]'],
    ['item/commandExecution/requestApproval', '[等待命令授权]'],
    ['item/fileChange/requestApproval', '[等待文件授权]'],
    ['item/permissions/requestApproval', '[等待权限确认]'],
    ['mcpServer/elicitation/request', '[等待 MCP 回答]'],
    ['applyPatchApproval', '[等待文件授权]'],
    ['execCommandApproval', '[等待命令授权]'],
  ] as const)('maps %s to its own attention title', async (method, title) => {
    await handler.handle(
      protocol(method, {
        request_id: `request-${method}`,
        ...(method === 'mcpServer/elicitation/request' ? { turn_id: undefined } : {}),
      }),
    );
    expect(delivered[0].title).toBe(title);
  });

  it('delivers a context-free MCP elicitation instead of dropping it', async () => {
    await handler.handle(
      protocol('mcpServer/elicitation/request', {
        request_id: 'mcp-global',
        thread_id: undefined,
        turn_id: undefined,
      }),
    );

    expect(delivered).toEqual([
      expect.objectContaining({
        title: '[等待 MCP 回答]',
        event_key: 'request:instance-1:string:mcp-global',
      }),
    ]);
  });

  it('notifies a retryable error immediately and still reports eventual success', async () => {
    await handler.handle(protocol('turn/started'));
    await handler.handle(
      protocol('error', {
        occurrence_id: 'error-1',
        will_retry: true,
        error: { message: 'temporary disconnect', code: 'responseStreamDisconnected' },
      }),
    );
    await handler.handle(
      protocol('turn/completed', {
        status: 'completed',
        preview: 'Recovered successfully',
      }),
    );

    expect(delivered).toHaveLength(2);
    expect(delivered[0]).toMatchObject({
      title: '[网络错误]',
      level: 'error',
    });
    expect(delivered[0].event_key).toBe('protocol-error:instance-1:error-1');
    expect(delivered[1]).toMatchObject({
      title: '[任务完成]',
      event_key: 'task-complete',
    });
  });

  it('suppresses transport replays of one error occurrence and its terminal confirmation', async () => {
    const retryable = protocol('error', {
      occurrence_id: 'error-replayed',
      will_retry: true,
      error: { message: 'temporary disconnect', code: 'responseStreamDisconnected' },
    });
    await handler.handle(protocol('turn/started'));
    await handler.handle(retryable);
    await handler.handle(retryable);
    await handler.handle(
      protocol('turn/completed', {
        status: 'failed',
        error: { message: 'temporary disconnect', code: 'responseStreamDisconnected' },
      }),
    );

    expect(delivered).toHaveLength(1);
    expect(delivered[0].title).toBe('[网络错误]');
  });

  it('notifies every new occurrence even when the official error text is identical', async () => {
    await handler.handle(protocol('turn/started'));
    for (const occurrenceId of ['error-1', 'error-2', 'error-3']) {
      await handler.handle(
        protocol('error', {
          occurrence_id: occurrenceId,
          will_retry: true,
          error: {
            message:
              'stream disconnected before completion: stream closed before response.completed',
            code: 'responseStreamDisconnected',
          },
        }),
      );
    }

    expect(delivered).toHaveLength(3);
    expect(delivered.map((payload) => payload.event_key)).toEqual([
      'protocol-error:instance-1:error-1',
      'protocol-error:instance-1:error-2',
      'protocol-error:instance-1:error-3',
    ]);
  });

  it('treats identical legacy error events without occurrence ids as separate appearances', async () => {
    const legacyError = protocol('error', {
      will_retry: true,
      error: {
        message: "We're currently experiencing high demand, which may cause temporary errors.",
        code: 'internalServerError',
      },
    });
    await handler.handle(protocol('turn/started'));
    await handler.handle(legacyError);
    await handler.handle(legacyError);

    expect(delivered).toHaveLength(2);
    expect(delivered.map((payload) => payload.event_key)).toEqual([
      'protocol-error:instance-1:legacy-1',
      'protocol-error:instance-1:legacy-2',
    ]);
  });

  it('does not add an unknown failure after an alerted retry when completion has no details', async () => {
    await handler.handle(protocol('turn/started'));
    await handler.handle(
      protocol('error', {
        occurrence_id: 'error-1',
        will_retry: true,
        error: { message: 'temporary disconnect', code: 'responseStreamDisconnected' },
      }),
    );
    await handler.handle(protocol('turn/completed', { status: 'failed' }));

    expect(delivered).toHaveLength(1);
    expect(delivered[0].title).toBe('[网络错误]');
  });

  it('notifies again when a retry changes to a distinct visible error state', async () => {
    await handler.handle(protocol('turn/started'));
    await handler.handle(
      protocol('error', {
        occurrence_id: 'error-network',
        will_retry: true,
        error: { message: 'temporary disconnect', code: 'responseStreamDisconnected' },
      }),
    );
    await handler.handle(
      protocol('error', {
        occurrence_id: 'error-demand',
        will_retry: true,
        error: {
          message: "We're currently experiencing high demand, which may cause temporary errors.",
          code: 'internalServerError',
        },
      }),
    );

    expect(delivered.map((payload) => payload.title)).toEqual(['[网络错误]', '[模型服务错误]']);
  });

  it('retries an immediate error notification when the first presentation failed', async () => {
    const retryable = protocol('error', {
      occurrence_id: 'error-retry',
      will_retry: true,
      error: { message: 'temporary disconnect', code: 'responseStreamDisconnected' },
    });
    await handler.handle(protocol('turn/started'));
    notifications.handle.mockResolvedValueOnce({
      ok: false,
      error: 'presenter_error',
      details: 'temporary disconnect',
    });

    await expect(handler.handle(retryable)).rejects.toThrow('temporary disconnect');
    await handler.handle(retryable);

    expect(delivered).toEqual([
      expect.objectContaining({
        title: '[网络错误]',
      }),
    ]);
  });

  it('reports a terminal error immediately and does not repeat it at failed completion', async () => {
    await handler.handle(protocol('turn/started'));
    await handler.handle(
      protocol('error', {
        occurrence_id: 'error-terminal',
        will_retry: false,
        error: {
          message: 'Bearer super-secret disconnected at https://x.test/?token=secret',
          code: 'httpConnectionFailed',
        },
      }),
    );
    await handler.handle(
      protocol('turn/completed', {
        status: 'failed',
        error: { message: 'same terminal failure', code: 'httpConnectionFailed' },
      }),
    );

    expect(delivered).toHaveLength(1);
    expect(delivered[0].title).toBe('[网络错误]');
    expect(delivered[0].message).not.toContain('super-secret');
    expect(delivered[0].message).not.toContain('token=secret');
  });

  it('uses failed completion to retry a terminal notification that could not be presented', async () => {
    await handler.handle(protocol('turn/started'));
    notifications.handle.mockResolvedValueOnce({
      ok: false,
      error: 'presenter_error',
      details: 'temporary disconnect',
    });

    await expect(
      handler.handle(
        protocol('error', {
          occurrence_id: 'error-failed-delivery',
          will_retry: false,
          error: { message: 'connection lost', code: 'httpConnectionFailed' },
        }),
      ),
    ).rejects.toThrow('temporary disconnect');
    await handler.handle(
      protocol('turn/completed', {
        status: 'failed',
        error: { message: 'connection lost', code: 'httpConnectionFailed' },
      }),
    );

    expect(delivered).toEqual([
      expect.objectContaining({
        title: '[网络错误]',
        event_key: 'terminal-error:turn-1',
      }),
    ]);
  });

  it('uses failed completion as the terminal notification when no error event was emitted', async () => {
    await handler.handle(protocol('turn/started'));
    await handler.handle(
      protocol('turn/completed', {
        status: 'failed',
        error: { message: 'model overloaded', code: 'serverOverloaded' },
      }),
    );
    expect(delivered).toEqual([
      expect.objectContaining({
        title: '[模型服务错误]',
        level: 'error',
      }),
    ]);
  });

  it('reports an unknown terminal failure when failed completion has no details', async () => {
    await handler.handle(protocol('turn/started'));
    await handler.handle(protocol('turn/completed', { status: 'failed' }));

    expect(delivered).toEqual([
      expect.objectContaining({
        title: '[Codex 错误]',
        level: 'error',
      }),
    ]);
  });

  it('recognizes a standardized stream-disconnect message when Codex reports code other', async () => {
    await handler.handle(protocol('turn/started'));
    await handler.handle(
      protocol('turn/completed', {
        status: 'failed',
        error: {
          message: 'stream disconnected before completion: stream closed before response.completed',
          code: 'other',
        },
      }),
    );

    expect(delivered).toEqual([
      expect.objectContaining({
        title: '[网络错误]',
        level: 'error',
      }),
    ]);
  });

  it('reports a persisted terminal error even when Codex never invokes the Stop Hook', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rn-codex-transcript-watch-'));
    const transcriptPath = path.join(directory, 'rollout.jsonl');
    try {
      await fs.writeFile(transcriptPath, '{"type":"session_meta","payload":{}}\n', 'utf-8');
      await handler.handle({
        version: 1,
        kind: 'hook',
        hook_event_name: 'UserPromptSubmit',
        session_id: 'hook-session',
        turn_id: 'hook-error-turn',
        transcript_path: transcriptPath,
        cwd: directory,
        process_ancestry: [101, 202],
      });

      await fs.appendFile(
        transcriptPath,
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            turn_id: 'hook-error-turn',
            error: {
              message:
                'stream disconnected before completion: stream closed before response.completed',
              codex_error_info: 'other',
            },
          },
        }) + '\n',
        'utf-8',
      );

      await vi.waitFor(
        () => {
          expect(delivered).toEqual([
            expect.objectContaining({
              title: '[网络错误]',
              level: 'error',
              event_key: 'terminal-error:hook-error-turn',
            }),
          ]);
        },
        { timeout: 3000 },
      );
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('rehydrates terminal error handling after a Router restart without lifecycle history', async () => {
    await handler.handle(
      protocol('error', {
        will_retry: false,
        error: {
          message: 'stream disconnected before completion: stream closed before response.completed',
          code: 'responseStreamDisconnected',
        },
      }),
    );

    expect(delivered).toEqual([
      expect.objectContaining({
        title: '[网络错误]',
        event_key: 'protocol-error:instance-1:legacy-1',
      }),
    ]);
  });

  it('extracts and classifies a nested provider error without exposing its JSON envelope', async () => {
    await handler.handle(protocol('turn/started'));
    await handler.handle(
      protocol('turn/completed', {
        status: 'failed',
        error: {
          message: JSON.stringify({
            type: 'error',
            status: 400,
            request_id: 'private-request-id',
            error: {
              type: 'invalid_request_error',
              message:
                "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.",
            },
          }),
          code: 'other',
        },
      }),
    );

    expect(delivered).toEqual([
      expect.objectContaining({
        title: '[模型不可用]',
        level: 'error',
      }),
    ]);
    expect(delivered[0].message).toContain(
      "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.",
    );
    expect(delivered[0].message).not.toContain('private-request-id');
    expect(delivered[0].message).not.toContain('invalid_request_error');
  });

  it('does not turn user interruption into a completion notification', async () => {
    await handler.handle(protocol('turn/started'));
    await handler.handle(protocol('turn/completed', { status: 'interrupted' }));
    expect(delivered).toHaveLength(0);
  });

  it('distinguishes structured plan completion and ignores duplicate completion replay', async () => {
    await handler.handle(protocol('turn/started'));
    const completed = protocol('turn/completed', {
      status: 'completed',
      preview: '# Final plan',
      plan_complete: true,
    });
    await handler.handle(completed);
    await handler.handle(completed);
    expect(delivered).toEqual([
      expect.objectContaining({
        title: '[计划完成]',
        event_key: 'plan-complete',
      }),
    ]);
  });

  it('does not suppress a completion replay when the first presentation failed', async () => {
    await handler.handle(protocol('turn/started'));
    const completed = protocol('turn/completed', {
      status: 'completed',
      preview: 'Recovered delivery',
    });
    notifications.handle.mockResolvedValueOnce({
      ok: false,
      error: 'presenter_error',
      details: 'temporary disconnect',
    });

    await expect(handler.handle(completed)).rejects.toThrow('temporary disconnect');
    await handler.handle(completed);

    expect(delivered).toEqual([
      expect.objectContaining({
        title: '[任务完成]',
        event_key: 'task-complete',
      }),
    ]);
  });

  it('ignores late safety and error events after a turn has completed', async () => {
    await handler.handle(protocol('turn/started'));
    await handler.handle(protocol('turn/completed', { status: 'completed' }));
    await handler.handle(protocol('model/safetyBuffering/updated', { show_buffering_ui: true }));
    await handler.handle(
      protocol('error', {
        will_retry: false,
        error: { message: 'late failure', code: 'other' },
      }),
    );

    expect(delivered).toHaveLength(1);
    expect(delivered[0].title).toBe('[任务完成]');
  });

  it('retries a Hook request replay when the first presentation failed', async () => {
    const request = {
      version: 1 as const,
      kind: 'hook' as const,
      hook_event_name: 'PermissionRequest' as const,
      session_id: 'hook-session',
      turn_id: 'hook-turn',
      request_id: 'hook-request',
    };
    notifications.handle.mockResolvedValueOnce({
      ok: false,
      error: 'presenter_error',
      details: 'temporary disconnect',
    });

    await expect(handler.handle(request)).rejects.toThrow('temporary disconnect');
    await handler.handle(request);
    await handler.handle(request);

    expect(delivered).toEqual([
      expect.objectContaining({
        title: '[等待授权]',
        event_key: 'waiting-permission:hook-request',
      }),
    ]);
  });

  it('ignores Hook presentation for protocol-authoritative sessions but still tracks focus', async () => {
    await handler.handle({
      version: 1,
      kind: 'hook',
      hook_event_name: 'PermissionRequest',
      session_id: 'thread-1',
      turn_id: 'turn-1',
      protocol_authoritative: true,
      process_ancestry: [11, 22],
    });

    expect(delivered).toHaveLength(0);
    expect(notifications.trackCodexSession).toHaveBeenCalledWith('thread-1', [11, 22]);
  });

  it('restores Hook fallback after the protocol sidecar session ends', async () => {
    await handler.handle(protocol('thread/started', { turn_id: undefined }));
    await handler.handle(
      protocol('session/ended', {
        thread_id: undefined,
        turn_id: undefined,
      }),
    );
    await handler.handle({
      version: 1,
      kind: 'hook',
      hook_event_name: 'PermissionRequest',
      session_id: 'thread-1',
      turn_id: 'fallback-turn',
      request_id: 'fallback-request',
    });

    expect(delivered).toHaveLength(1);
    expect(delivered[0].event_key).toBe('waiting-permission:fallback-request');
  });

  it('waits for a late persisted Hook failure instead of reporting task completion', async () => {
    vi.useFakeTimers();
    try {
      metadata.readTranscript
        .mockResolvedValueOnce({
          isPlanMode: false,
          hasPlanItem: false,
          completionObserved: false,
          lastAssistantMessage: 'A partial answer',
        })
        .mockResolvedValueOnce({
          isPlanMode: false,
          hasPlanItem: false,
          completionObserved: true,
          terminalError: {
            message:
              'stream disconnected before completion: stream closed before response.completed',
            code: 'other',
          },
        });

      const pending = handler.handle({
        version: 1,
        kind: 'hook',
        hook_event_name: 'Stop',
        session_id: 'hook-session',
        turn_id: 'hook-turn',
        transcript_path: 'rollout.jsonl',
      });
      await vi.runAllTimersAsync();
      await pending;

      expect(metadata.readTranscript).toHaveBeenCalledTimes(2);
      expect(delivered).toEqual([
        expect.objectContaining({
          title: '[网络错误]',
          event_key: 'terminal-error:hook-turn',
        }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses an ordinary SessionStart to recover from a missing sidecar end event', async () => {
    await handler.handle(protocol('thread/started', { turn_id: undefined }));
    await handler.handle({
      version: 1,
      kind: 'hook',
      hook_event_name: 'SessionStart',
      session_id: 'thread-1',
    });
    await handler.handle({
      version: 1,
      kind: 'hook',
      hook_event_name: 'PermissionRequest',
      session_id: 'thread-1',
      turn_id: 'fallback-turn',
      request_id: 'fallback-request',
    });

    expect(delivered).toHaveLength(1);
  });
});

describe('Codex terminal error classification', () => {
  it.each([
    ['usageLimitExceeded', '[额度不足]'],
    ['sessionBudgetExceeded', '[额度不足]'],
    ['contextWindowExceeded', '[上下文已满]'],
    ['unauthorized', '[登录失效]'],
    ['httpConnectionFailed', '[网络错误]'],
    ['responseStreamConnectionFailed', '[网络错误]'],
    ['responseStreamDisconnected', '[网络错误]'],
    ['responseTooManyFailedAttempts', '[网络错误]'],
    ['serverOverloaded', '[模型服务错误]'],
    ['internalServerError', '[模型服务错误]'],
    ['sandboxError', '[沙箱或策略错误]'],
    ['cyberPolicy', '[沙箱或策略错误]'],
    ['badRequest', '[请求或配置错误]'],
    ['threadRollbackFailed', '[会话恢复失败]'],
    ['activeTurnNotSteerable', '[Codex 状态冲突]'],
    ['other', '[Codex 错误]'],
  ] as Array<[CodexErrorCode, string]>)('maps %s', (code, title) => {
    expect(classifyCodexError(code).title).toBe(title);
  });

  it.each([
    [401, '[登录失效]'],
    [403, '[登录失效]'],
    [402, '[额度不足]'],
    [413, '[上下文已满]'],
    [429, '[额度不足]'],
    [500, '[模型服务错误]'],
    [503, '[模型服务错误]'],
    [400, '[请求或配置错误]'],
    [404, '[请求或配置错误]'],
    [422, '[请求或配置错误]'],
    [407, '[网络错误]'],
    [408, '[网络错误]'],
    [425, '[网络错误]'],
    [499, '[网络错误]'],
  ] as Array<[number, string]>)('refines connection failures with HTTP %s', (status, title) => {
    expect(classifyCodexError('httpConnectionFailed', status).title).toBe(title);
  });

  it.each([
    [
      'stream disconnected before completion: stream closed before response.completed',
      '[网络错误]',
    ],
    ['Transport error: network error: error decoding response body', '[网络错误]'],
    ['reconnect attempts exhausted after unexpected EOF', '[网络错误]'],
    ['failed to fetch: ECONNRESET', '[网络错误]'],
    ['TLS certificate verification failed', '[网络错误]'],
    ['Your input exceeds the context window for this model', '[上下文已满]'],
    ['Too many requests: usage limit exceeded; add credits to continue', '[额度不足]'],
    ['authentication failed because the access token expired', '[登录失效]'],
    ['The requested model is not supported for this account', '[模型不可用]'],
    ['You do not have access to the model on your current plan', '[模型不可用]'],
    ['Selected model is at capacity. Please try a different model.', '[模型服务错误]'],
    [
      "We're currently experiencing high demand, which may cause temporary errors.",
      '[模型服务错误]',
    ],
    ['service unavailable: upstream server error', '[模型服务错误]'],
    ['incomplete response reason=max_output_tokens', '[响应长度受限]'],
    ['invalid_request_error: unsupported parameter', '[请求或配置错误]'],
    ['blocked by security policy', '[沙箱或策略错误]'],
    ['thread rollback failed', '[会话恢复失败]'],
    ['active turn is not steerable', '[Codex 状态冲突]'],
    ['unclassified failure', '[Codex 错误]'],
  ])('classifies unstructured terminal message %s', (message, title) => {
    expect(classifyCodexError('other', undefined, message).title).toBe(title);
  });

  it('uses embedded HTTP status when structured Codex error information is unavailable', () => {
    expect(classifyCodexError('other', 401, 'provider rejected the request').title).toBe(
      '[登录失效]',
    );
    expect(classifyCodexError('other', 429, 'provider rejected the request').title).toBe(
      '[额度不足]',
    );
    expect(classifyCodexError('other', 502, 'provider rejected the request').title).toBe(
      '[模型服务错误]',
    );
  });

  it('does not let message inference override a specific structured error code', () => {
    expect(
      classifyCodexError('sandboxError', undefined, 'stream disconnected before completion').title,
    ).toBe('[沙箱或策略错误]');
  });

  it('extracts the visible message from JSON provider errors', () => {
    const sanitized = sanitizeUpstreamError(
      JSON.stringify({
        status: '400',
        request_id: 'private-request-id',
        error: {
          type: 'invalid_request_error',
          message: 'The selected model is not supported.',
        },
      }),
    );
    expect(sanitized).toBe('The selected model is not supported.');
  });

  it('cleans control sequences, credentials, whitespace, and long upstream messages', () => {
    const sanitized = sanitizeUpstreamError(
      `\u001b[31mBearer abc.def\u001b[0m\n sk-1234567890 ` +
        `https://user:password@example.test/path?access_token=top-secret&api_key=also-secret ` +
        `Authorization: Bearer header-secret ${'x'.repeat(500)}`,
    );
    expect(sanitized).not.toContain('\u001b');
    expect(sanitized).not.toContain('abc.def');
    expect(sanitized).not.toContain('sk-1234567890');
    expect(sanitized).not.toContain('user:password');
    expect(sanitized).not.toContain('top-secret');
    expect(sanitized).not.toContain('also-secret');
    expect(sanitized).not.toContain('header-secret');
    expect([...sanitized].length).toBeLessThanOrEqual(240);
  });
});

function protocol(
  method: CodexProtocolEvent['method'],
  overrides: Partial<CodexProtocolEvent> = {},
): CodexProtocolEvent {
  return {
    version: 1,
    kind: 'protocol',
    method,
    instance_id: 'instance-1',
    thread_id: 'thread-1',
    turn_id: 'turn-1',
    ...overrides,
  };
}
