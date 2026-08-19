import { describe, expect, it, vi } from 'vitest';

import { CodexMonitoringStatus } from '../../src/codex/CodexMonitoringStatus';

describe('CodexMonitoringStatus', () => {
  it('tracks exact foreground ownership and summarizes mixed invocation modes', () => {
    const log = { appendLine: vi.fn() };
    const changes = vi.fn();
    const status = new CodexMonitoringStatus(log, changes);

    status.update({
      invocationId: '11111111111111111111111111111111',
      foregroundThreadKey: 'private-thread-value',
      monitoring: 'exact',
      reason: 'protocol-qualified',
    });
    status.observeHook('hook-only-session');

    expect(status.isExactForeground('private-thread-value')).toBe(true);
    expect(status.summary()).toEqual({
      monitoring: 'compatibility',
      exact: 1,
      compatibility: 1,
      unavailable: 0,
      degraded: 0,
    });
    expect(changes).toHaveBeenLastCalledWith(status.summary());
    expect(log.appendLine).toHaveBeenCalledWith(
      '[CodexAttention] invocation=11111111 monitoring=exact reason=protocol-qualified',
    );
    expect(JSON.stringify(log.appendLine.mock.calls)).not.toContain('private-thread-value');

    status.update({
      invocationId: '11111111111111111111111111111111',
      monitoring: 'degraded',
      reason: 'authoritative-input-gap',
    });
    expect(status.isExactForeground('private-thread-value')).toBe(false);
    expect(status.summary().monitoring).toBe('degraded');
  });

  it('replaces provisional Hook status when the same foreground qualifies exactly', () => {
    const status = new CodexMonitoringStatus();
    status.observeHook('thread-1');
    status.update({
      invocationId: '22222222222222222222222222222222',
      foregroundThreadKey: 'thread-1',
      monitoring: 'exact',
      reason: 'protocol-qualified',
    });

    expect(status.summary()).toEqual({
      monitoring: 'exact',
      exact: 1,
      compatibility: 0,
      unavailable: 0,
      degraded: 0,
    });
  });
});
