import { describe, expect, it, vi } from 'vitest';

import { CodexMonitoringStatus } from '../../src/codex/CodexMonitoringStatus';

describe('CodexMonitoringStatus', () => {
  it('reports Notifier unavailable before any source is observed', () => {
    const changes = vi.fn();
    const status = new CodexMonitoringStatus();

    status.setOnChange(changes);

    expect(changes).toHaveBeenCalledWith({
      monitoring: 'unavailable',
      exact: 0,
      compatibility: 0,
      unavailable: 0,
      degraded: 0,
    });
  });

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
    status.observeHook('hook-only-session', 'hook-only-invocation');

    expect(
      status.hasProtocolAuthority('private-thread-value', '11111111111111111111111111111111'),
    ).toBe(true);
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
    expect(
      status.hasProtocolAuthority('private-thread-value', '11111111111111111111111111111111'),
    ).toBe(false);
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

  it('matches exact authority by invocation and foreground identity', () => {
    const status = new CodexMonitoringStatus();
    status.update({
      invocationId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      foregroundThreadKey: 'reused-thread',
      monitoring: 'exact',
      reason: 'protocol-qualified',
    });

    expect(status.hasProtocolAuthority('reused-thread', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(
      true,
    );
    expect(status.hasProtocolAuthority('reused-thread', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')).toBe(
      false,
    );
    expect(status.hasProtocolAuthority('reused-thread')).toBe(false);

    status.observeHook('reused-thread', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    expect(status.summary()).toEqual({
      monitoring: 'compatibility',
      exact: 1,
      compatibility: 1,
      unavailable: 0,
      degraded: 0,
    });
  });

  it('keeps Hook suppressed while an established protocol authority is degraded', () => {
    const status = new CodexMonitoringStatus();
    status.update({
      invocationId: 'cccccccccccccccccccccccccccccccc',
      foregroundThreadKey: 'thread-1',
      monitoring: 'exact',
      reason: 'protocol-qualified',
    });
    status.update({
      invocationId: 'cccccccccccccccccccccccccccccccc',
      foregroundThreadKey: 'thread-1',
      monitoring: 'degraded',
      reason: 'authoritative-input-gap',
    });

    expect(status.hasProtocolAuthority('thread-1', 'cccccccccccccccccccccccccccccccc')).toBe(true);
    status.observeHook('thread-1', 'cccccccccccccccccccccccccccccccc');
    expect(status.summary()).toMatchObject({
      monitoring: 'degraded',
      degraded: 1,
      compatibility: 0,
    });
  });
});
