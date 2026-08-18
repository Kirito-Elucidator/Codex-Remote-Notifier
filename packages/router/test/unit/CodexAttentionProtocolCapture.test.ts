import { describe, expect, it } from 'vitest';

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

    expect(
      capture.observeClientText('{"id":1,"method":"initialize","params":{"clientInfo":{}}}'),
    ).toEqual([]);
    expect(
      capture.observeServerText(
        '{"method":"thread/started","params":{"thread":{"id":"thread-1","parentThreadId":null}}}',
      ),
    ).toEqual([]);
    expect(capture.observeServerText('{"id":1,"result":{"capabilities":{}}}')).toEqual([
      {
        kind: 'connection-qualification',
        sourceSequence: 1,
        initialized: true,
        primary: true,
        capabilities: 'audited',
        foregroundOwnership: 'confirmed',
      },
    ]);
    expect(
      capture.observeServerText(
        '{"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1"}}}',
      ),
    ).toEqual([
      {
        kind: 'turn-start',
        sourceSequence: 2,
        turnKey: 'turn-1',
        returnTarget: expect.any(String),
      },
    ]);
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
    descendant.observeClientText('{"id":1,"method":"initialize","params":{}}');
    descendant.observeServerText('{"id":1,"result":{}}');
    expect(
      descendant.observeServerText(
        '{"method":"thread/started","params":{"thread":{"id":"thread-1","parentThreadId":"parent-1","source":{"subAgent":true}}}}',
      ),
    ).toEqual([]);
  });
});
