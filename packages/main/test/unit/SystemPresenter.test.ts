import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as notifier from 'node-notifier';
import { setMockConfig, clearMockConfig } from 'vscode';
import { SystemPresenter } from '../../src/presenter/SystemPresenter';
import { SoundPlayer } from '../../src/presenter/SoundPlayer';
import * as shared from 'remote-notifier-shared';

vi.mock('../../src/presenter/SoundPlayer');
vi.mock('remote-notifier-shared', async () => {
  const actual = (await vi.importActual('remote-notifier-shared')) as any;
  return {
    ...actual,
    fileExists: vi.fn(),
  };
});

describe('SystemPresenter', () => {
  let presenter: SystemPresenter;
  let playSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();
    clearMockConfig();
    presenter = new SystemPresenter();
    playSpy = vi.spyOn(SoundPlayer.prototype, 'play');
    vi.mocked(shared.fileExists).mockResolvedValue(true);
  });

  it('calls notifier.notify with sound: true by default on non-linux', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    await presenter.present({ message: 'Build done', title: 'CI' });
    expect(notifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        sound: true,
      }),
      expect.any(Function),
    );
    expect(playSpy).not.toHaveBeenCalled();
  });

  it('uses SoundPlayer for bundled sound on linux by default', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    await presenter.present({ message: 'Build done', title: 'CI' });
    expect(notifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        sound: false,
      }),
      expect.any(Function),
    );
    expect(playSpy).toHaveBeenCalledWith(expect.stringContaining('notification.wav'), '');
  });

  it('uses SoundPlayer for custom sound path', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    setMockConfig('remoteNotifier.notificationSoundPath', '/custom/sound.mp3');
    await presenter.present({ message: 'Build done' });

    expect(notifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({ sound: false }),
      expect.any(Function),
    );
    expect(playSpy).toHaveBeenCalledWith('/custom/sound.mp3', '');
  });

  it('passes custom player to SoundPlayer', async () => {
    setMockConfig('remoteNotifier.notificationSoundPath', '/custom/sound.mp3');
    setMockConfig('remoteNotifier.notificationSoundPlayer', 'mpg123');
    await presenter.present({ message: 'Build done' });

    expect(playSpy).toHaveBeenCalledWith('/custom/sound.mp3', 'mpg123');
  });

  describe('sound mappings', () => {
    it('uses mapped sound path when payload sound key matches', async () => {
      setMockConfig('remoteNotifier.soundMappings', { success: '/custom/success.wav' });
      await presenter.present({ message: 'test', sound: 'success' });
      expect(playSpy).toHaveBeenCalledWith('/custom/success.wav', '');
    });

    it('falls back to global sound path when sound key is not in mappings', async () => {
      setMockConfig('remoteNotifier.notificationSoundPath', '/global/sound.mp3');
      setMockConfig('remoteNotifier.soundMappings', { success: '/custom/success.wav' });
      await presenter.present({ message: 'test', sound: 'unknown' });
      expect(playSpy).toHaveBeenCalledWith('/global/sound.mp3', '');
    });

    it('falls back to default behavior when sound key is not in mappings and no global path', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      setMockConfig('remoteNotifier.soundMappings', { success: '/custom/success.wav' });
      await presenter.present({ message: 'test', sound: 'unknown' });
      expect(notifier.notify).toHaveBeenCalledWith(
        expect.objectContaining({ sound: true }),
        expect.any(Function),
      );
      expect(playSpy).not.toHaveBeenCalled();
    });

    it('falls back when mapped sound path does not exist', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      setMockConfig('remoteNotifier.soundMappings', { success: '/non-existent.wav' });
      vi.mocked(shared.fileExists).mockResolvedValue(false);

      await presenter.present({ message: 'test', sound: 'success' });

      expect(notifier.notify).toHaveBeenCalledWith(
        expect.objectContaining({ sound: true }),
        expect.any(Function),
      );
      expect(playSpy).not.toHaveBeenCalled();
    });
  });

  it('disables sound when notificationSound is false', async () => {
    setMockConfig('remoteNotifier.notificationSound', false);
    await presenter.present({ message: 'Build done' });

    expect(notifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({ sound: false }),
      expect.any(Function),
    );
    expect(playSpy).not.toHaveBeenCalled();
  });

  it('uses "Remote Notifier" as default title when none provided', async () => {
    await presenter.present({ message: 'Hello' });
    expect(notifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Remote Notifier' }),
      expect.any(Function),
    );
  });

  it('passes the message as-is', async () => {
    await presenter.present({ message: 'Special chars: <>&"\'\\n' });
    expect(notifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Special chars: <>&"\'\\n' }),
      expect.any(Function),
    );
  });

  it('returns immediately without waiting', async () => {
    const result = await presenter.present({ message: 'test' });
    expect(result).toBeUndefined();
  });

  it('does not throw when notifier throws', async () => {
    vi.mocked(notifier.notify).mockImplementation(() => {
      throw new Error('notifier failed');
    });
    await expect(presenter.present({ message: 'test' })).resolves.toBeUndefined();
  });

  describe('icon mappings', () => {
    it('uses mapped icon path when payload icon key matches', async () => {
      setMockConfig('remoteNotifier.iconMappings', { claude: '/custom/claude-icon.png' });
      await presenter.present({ message: 'test', icon: 'claude' });
      expect(notifier.notify).toHaveBeenCalledWith(
        expect.objectContaining({ icon: '/custom/claude-icon.png' }),
        expect.any(Function),
      );
    });

    it('falls back to default icon when icon key is not in mappings', async () => {
      setMockConfig('remoteNotifier.iconMappings', { claude: '/custom/claude-icon.png' });
      await presenter.present({ message: 'test', icon: 'unknown' });
      expect(notifier.notify).toHaveBeenCalledWith(
        expect.objectContaining({ icon: expect.stringContaining('icon-transparent.png') }),
        expect.any(Function),
      );
    });

    it('falls back when mapped icon path does not exist', async () => {
      setMockConfig('remoteNotifier.iconMappings', { claude: '/non-existent.png' });
      vi.mocked(shared.fileExists).mockResolvedValue(false);

      await presenter.present({ message: 'test', icon: 'claude' });

      expect(notifier.notify).toHaveBeenCalledWith(
        expect.objectContaining({ icon: expect.stringContaining('icon-transparent.png') }),
        expect.any(Function),
      );
    });

    it('falls back to default icon when no icon key in payload', async () => {
      setMockConfig('remoteNotifier.iconMappings', { claude: '/custom/claude-icon.png' });
      await presenter.present({ message: 'test' });
      expect(notifier.notify).toHaveBeenCalledWith(
        expect.objectContaining({ icon: expect.stringContaining('icon-transparent.png') }),
        expect.any(Function),
      );
    });

    it('falls back to default icon when iconMappings is empty', async () => {
      await presenter.present({ message: 'test', icon: 'claude' });
      expect(notifier.notify).toHaveBeenCalledWith(
        expect.objectContaining({ icon: expect.stringContaining('icon-transparent.png') }),
        expect.any(Function),
      );
    });
  });
});
