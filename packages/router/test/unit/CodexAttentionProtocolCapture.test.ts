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
        '{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"completed","items":[{"type":"agentMessage","text":"已完成 🙂"}]}}}',
      ),
    ).toEqual([
      {
        kind: 'terminal-result',
        sourceSequence: 3,
        turnKey: 'turn-1',
        result: 'success',
        occurrenceKey: 'turn-1:success',
        canonicalTitle: 'Codex completed',
        canonicalBody: '已完成 🙂',
      },
    ]);
  });

  it('rejects auxiliary and unaudited shapes while direct ownership wins over old ancestry', () => {
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
    ).toEqual([
      expect.objectContaining({
        kind: 'connection-qualification',
        evidence: expect.objectContaining({
          foregroundSource: 'subAgent',
          foregroundParentKey: 'parent-1',
        }),
      }),
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
    expect(
      frozen.observeServerText('{"id":3,"result":{"thread":{"id":"thread-2"}}}'),
    ).toEqual([]);
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
});

function initializeResponse(id: number, version: string): string {
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

function initializeRequest(id: number, version: string, optOut?: string[]): string {
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

function qualifiedCapture(): CodexAttentionProtocolCapture {
  const capture = initializedCapture();
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

function initializedCapture(acknowledge = true): CodexAttentionProtocolCapture {
  const capture = new CodexAttentionProtocolCapture({
    invocationId: 'invocation-1',
    connectionId: 'primary',
    authorityEpoch: 'authority-1',
    version: 'codex-cli 0.146.0',
    primary: true,
  });
  capture.observeClientText(initializeRequest(1, '0.146.0'));
  capture.observeServerText(initializeResponse(1, '0.146.0'));
  if (acknowledge) capture.observeClientText('{"method":"initialized"}');
  return capture;
}
