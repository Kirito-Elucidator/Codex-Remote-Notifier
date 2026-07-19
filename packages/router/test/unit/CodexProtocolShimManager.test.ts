import * as fs from 'fs/promises';

import * as shared from 'remote-notifier-shared';
import { createMockExtensionContext } from 'vscode';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CodexProtocolShimManager } from '../../src/installer/CodexProtocolShimManager';

vi.mock('fs/promises');
vi.mock('remote-notifier-shared');

describe('CodexProtocolShimManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(shared.fileExists).mockResolvedValue(true);
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    vi.mocked(fs.chmod).mockResolvedValue(undefined);
    vi.mocked(fs.unlink).mockResolvedValue(undefined);
  });

  it('installs both shims and prepends the private directory for new terminals', async () => {
    const context = createMockExtensionContext();
    const manager = new CodexProtocolShimManager(context as never);

    await manager.enable();

    expect(fs.mkdir).toHaveBeenCalledWith(manager.shimDirectory, {
      recursive: true,
      mode: 0o700,
    });
    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/codex-shim[\\/]codex$/),
      expect.stringContaining('if command -v node'),
      { mode: 0o755 },
    );
    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/codex-shim[\\/]codex\.cmd$/),
      expect.stringMatching(
        /where\.exe node\.exe[\s\S]+if errorlevel 1 goto electron_node[\s\S]+node\.exe [\s\S]+codex-notifier-sidecar\.js/,
      ),
      { mode: 0o755 },
    );
    expect(context.environmentVariableCollection.delete).toHaveBeenCalledWith('PATH');
    expect(context.environmentVariableCollection.prepend).toHaveBeenCalledWith(
      'PATH',
      `${manager.shimDirectory}${process.platform === 'win32' ? ';' : ':'}`,
    );
  });

  it('does not modify PATH when the packaged sidecar is missing', async () => {
    const context = createMockExtensionContext();
    vi.mocked(shared.fileExists).mockResolvedValue(false);
    const manager = new CodexProtocolShimManager(context as never);

    await expect(manager.enable()).rejects.toThrow('sidecar is missing');
    expect(context.environmentVariableCollection.prepend).not.toHaveBeenCalled();
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it('removes PATH injection and optionally deletes both shims', async () => {
    const context = createMockExtensionContext();
    const manager = new CodexProtocolShimManager(context as never);

    await manager.disable(true);

    expect(context.environmentVariableCollection.delete).toHaveBeenCalledWith('PATH');
    expect(fs.unlink).toHaveBeenCalledTimes(2);
  });

  it('checks the sidecar and both platform shims', async () => {
    const context = createMockExtensionContext();
    const manager = new CodexProtocolShimManager(context as never);

    await expect(manager.isInstalled()).resolves.toBe(true);
    expect(shared.fileExists).toHaveBeenCalledTimes(3);
  });

  it('ignores already-absent shim files during removal', async () => {
    const context = createMockExtensionContext();
    vi.mocked(fs.unlink).mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    const manager = new CodexProtocolShimManager(context as never);

    await expect(manager.disable(true)).resolves.toBeUndefined();
  });
});
