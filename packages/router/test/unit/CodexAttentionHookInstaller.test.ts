import * as fs from 'fs/promises';

import * as shared from 'remote-notifier-shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CodexAttentionHookInstaller } from '../../src/installer/CodexAttentionHookInstaller';

vi.mock('fs/promises');
vi.mock('remote-notifier-shared');
vi.mock('../../src/installer/codex-attention-hook.py', () => ({
  default: '#!/usr/bin/env python3\nprint("bundled")\n',
}));
vi.mock('../../src/installer/codex-attention-hook.cmd', () => ({
  default: '@echo off\nexit /b 0\n',
}));

describe('CodexAttentionHookInstaller', () => {
  let installer: CodexAttentionHookInstaller;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.chmod).mockResolvedValue(undefined);
    installer = new CodexAttentionHookInstaller();
  });

  it('recognizes an installed helper', async () => {
    vi.mocked(shared.fileExists).mockResolvedValue(true);
    await expect(installer.isInstalled()).resolves.toBe(true);
  });

  it('rewrites a CRLF Python helper so its shebang works on Unix', async () => {
    vi.mocked(shared.fileExists).mockResolvedValue(true);
    vi.mocked(fs.readFile).mockImplementation(async (filePath) =>
      String(filePath).endsWith('.cmd')
        ? '@echo off\r\nexit /b 0\r\n'
        : '#!/usr/bin/env python3\r\nprint("bundled")\r\n',
    );

    await installer.ensureInstalled();

    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/codex-attention-hook$/),
      '#!/usr/bin/env python3\nprint("bundled")\n',
      { mode: 0o755 },
    );
  });

  it('does not rewrite an identical LF Python helper', async () => {
    vi.mocked(shared.fileExists).mockResolvedValue(true);
    vi.mocked(fs.readFile).mockImplementation(async (filePath) =>
      String(filePath).endsWith('.cmd')
        ? '@echo off\r\nexit /b 0\r\n'
        : '#!/usr/bin/env python3\nprint("bundled")\n',
    );

    await installer.ensureInstalled();

    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it('installs an updated executable helper idempotently', async () => {
    vi.mocked(shared.fileExists).mockResolvedValue(true);
    vi.mocked(fs.readFile).mockResolvedValue('old');

    await installer.ensureInstalled();

    expect(fs.mkdir).toHaveBeenCalledWith(expect.any(String), { recursive: true });
    expect(fs.writeFile).toHaveBeenCalledTimes(2);
    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/codex-attention-hook$/),
      expect.stringContaining('bundled'),
      { mode: 0o755 },
    );
    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/codex-attention-hook\.cmd$/),
      expect.stringContaining('exit /b 0'),
      { mode: 0o755 },
    );
    expect(fs.chmod).toHaveBeenCalledTimes(2);
  });

  it('removes the helper and ignores a missing file', async () => {
    vi.mocked(fs.unlink).mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    await expect(installer.uninstall()).resolves.toBeUndefined();
    expect(fs.unlink).toHaveBeenCalledTimes(2);
  });
});
