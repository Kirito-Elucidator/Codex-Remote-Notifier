import { describe, expect, it } from 'vitest';

import { parseCodexEvent } from '../../src/codex/CodexEventValidation';

describe('parseCodexEvent', () => {
  it('accepts the private sidecar invocation identity on Hook events', () => {
    expect(
      parseCodexEvent({
        version: 1,
        kind: 'hook',
        hook_event_name: 'PermissionRequest',
        invocation_id: '0123456789abcdef0123456789abcdef',
        session_id: 'thread-1',
      }),
    ).toEqual({
      ok: true,
      event: {
        version: 1,
        kind: 'hook',
        hook_event_name: 'PermissionRequest',
        invocation_id: '0123456789abcdef0123456789abcdef',
        session_id: 'thread-1',
      },
    });
  });

  it('bounds the private invocation identity like other opaque identifiers', () => {
    expect(
      parseCodexEvent({
        version: 1,
        kind: 'hook',
        hook_event_name: 'PermissionRequest',
        invocation_id: 'x'.repeat(201),
      }),
    ).toEqual({ ok: false, error: 'invocation_id must be a bounded string' });
  });
});
