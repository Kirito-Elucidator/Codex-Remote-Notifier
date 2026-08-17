import { describe, expect, it } from 'vitest';

import { CodexProtocolCapture, JsonLineFramer } from '../../src/codex/CodexProtocolCapture';

describe('JsonLineFramer', () => {
  it('preserves half lines and split UTF-8 code points', () => {
    const framer = new JsonLineFramer();
    const bytes = Buffer.from('{"message":"中文"}\n{"second":true}\npartial', 'utf-8');
    const split = bytes.indexOf(Buffer.from('文')) + 1;

    expect(framer.push(bytes.subarray(0, split))).toEqual([]);
    expect(framer.push(bytes.subarray(split))).toEqual(['{"message":"中文"}', '{"second":true}']);
    expect(framer.end()).toEqual(['partial']);
  });

  it('rejects a malformed UTF-8 frame without interpreting a partial JSON object', () => {
    const framer = new JsonLineFramer();
    const prefix = Buffer.from('{"message":"accepted-prefix', 'utf-8');
    const malformed = Buffer.from([0xc3, 0x28]);
    const suffix = Buffer.from('"}\n', 'utf-8');

    expect(() => framer.push(Buffer.concat([prefix, malformed, suffix]))).toThrow(
      /malformed UTF-8/i,
    );
  });
});

describe('CodexProtocolCapture', () => {
  const ancestry = [101, 202];

  it('marks a session ready only after a thread is actually established', () => {
    const capture = new CodexProtocolCapture('instance-1', ancestry);

    expect(capture.threadEstablished).toBe(false);
    capture.observeServerMessage({ id: 1, result: { userAgent: 'codex-cli' } });
    expect(capture.threadEstablished).toBe(false);
    capture.observeServerMessage({
      method: 'thread/started',
      params: { thread: { id: 'thread-1' } },
    });
    expect(capture.threadEstablished).toBe(true);
  });

  it('whitelists request identity without forwarding questions, commands, prompts, or tokens', () => {
    const capture = new CodexProtocolCapture('instance-1', ancestry);
    const events = capture.observeServerMessage({
      id: 17,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        questions: [{ question: 'private question' }],
        token: 'private-token',
      },
    });

    expect(events).toEqual([
      {
        version: 1,
        kind: 'protocol',
        method: 'item/tool/requestUserInput',
        instance_id: 'instance-1',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        request_id: 17,
        process_ancestry: ancestry,
      },
    ]);
    expect(JSON.stringify(events)).not.toContain('private');
  });

  it('keeps every distinct request id and resolves client responses without answering', () => {
    const capture = new CodexProtocolCapture('instance-1', ancestry);
    const first = capture.observeServerMessage({
      id: 'approval-1',
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-1', command: 'secret' },
    });
    const second = capture.observeServerMessage({
      id: 'approval-2',
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-1', command: 'secret' },
    });
    const resolved = capture.observeClientMessage({
      id: 'approval-1',
      result: { decision: 'accept' },
    });

    expect(first[0].request_id).toBe('approval-1');
    expect(second[0].request_id).toBe('approval-2');
    expect(resolved).toEqual([
      expect.objectContaining({
        method: 'serverRequest/resolved',
        request_id: 'approval-1',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
      }),
    ]);
    expect(capture.observeClientMessage({ id: 'approval-1', result: {} })).toEqual([]);
  });

  it('captures MCP elicitation even though its protocol params have no thread fields', () => {
    const capture = new CodexProtocolCapture('instance-1', ancestry);
    const withoutContext = capture.observeServerMessage({
      id: 'mcp-before-thread',
      method: 'mcpServer/elicitation/request',
      params: {
        mode: 'form',
        message: 'private MCP prompt',
        requestedSchema: { type: 'object' },
      },
    });

    capture.observeServerMessage({
      method: 'turn/started',
      params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
    });
    const withinTurn = capture.observeServerMessage({
      id: 'mcp-in-turn',
      method: 'mcpServer/elicitation/request',
      params: { mode: 'url', message: 'private MCP prompt', url: 'https://private.test' },
    });

    expect(withoutContext).toEqual([
      expect.objectContaining({
        method: 'mcpServer/elicitation/request',
        request_id: 'mcp-before-thread',
      }),
    ]);
    expect(withoutContext[0]).not.toHaveProperty('thread_id');
    expect(withinTurn).toEqual([
      expect.objectContaining({
        method: 'mcpServer/elicitation/request',
        request_id: 'mcp-in-turn',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
      }),
    ]);
    expect(JSON.stringify([...withoutContext, ...withinTurn])).not.toContain('private');
  });

  it('captures safety transitions and retry metadata only', () => {
    const capture = new CodexProtocolCapture('instance-1', ancestry);
    const safety = capture.observeServerMessage({
      method: 'model/safetyBuffering/updated',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        showBufferingUi: true,
        reasons: ['sensitive internal reason'],
        model: 'private-model',
      },
    });
    const error = capture.observeServerMessage({
      method: 'error',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        willRetry: true,
        error: {
          message: 'connection failed',
          codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } },
          additionalDetails: 'private diagnostics',
        },
      },
    });

    expect(safety[0]).toMatchObject({
      method: 'model/safetyBuffering/updated',
      show_buffering_ui: true,
    });
    expect(JSON.stringify(safety)).not.toContain('sensitive');
    expect(error[0]).toMatchObject({
      method: 'error',
      occurrence_id: 'error-1',
      will_retry: true,
      error: {
        message: 'connection failed',
        code: 'httpConnectionFailed',
        http_status_code: 503,
      },
    });
    expect(JSON.stringify(error)).not.toContain('private diagnostics');

    const repeatedError = capture.observeServerMessage({
      method: 'error',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        willRetry: true,
        error: {
          message: 'connection failed',
          codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } },
        },
      },
    });
    expect(repeatedError[0].occurrence_id).toBe('error-2');
  });

  it('normalizes every Codex 0.145 error-info variant from the wire', () => {
    const capture = new CodexProtocolCapture('instance-1', ancestry);
    const variants: Array<{
      info: unknown;
      code: string;
      httpStatusCode?: number;
    }> = [
      { info: 'contextWindowExceeded', code: 'contextWindowExceeded' },
      { info: 'sessionBudgetExceeded', code: 'sessionBudgetExceeded' },
      { info: 'usageLimitExceeded', code: 'usageLimitExceeded' },
      { info: 'serverOverloaded', code: 'serverOverloaded' },
      { info: 'cyberPolicy', code: 'cyberPolicy' },
      {
        info: { httpConnectionFailed: { httpStatusCode: 429 } },
        code: 'httpConnectionFailed',
        httpStatusCode: 429,
      },
      {
        info: { responseStreamConnectionFailed: { httpStatusCode: 503 } },
        code: 'responseStreamConnectionFailed',
        httpStatusCode: 503,
      },
      { info: 'internalServerError', code: 'internalServerError' },
      { info: 'unauthorized', code: 'unauthorized' },
      { info: 'badRequest', code: 'badRequest' },
      { info: 'threadRollbackFailed', code: 'threadRollbackFailed' },
      { info: 'sandboxError', code: 'sandboxError' },
      {
        info: { responseStreamDisconnected: { httpStatusCode: null } },
        code: 'responseStreamDisconnected',
      },
      {
        info: { responseTooManyFailedAttempts: { httpStatusCode: 502 } },
        code: 'responseTooManyFailedAttempts',
        httpStatusCode: 502,
      },
      {
        info: { activeTurnNotSteerable: { turnKind: 'review' } },
        code: 'activeTurnNotSteerable',
      },
      { info: 'other', code: 'other' },
    ];

    for (const variant of variants) {
      const [event] = capture.observeServerMessage({
        method: 'error',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          willRetry: false,
          error: {
            message: 'visible error',
            codexErrorInfo: variant.info,
            additionalDetails: 'private diagnostics',
          },
        },
      });
      expect(event.error).toEqual({
        message: 'visible error',
        code: variant.code,
        ...(variant.httpStatusCode ? { http_status_code: variant.httpStatusCode } : {}),
      });
      expect(JSON.stringify(event)).not.toContain('private diagnostics');
    }
  });

  it('extracts only the final visible result and structured plan from turn completion', () => {
    const capture = new CodexProtocolCapture('instance-1', ancestry);
    const [event] = capture.observeServerMessage({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-1',
          status: 'completed',
          error: null,
          items: [
            {
              type: 'userMessage',
              content: [{ type: 'text', text: 'private user prompt' }],
            },
            { type: 'commandExecution', command: 'private command', aggregatedOutput: 'secret' },
            { type: 'plan', text: '# Public completion plan' },
            { type: 'agentMessage', text: 'Final answer' },
          ],
        },
      },
    });

    expect(event).toMatchObject({
      method: 'turn/completed',
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      status: 'completed',
      preview: '# Public completion plan',
      plan_complete: true,
    });
    expect(JSON.stringify(event)).not.toContain('private');
    expect(JSON.stringify(event)).not.toContain('secret');
  });

  it('captures thread metadata without the prompt-derived thread preview', () => {
    const capture = new CodexProtocolCapture('instance-1', ancestry);
    const [event] = capture.observeServerMessage({
      method: 'thread/started',
      params: {
        thread: {
          id: 'thread-1',
          name: 'Renamed session',
          cwd: 'C:/work/repo',
          preview: 'private first user prompt',
        },
      },
    });

    expect(event).toMatchObject({
      method: 'thread/started',
      thread_id: 'thread-1',
      session_title: 'Renamed session',
      cwd: 'C:/work/repo',
    });
    expect(JSON.stringify(event)).not.toContain('private first user prompt');
  });

  it('ignores malformed, unmonitored, and incomplete messages', () => {
    const capture = new CodexProtocolCapture('instance-1', ancestry);
    expect(capture.observeServerText('{invalid')).toEqual([]);
    expect(capture.observeServerMessage({ method: 'item/agentMessage/delta', params: {} })).toEqual(
      [],
    );
    expect(
      capture.observeServerMessage({
        id: 1,
        method: 'item/fileChange/requestApproval',
        params: { turnId: 'missing-thread' },
      }),
    ).toEqual([]);
  });
});
