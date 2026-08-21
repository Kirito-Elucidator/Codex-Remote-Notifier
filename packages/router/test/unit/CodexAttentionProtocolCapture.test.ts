import { describe, expect, it } from 'vitest';

import { parseObservationExchange } from 'remote-notifier-shared/attentionExchange';
import { parseCodexReturnTarget } from 'remote-notifier-shared/codexReturnTarget';

import { CodexAttentionProtocolCapture } from '../../src/codex/CodexAttentionProtocolCapture';

describe('CodexAttentionProtocolCapture', () => {
  it('emits bounded source-neutral success observations only after primary qualification', () => {
    const capture = new CodexAttentionProtocolCapture({
      invocationId: '0123456789abcdef0123456789abcdef',
      connectionId: 'primary-connection',
      authorityEpoch: 'authority-1',
      version: 'codex-cli 0.147.2',
      primary: true,
    });

    expect(capture.observeClientText(initializeRequest(1, '0.147.2'))).toEqual([]);
    expect(capture.observeServerText(initializeResponse(1, '0.147.2'))).toEqual([]);
    expect(capture.observeClientText('{"method":"initialized"}')).toEqual([]);
    expect(
      capture.observeClientText('{"id":2,"method":"thread/start","params":{"cwd":"/repo"}}'),
    ).toEqual([]);
    expect(
      capture.observeServerText(
        '{"method":"thread/started","params":{"thread":{"id":"thread-1","sessionId":"session-root","parentThreadId":null,"source":"cli"}}}',
      ),
    ).toEqual([]);
    expect(capture.observeServerText('{"id":2,"result":{"thread":{"id":"thread-1"}}}')).toEqual([
      expect.objectContaining({
        kind: 'connection-qualification',
        sourceSequence: 1,
        initialized: true,
        primary: true,
        capabilities: 'audited',
        foregroundOwnership: 'confirmed',
        evidence: expect.objectContaining({
          runtimeVersion: '0.147.2',
          initializationRequestKey: 'number:1',
          initializationResponseKey: 'number:1',
          foregroundRequestKey: 'number:2',
          foregroundResponseKey: 'number:2',
          requestedThreadKey: 'thread-1',
          announcedThreadKey: 'thread-1',
          foregroundSessionKey: 'session-root',
        }),
      }),
    ]);
    const turnStart = capture.observeServerText(
      '{"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1"}}}',
    );
    expect(turnStart).toEqual([
      {
        kind: 'turn-start',
        sourceSequence: 2,
        turnKey: 'turn-1',
        returnTarget: expect.any(String),
      },
    ]);
    expect(
      turnStart[0].kind === 'turn-start'
        ? parseCodexReturnTarget(turnStart[0].returnTarget)
        : undefined,
    ).toEqual({ sessionId: 'thread-1' });
    expect(
      capture.observeServerText(
        '{"id":"approval-1","method":"item/fileChange/requestApproval","params":{"threadId":"thread-1","turnId":"turn-1","reason":"private"}}',
      ),
    ).toEqual([
      {
        kind: 'human-action-request',
        sourceSequence: 3,
        turnKey: 'turn-1',
        requestKey: 'string:approval-1',
        requestKind: 'approval',
      },
    ]);
    expect(
      capture.observeServerText(
        '{"id":7,"method":"execCommandApproval","params":{"command":"private"}}',
      ),
    ).toEqual([
      {
        kind: 'human-action-request',
        sourceSequence: 4,
        turnKey: 'turn-1',
        requestKey: 'number:7',
        requestKind: 'approval',
      },
    ]);
    expect(
      capture.observeServerText(
        '{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"completed","items":[{"type":"agentMessage","text":"已完成 🙂"}]}}}',
      ),
    ).toEqual([
      {
        kind: 'terminal-result',
        sourceSequence: 5,
        turnKey: 'turn-1',
        result: 'success',
        occurrenceKey: 'turn-1:success',
        canonicalTitle: 'Codex completed',
        canonicalBody: '已完成 🙂',
      },
    ]);
  });

  it('emits one ordered Compatibility transition when qualified protocol authority is lost', () => {
    const capture = qualifiedCapture();

    expect(capture.authorityLost('compatibility')).toEqual([
      { kind: 'authority-change', sourceSequence: 3, monitoring: 'compatibility' },
    ]);
    expect(capture.authorityLost('compatibility')).toEqual([]);
    expect(
      capture.observeServerText(
        '{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"completed","items":[]}}}',
      ),
    ).toEqual([]);
  });

  it('commits retry recovery silently and emits only the final plan success outcome', () => {
    const capture = qualifiedCapture();

    expect(
      capture.observeServerText(
        JSON.stringify({
          method: 'error',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            willRetry: true,
            error: {
              message: 'temporary disconnect',
              codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
            },
          },
        }),
      ),
    ).toEqual([
      {
        kind: 'retry-error',
        sourceSequence: 3,
        turnKey: 'turn-1',
        errorKind: 'responseStreamDisconnected',
        canonicalBody: 'temporary disconnect',
      },
    ]);
    for (const method of [
      'model/safetyBuffering/updated',
      'model/rerouted',
      'account/login/completed',
      'item/completed',
    ]) {
      expect(
        capture.observeServerText(
          JSON.stringify({
            method,
            params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              message: 'internal diagnostic',
            },
          }),
        ),
      ).toEqual([]);
    }
    expect(
      capture.observeServerText(
        JSON.stringify({
          method: 'turn/completed',
          params: {
            threadId: 'thread-1',
            turn: {
              id: 'turn-1',
              status: 'completed',
              items: [{ type: 'plan', text: '计划完成 🙂' }],
            },
          },
        }),
      ),
    ).toEqual([
      {
        kind: 'terminal-result',
        sourceSequence: 4,
        turnKey: 'turn-1',
        result: 'success',
        occurrenceKey: 'turn-1:success',
        canonicalTitle: 'Codex plan completed',
        canonicalBody: '计划完成 🙂',
      },
    ]);
  });

  it('stages a non-retrying error and emits one failed terminal boundary', () => {
    const capture = qualifiedCapture();

    expect(
      capture.observeServerText(
        JSON.stringify({
          method: 'error',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            willRetry: false,
            error: {
              message: 'account budget exhausted',
              codexErrorInfo: { usageLimitExceeded: null },
            },
          },
        }),
      ),
    ).toEqual([
      {
        kind: 'terminal-error',
        sourceSequence: 3,
        turnKey: 'turn-1',
        errorKind: 'usageLimitExceeded',
        canonicalBody: 'account budget exhausted',
      },
    ]);
    expect(
      capture.observeServerText(
        '{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"failed","items":[]}}}',
      ),
    ).toEqual([
      {
        kind: 'terminal-result',
        sourceSequence: 4,
        turnKey: 'turn-1',
        result: 'failure',
        occurrenceKey: 'turn-1:failure',
      },
    ]);
  });

  it('takes failure classification only from terminal structured fields', () => {
    const capture = qualifiedCapture();

    expect(
      capture.observeServerText(
        JSON.stringify({
          method: 'turn/completed',
          params: {
            threadId: 'thread-1',
            turn: {
              id: 'turn-1',
              status: 'failed',
              error: {
                message: 'usage limit exceeded and HTTP 429',
                codexErrorInfo: { futureQuotaVariant: { httpStatusCode: 429 } },
              },
              items: [],
            },
          },
        }),
      ),
    ).toEqual([
      {
        kind: 'terminal-error',
        sourceSequence: 3,
        turnKey: 'turn-1',
        errorKind: 'other',
        canonicalBody: 'usage limit exceeded and HTTP 429',
      },
      {
        kind: 'terminal-result',
        sourceSequence: 4,
        turnKey: 'turn-1',
        result: 'failure',
        occurrenceKey: 'turn-1:failure',
      },
    ]);
  });

  it('emits a structured interruption as one silent terminal observation', () => {
    const capture = qualifiedCapture();

    expect(
      capture.observeServerText(
        '{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"interrupted","items":[]}}}',
      ),
    ).toEqual([{ kind: 'interruption', sourceSequence: 3, turnKey: 'turn-1' }]);
    expect(
      capture.observeServerText(
        '{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"failed","items":[]}}}',
      ),
    ).toEqual([
      {
        kind: 'terminal-result',
        sourceSequence: 4,
        turnKey: 'turn-1',
        result: 'failure',
        occurrenceKey: 'turn-1:failure',
      },
    ]);
  });

  it('captures one structured user interruption intent before a process end', () => {
    const capture = qualifiedCapture();
    const request =
      '{"id":3,"method":"turn/interrupt","params":{"threadId":"thread-1","turnId":"turn-1"}}';

    expect(capture.observeClientText(request)).toEqual([
      { kind: 'interruption-intent', sourceSequence: 3, turnKey: 'turn-1' },
    ]);
    expect(capture.observeClientText(request)).toEqual([]);
  });

  it('retains failed-turn identity for reordered structured enrichment', () => {
    const capture = qualifiedCapture();

    expect(
      capture.observeServerText(
        '{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"failed","items":[]}}}',
      ),
    ).toEqual([
      expect.objectContaining({
        kind: 'terminal-result',
        sourceSequence: 3,
        result: 'failure',
      }),
    ]);
    expect(
      capture.observeServerText(
        JSON.stringify({
          method: 'error',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            willRetry: false,
            error: {
              message: 'Sign in again',
              codexErrorInfo: 'unauthorized',
            },
          },
        }),
      ),
    ).toEqual([
      {
        kind: 'terminal-error',
        sourceSequence: 4,
        turnKey: 'turn-1',
        errorKind: 'unauthorized',
        canonicalBody: 'Sign in again',
      },
    ]);
  });

  it('uses structured blocking metadata and emits exact request resolutions', () => {
    const capture = qualifiedCapture('0.147.0');

    expect(
      capture.observeServerText(
        '{"id":"silent","method":"item/tool/requestUserInput","params":{"threadId":"thread-1","turnId":"turn-1","isBlocking":false,"prompt":"this wording says blocking"}}',
      ),
    ).toEqual([]);
    expect(
      capture.observeServerText(
        '{"id":"automatic","method":"item/tool/requestUserInput","params":{"threadId":"thread-1","turnId":"turn-1","isBlocking":true,"autoResolutionMs":1000}}',
      ),
    ).toEqual([]);
    expect(
      capture.observeServerText(
        '{"id":7,"method":"item/tool/requestUserInput","params":{"threadId":"thread-1","turnId":"turn-1","isBlocking":true}}',
      ),
    ).toEqual([
      {
        kind: 'human-action-request',
        sourceSequence: 3,
        turnKey: 'turn-1',
        requestKey: 'number:7',
        requestKind: 'input',
      },
    ]);
    expect(
      capture.observeServerText(
        '{"id":"7","method":"item/permissions/requestApproval","params":{"threadId":"thread-1","turnId":"turn-1"}}',
      ),
    ).toEqual([
      {
        kind: 'human-action-request',
        sourceSequence: 4,
        turnKey: 'turn-1',
        requestKey: 'string:7',
        requestKind: 'permission',
      },
    ]);
    expect(
      capture.observeServerText(
        '{"method":"serverRequest/resolved","params":{"threadId":"thread-1","requestId":7}}',
      ),
    ).toEqual([
      {
        kind: 'request-resolution',
        sourceSequence: 5,
        turnKey: 'turn-1',
        requestKey: 'number:7',
      },
    ]);
    expect(
      capture.observeServerText(
        '{"method":"serverRequest/resolved","params":{"threadId":"thread-1","requestId":"7"}}',
      ),
    ).toEqual([
      {
        kind: 'request-resolution',
        sourceSequence: 6,
        turnKey: 'turn-1',
        requestKey: 'string:7',
      },
    ]);
    expect(
      capture.observeServerText(
        '{"id":"mcp-1","method":"mcpServer/elicitation/request","params":{"threadId":"thread-1"}}',
      ),
    ).toEqual([
      {
        kind: 'human-action-request',
        sourceSequence: 7,
        turnKey: 'turn-1',
        requestKey: 'string:mcp-1',
        requestKind: 'elicitation',
      },
    ]);
  });

  it('keeps automatically resolving user input silent on audited older versions', () => {
    const capture = qualifiedCapture('0.146.0');

    expect(
      capture.observeServerText(
        '{"id":"automatic","method":"item/tool/requestUserInput","params":{"threadId":"thread-1","turnId":"turn-1","autoResolutionMs":1}}',
      ),
    ).toEqual([]);
    expect(
      capture.observeServerText(
        '{"id":"blocking","method":"item/tool/requestUserInput","params":{"threadId":"thread-1","turnId":"turn-1"}}',
      ),
    ).toEqual([
      expect.objectContaining({
        kind: 'human-action-request',
        sourceSequence: 3,
        requestKey: 'string:blocking',
      }),
    ]);
  });

  it('tombstones a request resolution delivered before its attributable request', () => {
    const capture = qualifiedCapture('0.147.0');

    expect(
      capture.observeServerText(
        '{"method":"serverRequest/resolved","params":{"threadId":"thread-1","requestId":"late-input"}}',
      ),
    ).toEqual([]);
    expect(
      capture.observeServerText(
        '{"id":"late-input","method":"item/tool/requestUserInput","params":{"threadId":"thread-1","turnId":"turn-1","isBlocking":true}}',
      ),
    ).toEqual([
      {
        kind: 'request-resolution',
        sourceSequence: 3,
        turnKey: 'turn-1',
        requestKey: 'string:late-input',
      },
    ]);
    expect(
      capture.observeServerText(
        '{"id":"current-input","method":"item/tool/requestUserInput","params":{"threadId":"thread-1","turnId":"turn-1","isBlocking":true}}',
      ),
    ).toEqual([
      expect.objectContaining({
        kind: 'human-action-request',
        sourceSequence: 4,
        requestKey: 'string:current-input',
      }),
    ]);
  });

  it('reports unavailable when authority is lost without a usable Hook', () => {
    const capture = qualifiedCapture();

    expect(capture.authorityLost('unavailable')).toEqual([
      { kind: 'authority-change', sourceSequence: 3, monitoring: 'unavailable' },
    ]);
  });

  it('degrades instead of inferring ownership for a malformed exact request', () => {
    const capture = qualifiedCapture();

    expect(
      capture.observeServerText(
        '{"id":"approval-1","method":"item/fileChange/requestApproval","params":{"reason":"private"}}',
      ),
    ).toEqual([{ kind: 'authority-change', sourceSequence: 3, monitoring: 'degraded' }]);
    expect(
      capture.observeServerText(
        '{"id":"approval-2","method":"item/fileChange/requestApproval","params":{"threadId":"thread-1","turnId":"turn-1"}}',
      ),
    ).toEqual([]);

    const missingTurn = qualifiedCapture();
    expect(
      missingTurn.observeServerText(
        '{"id":"approval-3","method":"item/fileChange/requestApproval","params":{"threadId":"thread-1"}}',
      ),
    ).toEqual([{ kind: 'authority-change', sourceSequence: 3, monitoring: 'degraded' }]);
  });

  it('ends an idle invocation instead of retaining a historical fallback mode', () => {
    const capture = qualifiedCapture();
    capture.observeServerText(
      '{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"completed","items":[]}}}',
    );

    expect(capture.connectionClosed('transport-end')).toEqual([
      {
        kind: 'invocation-end',
        sourceSequence: 4,
        endKey: 'foreground-end',
        endSource: 'transport-end',
        reason: 'primary-transport-ended',
      },
    ]);
  });

  it('emits only the first stable end observation across EOF, process, and transport sources', () => {
    const capture = qualifiedCapture();

    expect(capture.connectionClosed('primary-eof', 'app-server-output-closed')).toEqual([
      {
        kind: 'connection-end',
        sourceSequence: 3,
        endKey: 'foreground-end',
        endSource: 'primary-eof',
        reason: 'app-server-output-closed',
      },
    ]);
    expect(capture.invocationEnded('foreground-tui-exit', { code: 23, signal: null })).toEqual([]);
    expect(capture.connectionClosed('transport-end')).toEqual([]);
  });

  it('continues draining a buffered terminal result after the first end observation', () => {
    const capture = qualifiedCapture();
    capture.connectionClosed('primary-eof', 'app-server-output-closed');

    expect(
      capture.observeServerText(
        '{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"completed","items":[]}}}',
      ),
    ).toEqual([
      expect.objectContaining({
        kind: 'terminal-result',
        sourceSequence: 4,
        turnKey: 'turn-1',
        result: 'success',
      }),
    ]);
  });

  it('reuses one bounded observation identity when renewing the sidecar lease', () => {
    const capture = new CodexAttentionProtocolCapture({
      invocationId: 'invocation-1',
      connectionId: 'primary',
      authorityEpoch: 'authority-1',
      version: 'codex-cli 0.147.0',
      primary: true,
    });

    const lease = capture.sidecarLease(6_000);
    expect(lease).toEqual({
      kind: 'sidecar-lease',
      sourceSequence: 1,
      leaseKey: 'foreground-sidecar',
      expiresAfterMs: 6_000,
    });
    expect(capture.sidecarLease(6_000)).toEqual(lease);
  });

  it('rejects auxiliary, unaudited, and structurally descendant observations before sequencing', () => {
    for (const capture of [
      new CodexAttentionProtocolCapture({
        invocationId: 'invocation-1',
        connectionId: 'auxiliary',
        authorityEpoch: 'authority-1',
        version: 'codex-cli 0.147.0',
        primary: false,
      }),
      new CodexAttentionProtocolCapture({
        invocationId: 'invocation-1',
        connectionId: 'primary',
        authorityEpoch: 'authority-1',
        version: 'codex-cli 0.148.0',
        primary: true,
      }),
    ]) {
      capture.observeClientText('{"id":1,"method":"initialize","params":{}}');
      capture.observeServerText('{"id":1,"result":{}}');
      expect(
        capture.observeServerText(
          '{"method":"thread/started","params":{"thread":{"id":"thread-1"}}}',
        ),
      ).toEqual([]);
    }

    const descendant = new CodexAttentionProtocolCapture({
      invocationId: 'invocation-1',
      connectionId: 'primary',
      authorityEpoch: 'authority-1',
      version: 'codex-cli 0.145.0',
      primary: true,
    });
    descendant.observeClientText(initializeRequest(1, '0.145.0'));
    descendant.observeServerText(initializeResponse(1, '0.145.0'));
    descendant.observeClientText('{"method":"initialized"}');
    descendant.observeClientText('{"id":2,"method":"thread/start","params":{}}');
    descendant.observeServerText('{"id":2,"result":{"thread":{"id":"thread-1"}}}');
    expect(
      descendant.observeServerText(
        '{"method":"thread/started","params":{"thread":{"id":"thread-1","sessionId":"session-root","parentThreadId":"parent-1","source":{"subAgent":{}}}}}',
      ),
    ).toEqual([]);
    expect(descendant.observeServerText('{"id":2,"result":{"thread":{"id":"thread-1"}}}')).toEqual(
      [],
    );

    descendant.observeClientText('{"id":3,"method":"thread/start","params":{}}');
    descendant.observeServerText(
      '{"method":"thread/started","params":{"thread":{"id":"thread-2","sessionId":"session-root","parentThreadId":null,"source":"cli"}}}',
    );
    expect(descendant.observeServerText('{"id":3,"result":{"thread":{"id":"thread-2"}}}')).toEqual([
      expect.objectContaining({ kind: 'connection-qualification', sourceSequence: 1 }),
    ]);

    const ambiguousSource = initializedCapture();
    ambiguousSource.observeClientText('{"id":2,"method":"thread/start","params":{}}');
    ambiguousSource.observeServerText(
      '{"method":"thread/started","params":{"thread":{"id":"thread-1","sessionId":"session-root","parentThreadId":null,"source":{"custom":"manual","subAgent":{}}}}}',
    );
    expect(
      ambiguousSource.observeServerText('{"id":2,"result":{"thread":{"id":"thread-1"}}}'),
    ).toEqual([]);
  });

  it('does not retrospectively qualify announcements or replace qualified foreground ownership', () => {
    const retrospective = new CodexAttentionProtocolCapture({
      invocationId: 'invocation-1',
      connectionId: 'primary',
      authorityEpoch: 'authority-1',
      version: 'codex-cli 0.147.0',
      primary: true,
    });
    retrospective.observeServerText(
      '{"method":"thread/started","params":{"thread":{"id":"thread-1","sessionId":"session-root","parentThreadId":null,"source":"cli"}}}',
    );
    retrospective.observeClientText(initializeRequest(1, '0.147.0'));
    retrospective.observeServerText(initializeResponse(1, '0.147.0'));
    retrospective.observeClientText('{"method":"initialized"}');
    retrospective.observeClientText('{"id":2,"method":"thread/start","params":{}}');
    expect(
      retrospective.observeServerText('{"id":2,"result":{"thread":{"id":"thread-1"}}}'),
    ).toEqual([]);

    const frozen = qualifiedCapture();
    frozen.observeClientText('{"id":3,"method":"thread/start","params":{}}');
    frozen.observeServerText(
      '{"method":"thread/started","params":{"thread":{"id":"thread-2","sessionId":"session-2","parentThreadId":null,"source":"cli"}}}',
    );
    expect(frozen.observeServerText('{"id":3,"result":{"thread":{"id":"thread-2"}}}')).toEqual([]);
    expect(
      frozen.observeServerText(
        '{"method":"turn/started","params":{"threadId":"thread-2","turn":{"id":"turn-2"}}}',
      ),
    ).toEqual([]);
    expect(
      frozen.observeServerText(
        '{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"completed","items":[]}}}',
      ),
    ).toEqual([expect.objectContaining({ kind: 'terminal-result', turnKey: 'turn-1' })]);
  });

  it('permits unrelated notification opt-outs while retaining the shared evidence contract', () => {
    const capture = new CodexAttentionProtocolCapture({
      invocationId: 'invocation-1',
      connectionId: 'primary',
      authorityEpoch: 'authority-1',
      version: 'codex-cli 0.147.0',
      primary: true,
    });
    capture.observeClientText(initializeRequest(1, '0.147.0', ['model/rerouted']));
    capture.observeServerText(initializeResponse(1, '0.147.0'));
    capture.observeClientText('{"method":"initialized"}');
    capture.observeClientText('{"id":2,"method":"thread/start","params":{}}');
    capture.observeServerText(
      '{"method":"thread/started","params":{"thread":{"id":"thread-1","sessionId":"session-root","parentThreadId":null,"source":"cli"}}}',
    );
    expect(capture.observeServerText('{"id":2,"result":{"thread":{"id":"thread-1"}}}')).toEqual([
      expect.objectContaining({
        kind: 'connection-qualification',
        evidence: expect.objectContaining({ optedOutNotifications: ['model/rerouted'] }),
      }),
    ]);
  });

  it('preserves numeric and string JSON-RPC request identities as distinct typed keys', () => {
    const numeric = initializedCapture();
    numeric.observeClientText('{"id":2,"method":"thread/start","params":{}}');
    numeric.observeServerText(
      '{"method":"thread/started","params":{"thread":{"id":"thread-1","sessionId":"session-root","parentThreadId":null,"source":"cli"}}}',
    );
    const [numericQualification] = numeric.observeServerText(
      '{"id":2,"result":{"thread":{"id":"thread-1"}}}',
    );

    const string = new CodexAttentionProtocolCapture({
      invocationId: 'invocation-string',
      connectionId: 'primary-string',
      authorityEpoch: 'authority-string',
      version: 'codex-cli 0.146.0',
      primary: true,
    });
    string.observeClientText(initializeRequest('1', '0.146.0'));
    string.observeServerText(initializeResponse('1', '0.146.0'));
    string.observeClientText('{"method":"initialized"}');
    string.observeClientText('{"id":"2","method":"thread/start","params":{}}');
    string.observeServerText(
      '{"method":"thread/started","params":{"thread":{"id":"thread-1","sessionId":"session-root","parentThreadId":null,"source":"cli"}}}',
    );
    const [stringQualification] = string.observeServerText(
      '{"id":"2","result":{"thread":{"id":"thread-1"}}}',
    );

    expect(numericQualification).toMatchObject({
      kind: 'connection-qualification',
      evidence: {
        initializationRequestKey: 'number:1',
        initializationResponseKey: 'number:1',
        foregroundRequestKey: 'number:2',
        foregroundResponseKey: 'number:2',
      },
    });
    expect(stringQualification).toMatchObject({
      kind: 'connection-qualification',
      evidence: {
        initializationRequestKey: 'string:1',
        initializationResponseKey: 'string:1',
        foregroundRequestKey: 'string:2',
        foregroundResponseKey: 'string:2',
      },
    });
  });

  it('does not qualify incomplete initialization or foreground ownership metadata', () => {
    for (const thread of [
      { id: 'thread-1', sessionId: 'session-root', parentThreadId: null },
      { id: 'thread-1', parentThreadId: null, source: 'cli' },
      { id: 'thread-1', sessionId: 'session-root', parentThreadId: 42, source: 'cli' },
      { id: 'thread-1', sessionId: 'session-root', parentThreadId: null, source: null },
    ]) {
      const capture = new CodexAttentionProtocolCapture({
        invocationId: 'invocation-1',
        connectionId: 'primary',
        authorityEpoch: 'authority-1',
        version: 'codex-cli 0.147.0',
        primary: true,
      });
      capture.observeClientText(initializeRequest(1, '0.147.0'));
      capture.observeServerText(initializeResponse(1, '0.147.0'));
      capture.observeClientText('{"method":"initialized"}');
      capture.observeServerText(JSON.stringify({ method: 'thread/started', params: { thread } }));
      capture.observeClientText('{"id":2,"method":"thread/start","params":{}}');
      expect(capture.observeServerText('{"id":2,"result":{"thread":{"id":"thread-1"}}}')).toEqual(
        [],
      );
    }

    for (const [request, response] of [
      [initializeRequest(1, '0.147.0'), '{"id":1,"result":{}}'],
      [initializeRequest(1, '0.147.0'), initializeResponse(1, '0.146.0')],
      [
        initializeRequest(1, '0.147.0'),
        '{"id":1,"result":{"userAgent":"not-codex/0.147.0","codexHome":"/home/test/.codex","platformFamily":"unix","platformOs":"linux"}}',
      ],
      [
        initializeRequest(1, '0.147.0'),
        JSON.stringify({
          id: 1,
          result: {
            userAgent: `codex_cli_rs/0.147.0 ${'界'.repeat(1_400)}`,
            codexHome: '/home/test/.codex',
            platformFamily: 'unix',
            platformOs: 'linux',
          },
        }),
      ],
      ['{"id":1,"method":"initialize","params":{}}', initializeResponse(1, '0.147.0')],
      [initializeRequest(1, '0.147.0', ['turn/completed']), initializeResponse(1, '0.147.0')],
    ]) {
      const capture = new CodexAttentionProtocolCapture({
        invocationId: 'invocation-1',
        connectionId: 'primary',
        authorityEpoch: 'authority-1',
        version: 'codex-cli 0.147.0',
        primary: true,
      });
      capture.observeClientText(request);
      capture.observeServerText(response);
      capture.observeClientText('{"method":"initialized"}');
      capture.observeClientText('{"id":2,"method":"thread/start","params":{}}');
      capture.observeServerText('{"id":2,"result":{"thread":{"id":"thread-1"}}}');
      expect(
        capture.observeServerText(
          '{"method":"thread/started","params":{"thread":{"id":"thread-1","sessionId":"session-root","parentThreadId":null,"source":"cli"}}}',
        ),
      ).toEqual([]);
    }
  });

  it('rejects malformed handshake responses and unroutable thread identifiers', () => {
    const malformedInitialized = initializedCapture(false);
    malformedInitialized.observeClientText('{"id":99,"method":"initialized"}');
    malformedInitialized.observeClientText('{"id":2,"method":"thread/start","params":{}}');
    malformedInitialized.observeServerText(
      '{"method":"thread/started","params":{"thread":{"id":"thread-1","sessionId":"session-root","parentThreadId":null,"source":"cli"}}}',
    );
    expect(
      malformedInitialized.observeServerText('{"id":2,"result":{"thread":{"id":"thread-1"}}}'),
    ).toEqual([]);

    const contradictoryResponse = initializedCapture();
    contradictoryResponse.observeClientText('{"id":2,"method":"thread/start","params":{}}');
    contradictoryResponse.observeServerText(
      '{"method":"thread/started","params":{"thread":{"id":"thread-1","sessionId":"session-root","parentThreadId":null,"source":"cli"}}}',
    );
    expect(
      contradictoryResponse.observeServerText(
        '{"id":2,"result":{"thread":{"id":"thread-1"}},"error":{"code":-1}}',
      ),
    ).toEqual([]);

    const unroutableThread = initializedCapture();
    unroutableThread.observeClientText('{"id":2,"method":"thread/start","params":{}}');
    unroutableThread.observeServerText(
      '{"method":"thread/started","params":{"thread":{"id":"thread.1","sessionId":"session-root","parentThreadId":null,"source":"cli"}}}',
    );
    expect(
      unroutableThread.observeServerText('{"id":2,"result":{"thread":{"id":"thread.1"}}}'),
    ).toEqual([]);
    expect(() =>
      unroutableThread.observeServerText(
        '{"method":"turn/started","params":{"threadId":"thread.1","turn":{"id":"turn-1"}}}',
      ),
    ).not.toThrow();

    const invalidUnicodeTurn = initializedCapture();
    invalidUnicodeTurn.observeClientText('{"id":2,"method":"thread/start","params":{}}');
    invalidUnicodeTurn.observeServerText(
      '{"method":"thread/started","params":{"thread":{"id":"thread-1","sessionId":"session-root","parentThreadId":null,"source":"cli"}}}',
    );
    invalidUnicodeTurn.observeServerText('{"id":2,"result":{"thread":{"id":"thread-1"}}}');
    expect(
      invalidUnicodeTurn.observeServerText(
        JSON.stringify({
          method: 'turn/started',
          params: { threadId: 'thread-1', turn: { id: '\ud800' } },
        }),
      ),
    ).toEqual([]);
    expect(
      invalidUnicodeTurn.observeServerText(
        JSON.stringify({
          method: 'turn/completed',
          params: {
            threadId: 'thread-1',
            turn: { id: '\ud800', status: 'completed', items: [] },
          },
        }),
      ),
    ).toEqual([]);
  });

  it('bounds a combining-mark preview to the source-neutral byte contract', () => {
    const capture = new CodexAttentionProtocolCapture({
      invocationId: 'invocation-1',
      connectionId: 'primary',
      authorityEpoch: 'authority-1',
      version: 'codex-cli 0.146.0',
      primary: true,
    });
    capture.observeClientText(initializeRequest(1, '0.146.0'));
    capture.observeServerText(initializeResponse(1, '0.146.0'));
    capture.observeClientText('{"method":"initialized"}');
    capture.observeClientText('{"id":2,"method":"thread/start","params":{}}');
    capture.observeServerText('{"id":2,"result":{"thread":{"id":"thread-1"}}}');
    capture.observeServerText(
      '{"method":"thread/started","params":{"thread":{"id":"thread-1","sessionId":"session-root","parentThreadId":null,"source":"cli"}}}',
    );
    capture.observeServerText(
      '{"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1"}}}',
    );
    const text = `e${'\u0301'.repeat(20_000)}`;
    const [success] = capture.observeServerText(
      JSON.stringify({
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: {
            id: 'turn-1',
            status: 'completed',
            items: [{ type: 'agentMessage', text }],
          },
        },
      }),
    );

    expect(success).toMatchObject({ kind: 'terminal-result' });
    if (success.kind !== 'terminal-result') throw new Error('expected terminal result');
    expect(Buffer.byteLength(success.canonicalBody ?? '', 'utf8')).toBeLessThanOrEqual(16_384);
    expect(() =>
      parseObservationExchange({
        kind: 'append',
        deliveryGeneration: 'delivery-1',
        scope: capture.scope,
        fromSequence: success.sourceSequence,
        observations: [success],
      }),
    ).not.toThrow();
  });

  it('falls back from a success preview with no valid Unicode scalars', () => {
    const capture = qualifiedCapture();
    const [success] = capture.observeServerText(
      JSON.stringify({
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: {
            id: 'turn-1',
            status: 'completed',
            items: [{ type: 'agentMessage', text: '\ud800\ud800' }],
          },
        },
      }),
    );

    expect(success).toEqual({
      kind: 'terminal-result',
      sourceSequence: 3,
      turnKey: 'turn-1',
      result: 'success',
      occurrenceKey: 'turn-1:success',
      canonicalTitle: 'Codex completed',
    });
  });

  it('keeps overlapping foreground turns independently observable on one connection', () => {
    const capture = qualifiedCapture();
    expect(
      capture.observeServerText(
        '{"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-2"}}}',
      ),
    ).toEqual([
      expect.objectContaining({ kind: 'turn-start', sourceSequence: 3, turnKey: 'turn-2' }),
    ]);

    expect(
      capture.observeServerText(
        '{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"completed","items":[]}}}',
      ),
    ).toEqual([
      expect.objectContaining({
        kind: 'terminal-result',
        sourceSequence: 4,
        turnKey: 'turn-1',
      }),
    ]);
    expect(
      capture.observeServerText(
        '{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-2","status":"completed","items":[]}}}',
      ),
    ).toEqual([
      expect.objectContaining({
        kind: 'terminal-result',
        sourceSequence: 5,
        turnKey: 'turn-2',
      }),
    ]);
  });
});

function initializeResponse(id: number | string, version: string): string {
  return JSON.stringify({
    id,
    result: {
      userAgent: `codex_cli_rs/${version}`,
      codexHome: '/home/test/.codex',
      platformFamily: 'unix',
      platformOs: 'linux',
    },
  });
}

function initializeRequest(id: number | string, version: string, optOut?: string[]): string {
  return JSON.stringify({
    id,
    method: 'initialize',
    params: {
      clientInfo: { name: 'codex-tui', version },
      capabilities: {
        experimentalApi: true,
        ...(optOut === undefined ? {} : { optOutNotificationMethods: optOut }),
      },
    },
  });
}

function qualifiedCapture(version = '0.146.0'): CodexAttentionProtocolCapture {
  const capture = initializedCapture(true, version);
  capture.observeClientText('{"id":2,"method":"thread/start","params":{}}');
  capture.observeServerText('{"id":2,"result":{"thread":{"id":"thread-1"}}}');
  capture.observeServerText(
    '{"method":"thread/started","params":{"thread":{"id":"thread-1","sessionId":"session-root","parentThreadId":null,"source":"cli"}}}',
  );
  capture.observeServerText(
    '{"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1"}}}',
  );
  return capture;
}

function initializedCapture(
  acknowledge = true,
  version = '0.146.0',
): CodexAttentionProtocolCapture {
  const capture = new CodexAttentionProtocolCapture({
    invocationId: 'invocation-1',
    connectionId: 'primary',
    authorityEpoch: 'authority-1',
    version: `codex-cli ${version}`,
    primary: true,
  });
  capture.observeClientText(initializeRequest(1, version));
  capture.observeServerText(initializeResponse(1, version));
  if (acknowledge) capture.observeClientText('{"method":"initialized"}');
  return capture;
}
