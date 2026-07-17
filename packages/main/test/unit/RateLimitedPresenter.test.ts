import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { window } from 'vscode';
import { NotificationPresenter } from 'remote-notifier-shared';
import { RateLimitedPresenter } from '../../src/presenter/RateLimitedPresenter';

describe('RateLimitedPresenter', () => {
  let inner: NotificationPresenter;
  let presenter: RateLimitedPresenter;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    inner = { present: vi.fn().mockResolvedValue(undefined) };
  });

  afterEach(() => {
    presenter?.dispose();
    vi.useRealTimers();
  });

  it('forwards notifications under the limit', async () => {
    presenter = new RateLimitedPresenter(inner, 5, 15_000);
    await presenter.present({ message: 'a' });
    await presenter.present({ message: 'b' });
    await presenter.present({ message: 'c' });
    expect(inner.present).toHaveBeenCalledTimes(3);
  });

  it('allows exactly maxNotifications within the window', async () => {
    presenter = new RateLimitedPresenter(inner, 3, 15_000);
    await presenter.present({ message: '1' });
    await presenter.present({ message: '2' });
    await presenter.present({ message: '3' });
    expect(inner.present).toHaveBeenCalledTimes(3);
  });

  it('suppresses notifications beyond the limit', async () => {
    presenter = new RateLimitedPresenter(inner, 2, 15_000);
    await presenter.present({ message: '1' });
    await presenter.present({ message: '2' });
    await presenter.present({ message: '3' });
    await presenter.present({ message: '4' });
    expect(inner.present).toHaveBeenCalledTimes(2);
  });

  it('returns undefined for suppressed notifications', async () => {
    presenter = new RateLimitedPresenter(inner, 1, 15_000);
    await presenter.present({ message: 'allowed' });
    const result = await presenter.present({ message: 'suppressed' });
    expect(result).toBeUndefined();
  });

  it('shows status bar message when suppressing', async () => {
    presenter = new RateLimitedPresenter(inner, 1, 15_000);
    await presenter.present({ message: 'allowed' });
    await presenter.present({ message: 'suppressed' });
    expect(window.setStatusBarMessage).toHaveBeenCalledWith(
      expect.stringContaining('1 notification suppressed'),
      15_000,
    );
  });

  it('updates suppressed count in status bar message', async () => {
    presenter = new RateLimitedPresenter(inner, 1, 15_000);
    await presenter.present({ message: 'allowed' });
    await presenter.present({ message: 'suppressed 1' });
    await presenter.present({ message: 'suppressed 2' });
    await presenter.present({ message: 'suppressed 3' });
    expect(window.setStatusBarMessage).toHaveBeenLastCalledWith(
      expect.stringContaining('3 notifications suppressed'),
      15_000,
    );
  });

  it('resets after the time window elapses', async () => {
    presenter = new RateLimitedPresenter(inner, 2, 15_000);
    await presenter.present({ message: '1' });
    await presenter.present({ message: '2' });
    await presenter.present({ message: 'blocked' });
    expect(inner.present).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(15_000);

    await presenter.present({ message: 'allowed again' });
    expect(inner.present).toHaveBeenCalledTimes(3);
    expect(inner.present).toHaveBeenLastCalledWith({ message: 'allowed again' });
  });

  it('slides the window — old timestamps expire individually', async () => {
    presenter = new RateLimitedPresenter(inner, 2, 15_000);

    await presenter.present({ message: '1' }); // t=0
    vi.advanceTimersByTime(10_000);
    await presenter.present({ message: '2' }); // t=10s

    // t=10s: both within window, at limit
    await presenter.present({ message: 'blocked' }); // suppressed
    expect(inner.present).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(5_000); // t=15s: first timestamp expires

    await presenter.present({ message: '3' }); // allowed, only '2' in window
    expect(inner.present).toHaveBeenCalledTimes(3);
  });

  it('resets suppressed count after the window', async () => {
    presenter = new RateLimitedPresenter(inner, 1, 15_000);
    await presenter.present({ message: 'allowed' });
    await presenter.present({ message: 'suppressed' });

    vi.advanceTimersByTime(15_000);

    await presenter.present({ message: 'allowed again' });
    await presenter.present({ message: 'suppressed again' });
    expect(window.setStatusBarMessage).toHaveBeenLastCalledWith(
      expect.stringContaining('1 notification suppressed'),
      15_000,
    );
  });

  it('dispose clears timers and messages', () => {
    presenter = new RateLimitedPresenter(inner, 1, 15_000);
    presenter.dispose();
    // Should not throw
  });

  it('bypasses the global limit for distinct Codex events', async () => {
    presenter = new RateLimitedPresenter(inner, 2, 15_000);

    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        presenter.present({
          source: 'codex',
          session_id: `session-${index}`,
          turn_id: 'turn-1',
          event_key: 'task-complete',
          message: `Codex ${index}`,
        }),
      ),
    );

    expect(inner.present).toHaveBeenCalledTimes(8);
  });

  it('deduplicates immediate Codex retries but allows later events in the same turn', async () => {
    presenter = new RateLimitedPresenter(inner, 1, 15_000);
    const event = {
      source: 'codex',
      session_id: 'session-1',
      turn_id: 'turn-1',
      event_key: 'waiting-answer',
      message: 'Waiting',
    };

    await Promise.all([
      presenter.present(event),
      presenter.present(event),
      presenter.present(event),
    ]);
    await presenter.present({ ...event, turn_id: 'turn-2' });
    await presenter.present({ ...event, event_key: 'waiting-permission' });
    vi.advanceTimersByTime(2_000);
    await presenter.present(event);

    expect(inner.present).toHaveBeenCalledTimes(4);
  });

  it('allows a failed Codex event to be retried', async () => {
    vi.mocked(inner.present)
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce(undefined);
    presenter = new RateLimitedPresenter(inner, 1, 15_000);
    const event = {
      source: 'codex',
      session_id: 'session-1',
      turn_id: 'turn-1',
      event_key: 'task-complete',
      message: 'Done',
    };

    await expect(presenter.present(event)).rejects.toThrow('temporary');
    await expect(presenter.present(event)).resolves.toBeUndefined();
    expect(inner.present).toHaveBeenCalledTimes(2);
  });
});
