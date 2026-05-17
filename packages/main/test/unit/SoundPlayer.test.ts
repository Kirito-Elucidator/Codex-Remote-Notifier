import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as cp from 'child_process';
import { SoundPlayer, PlayerRegistry } from '../../src/presenter/SoundPlayer';

vi.mock('child_process', () => ({
  exec: vi.fn((cmd, cb) => cb(null)),
  execSync: vi.fn(),
}));

describe('SoundPlayer', () => {
  let player: SoundPlayer;

  beforeEach(() => {
    vi.clearAllMocks();
    player = new SoundPlayer();
  });

  it('uses custom player if provided, bypassing detection', async () => {
    await player.play('/path/to/sound.wav', 'my-player "${file}"');
    expect(cp.exec).toHaveBeenCalledWith(
      expect.stringContaining('my-player'),
      expect.any(Function),
    );
    expect(cp.execSync).not.toHaveBeenCalled();
  });

  it('detects and uses a player if no custom player provided', async () => {
    vi.mocked(cp.execSync).mockReturnValue(Buffer.from('/usr/bin/paplay'));

    // Force a platform where we have multiple players to test detection
    Object.defineProperty(process, 'platform', { value: 'linux' });

    await player.play('/path/to/sound.wav');

    expect(cp.execSync).toHaveBeenCalled();
    expect(cp.exec).toHaveBeenCalled();
  });

  it('replaces ${file} placeholder in custom player command', async () => {
    await player.play('/path/to/sound.wav', 'mpg123 ${file}');
    expect(cp.exec).toHaveBeenCalledWith(expect.stringContaining('mpg123'), expect.any(Function));
    expect(cp.exec).toHaveBeenCalledWith(
      expect.stringContaining('/path/to/sound.wav'),
      expect.any(Function),
    );
  });

  it('appends path if no placeholder in custom player command', async () => {
    await player.play('/path/to/sound.wav', 'mpg123');
    expect(cp.exec).toHaveBeenCalledWith(
      expect.stringContaining('mpg123 "/path/to/sound.wav"'),
      expect.any(Function),
    );
  });
});
