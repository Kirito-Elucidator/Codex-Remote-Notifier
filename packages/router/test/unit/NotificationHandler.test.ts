import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotificationPresenter } from 'remote-notifier-shared';
import { NotificationHandler } from '../../src/handler/NotificationHandler';
import { Configuration } from '../../src/config/Configuration';

describe('NotificationHandler', () => {
  const focusCommand = `remoteNotifier.focusCodexSession.${'a'.repeat(32)}`;
  let mockPresenter: NotificationPresenter;
  let mockConfig: Configuration;
  let terminalFocus: { track: ReturnType<typeof vi.fn> };
  let handler: NotificationHandler;

  beforeEach(() => {
    mockPresenter = {
      present: vi.fn().mockResolvedValue(undefined),
    };
    mockConfig = {
      enabled: true,
      port: 0,
      maxBodySize: 65536,
      notificationLevel: 'information',
      showTimestamp: false,
    } as unknown as Configuration;
    terminalFocus = { track: vi.fn().mockResolvedValue(undefined) };
    handler = new NotificationHandler(
      mockPresenter,
      mockConfig,
      terminalFocus as never,
      focusCommand,
    );
  });

  describe('valid payloads', () => {
    it('handles payload with all fields', async () => {
      const payload = {
        message: 'Hello',
        title: 'Test',
        level: 'warning' as const,
      };
      const result = await handler.handle(payload);
      expect(result.ok).toBe(true);
      expect(result.id).toMatch(/^notif_[0-9a-f]{16}$/);
      expect(mockPresenter.present).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Hello', level: 'warning' }),
      );
    });

    it('handles payload with display_hint', async () => {
      const payload = { message: 'Hello', display_hint: 'system' as const };
      const result = await handler.handle(payload);
      expect(result.ok).toBe(true);
      expect(mockPresenter.present).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Hello', display_hint: 'system' }),
      );
    });

    it('handles payload with display_hint app', async () => {
      const payload = { message: 'Hello', display_hint: 'app' as const };
      const result = await handler.handle(payload);
      expect(result.ok).toBe(true);
      expect(mockPresenter.present).toHaveBeenCalledWith(
        expect.objectContaining({ display_hint: 'app' }),
      );
    });

    it('handles payload with icon key', async () => {
      const payload = { message: 'Hello', icon: 'claude' };
      const result = await handler.handle(payload);
      expect(result.ok).toBe(true);
      expect(mockPresenter.present).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Hello', icon: 'claude' }),
      );
    });

    it('handles payload with only message', async () => {
      const result = await handler.handle({ message: 'Hello' });
      expect(result.ok).toBe(true);
      expect(mockPresenter.present).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Hello', level: 'information' }),
      );
    });

    it('forwards Codex deduplication metadata', async () => {
      const payload = {
        message: 'Done',
        source: 'codex',
        session_id: 'session-1',
        turn_id: 'turn-1',
        event_key: 'task-complete',
      };
      expect((await handler.handle(payload)).ok).toBe(true);
      expect(mockPresenter.present).toHaveBeenCalledWith(expect.objectContaining(payload));
    });

    it('tracks Codex process ancestry without forwarding process IDs to the UI extension', async () => {
      const payload = {
        message: 'Done',
        source: 'codex',
        session_id: 'session-1',
        turn_id: 'turn-1',
        event_key: 'task-complete',
        process_ancestry: [9000, 8000, 7000],
      };

      expect((await handler.handle(payload)).ok).toBe(true);
      expect(terminalFocus.track).toHaveBeenCalledWith('session-1', [9000, 8000, 7000]);
      expect(mockPresenter.present).toHaveBeenCalledWith(
        expect.objectContaining({
          codex_focus_command: focusCommand,
        }),
      );
      expect(mockPresenter.present).toHaveBeenCalledWith(
        expect.not.objectContaining({ process_ancestry: expect.anything() }),
      );
    });

    it('overwrites an untrusted focus command with the Router instance command', async () => {
      await handler.handle({
        message: 'Done',
        source: 'codex',
        session_id: 'session-1',
        codex_focus_command: 'workbench.action.closeWindow',
      });

      expect(mockPresenter.present).toHaveBeenCalledWith(
        expect.objectContaining({ codex_focus_command: focusCommand }),
      );
    });

    it('defaults level to config value', async () => {
      (mockConfig as { notificationLevel: string }).notificationLevel = 'error';
      handler = new NotificationHandler(mockPresenter, mockConfig);
      await handler.handle({ message: 'test' });
      expect(mockPresenter.present).toHaveBeenCalledWith(
        expect.objectContaining({ level: 'error' }),
      );
    });
  });

  describe('timestamp', () => {
    it('prepends timestamp when showTimestamp is true', async () => {
      (mockConfig as { showTimestamp: boolean }).showTimestamp = true;
      handler = new NotificationHandler(mockPresenter, mockConfig);
      await handler.handle({ message: 'test' });
      const call = vi.mocked(mockPresenter.present).mock.calls[0][0];
      expect(call.message).toMatch(/^\[\d{4}-\d{2}-\d{2}T.*\] test$/);
    });

    it('does not prepend timestamp when showTimestamp is false', async () => {
      await handler.handle({ message: 'test' });
      const call = vi.mocked(mockPresenter.present).mock.calls[0][0];
      expect(call.message).toBe('test');
    });
  });

  describe('validation errors', () => {
    it('rejects non-object payload', async () => {
      const result = await handler.handle('string');
      expect(result.ok).toBe(false);
      expect(result.error).toBe('validation_error');
    });

    it('rejects null payload', async () => {
      const result = await handler.handle(null);
      expect(result.ok).toBe(false);
      expect(result.error).toBe('validation_error');
    });

    it('rejects missing message', async () => {
      const result = await handler.handle({});
      expect(result.ok).toBe(false);
      expect(result.details).toContain('message is required');
    });

    it('rejects empty message', async () => {
      const result = await handler.handle({ message: '' });
      expect(result.ok).toBe(false);
      expect(result.details).toContain('message is required');
    });

    it('rejects message exceeding 1000 chars', async () => {
      const result = await handler.handle({ message: 'x'.repeat(1001) });
      expect(result.ok).toBe(false);
      expect(result.details).toContain('maximum length');
    });

    it('accepts message at exactly 1000 chars', async () => {
      const result = await handler.handle({ message: 'x'.repeat(1000) });
      expect(result.ok).toBe(true);
    });

    it('rejects title exceeding 100 chars', async () => {
      const result = await handler.handle({ message: 'hi', title: 'x'.repeat(101) });
      expect(result.ok).toBe(false);
      expect(result.details).toContain('title');
    });

    it('rejects non-string title', async () => {
      const result = await handler.handle({ message: 'hi', title: 123 });
      expect(result.ok).toBe(false);
      expect(result.details).toContain('title must be a string');
    });

    it('rejects invalid level', async () => {
      const result = await handler.handle({ message: 'hi', level: 'critical' });
      expect(result.ok).toBe(false);
      expect(result.details).toContain('level must be one of');
    });

    it('rejects invalid display_hint', async () => {
      const result = await handler.handle({ message: 'hi', display_hint: 'other' });
      expect(result.ok).toBe(false);
      expect(result.details).toContain('display_hint must be one of');
    });

    it('rejects non-string display_hint', async () => {
      const result = await handler.handle({ message: 'hi', display_hint: 123 });
      expect(result.ok).toBe(false);
      expect(result.details).toContain('display_hint must be one of');
    });

    it('rejects non-string icon', async () => {
      const result = await handler.handle({ message: 'hi', icon: 123 });
      expect(result.ok).toBe(false);
      expect(result.details).toContain('icon must be a string');
    });

    it('rejects icon exceeding 50 chars', async () => {
      const result = await handler.handle({ message: 'hi', icon: 'x'.repeat(51) });
      expect(result.ok).toBe(false);
      expect(result.details).toContain('icon exceeds maximum length');
    });

    it('rejects invalid Codex metadata', async () => {
      const result = await handler.handle({ message: 'hi', session_id: 123 });
      expect(result.ok).toBe(false);
      expect(result.details).toContain('session_id must be a string');
    });

    it('rejects malformed process ancestry', async () => {
      const notAnArray = await handler.handle({ message: 'hi', process_ancestry: '123' });
      expect(notAnArray.details).toContain('process_ancestry must be an array');

      const invalidPid = await handler.handle({ message: 'hi', process_ancestry: [123, -1] });
      expect(invalidPid.details).toContain('positive integers');

      const tooLong = await handler.handle({
        message: 'hi',
        process_ancestry: Array.from({ length: 25 }, (_, index) => index + 1),
      });
      expect(tooLong.details).toContain('maximum length');
    });
  });

  describe('presenter errors', () => {
    it('returns error response when presenter throws', async () => {
      vi.mocked(mockPresenter.present).mockRejectedValue(new Error('display failed'));
      const result = await handler.handle({ message: 'test' });
      expect(result.ok).toBe(false);
      expect(result.error).toBe('presenter_error');
      expect(result.details).toBe('display failed');
    });
  });
});
