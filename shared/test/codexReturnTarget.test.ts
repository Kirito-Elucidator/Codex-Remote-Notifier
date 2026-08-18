import { describe, expect, it } from 'vitest';

import { createCodexReturnTarget, parseCodexReturnTarget } from '../codexReturnTarget';

describe('Codex return targets', () => {
  it('round-trips only the bounded routing fields needed by Main clients', () => {
    const originCommand = `remoteNotifier.focusCodexSession.${'a'.repeat(32)}`;
    const encoded = createCodexReturnTarget({
      originCommand,
      sessionId: 'session_local-1',
    });

    expect(parseCodexReturnTarget(encoded)).toEqual({
      originCommand,
      sessionId: 'session_local-1',
    });
    expect(JSON.parse(encoded)).toEqual({
      version: 1,
      sessionId: 'session_local-1',
      originCommand,
    });
  });

  it('rejects malformed and unexpected routing data', () => {
    expect(parseCodexReturnTarget('{"version":1,"sessionId":""}')).toBeUndefined();
    expect(
      parseCodexReturnTarget(
        JSON.stringify({ version: 1, sessionId: 'safe', prompt: 'private prompt' }),
      ),
    ).toBeUndefined();
    expect(() =>
      createCodexReturnTarget({
        originCommand: 'workbench.action.closeWindow',
        sessionId: 'safe',
      }),
    ).toThrow('Invalid Codex return target');
  });
});
