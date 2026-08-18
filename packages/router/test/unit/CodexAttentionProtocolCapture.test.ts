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
    expect(
      capture.observeServerText(
        '{"method":"thread/started","params":{"thread":{"id":"thread-1","parentThreadId":null,"source":"cli"}}}',
      ),
    ).toEqual([]);
    expect(capture.observeServerText(initializeResponse(1, '0.147.2'))).toEqual([]);
    expect(capture.observeClientText('{"method":"initialized"}')).toEqual([]);
    expect(
      capture.observeClientText('{"id":2,"method":"thread/start","params":{"cwd":"/repo"}}'),
    ).toEqual([]);
    expect(capture.observeServerText('{"id":2,"result":{"thread":{"id":"thread-1"}}}')).toEqual([
      {
        kind: 'connection-qualification',
        sourceSequence: 1,
        initialized: true,
        primary: true,
        capabilities: 'audited',
        foregroundOwnership: 'confirmed',
      },
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

  it('rejects auxiliary, unaudited, and descendant protocol shapes before sequencing', () => {
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
        '{"method":"thread/started","params":{"thread":{"id":"thread-1","parentThreadId":"parent-1","source":{"subAgent":true}}}}',
      ),
    ).toEqual([]);
  });

  it('does not qualify incomplete initialization or foreground ownership metadata', () => {
    for (const thread of [
      { id: 'thread-1', parentThreadId: null },
      { id: 'thread-1', parentThreadId: 'parent-1', source: 'cli' },
      { id: 'thread-1', parentThreadId: null, source: { subAgent: {} } },
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
          '{"method":"thread/started","params":{"thread":{"id":"thread-1","parentThreadId":null,"source":"cli"}}}',
        ),
      ).toEqual([]);
    }
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
      '{"method":"thread/started","params":{"thread":{"id":"thread-1","parentThreadId":null,"source":"cli"}}}',
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
    '{"method":"thread/started","params":{"thread":{"id":"thread-1","parentThreadId":null,"source":"cli"}}}',
  );
  capture.observeServerText(
    '{"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1"}}}',
  );
  return capture;
}
