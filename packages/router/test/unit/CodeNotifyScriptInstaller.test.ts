import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { CodeNotifyScriptInstaller } from '../../src/installer/CodeNotifyScriptInstaller';
import * as shared from 'remote-notifier-shared';

vi.mock('fs/promises');
vi.mock('remote-notifier-shared');
vi.mock('vscode', () => ({
  window: {
    showInformationMessage: vi.fn(),
  },
}));

// Mock the script imports
vi.mock('../../src/installer/code-notify.sh', () => ({
  default: '#!/usr/bin/env bash\r\nunix content\r\n',
}));
vi.mock('../../src/installer/code-notify.cmd', () => ({ default: 'windows content' }));

describe('CodeNotifyScriptInstaller', () => {
  let installer: CodeNotifyScriptInstaller;

  beforeEach(() => {
    vi.clearAllMocks();
    installer = new CodeNotifyScriptInstaller();
  });

  describe('isInstalled', () => {
    it('returns false if file does not exist', async () => {
      vi.mocked(shared.fileExists).mockResolvedValue(false);
      expect(await installer.isInstalled()).toBe(false);
    });

    it('returns false if file exists but not on PATH', async () => {
      vi.mocked(shared.fileExists).mockResolvedValue(true);
      const originalPath = process.env.PATH;
      process.env.PATH = '/some/other/path';

      expect(await installer.isInstalled()).toBe(false);

      process.env.PATH = originalPath;
    });

    it('returns true if file exists and is on PATH', async () => {
      vi.mocked(shared.fileExists).mockResolvedValue(true);
      const originalPath = process.env.PATH;

      // We need to know what binDir is to mock PATH correctly
      // For Linux it's ~/.local/bin
      const binDir = installer['binDir'];
      process.env.PATH = `${binDir}${path.delimiter}/usr/bin`;

      expect(await installer.isInstalled()).toBe(true);

      process.env.PATH = originalPath;
    });
  });

  describe('needsUpdate', () => {
    it('returns true if script cannot be read', async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error('read failed'));
      expect(await installer.needsUpdate()).toBe(true);
    });

    it('returns true if content differs', async () => {
      vi.mocked(fs.readFile).mockResolvedValue('old content');
      expect(await installer.needsUpdate()).toBe(true);
    });

    it('repairs CRLF in an otherwise matching Unix executable', async () => {
      const content =
        process.platform === 'win32'
          ? 'windows content\r\n'
          : '#!/usr/bin/env bash\r\nunix content\r\n';
      vi.mocked(fs.readFile).mockResolvedValue(content);
      expect(await installer.needsUpdate()).toBe(process.platform !== 'win32');
    });

    it('returns false if normalized content matches exactly', async () => {
      const content =
        process.platform === 'win32' ? 'windows content' : '#!/usr/bin/env bash\nunix content\n';
      vi.mocked(fs.readFile).mockResolvedValue(content);
      expect(await installer.needsUpdate()).toBe(false);
    });
  });

  it('writes Unix executables with an LF shebang', async () => {
    await installer.install(true);

    const expectedContent =
      process.platform === 'win32' ? 'windows content' : '#!/usr/bin/env bash\nunix content\n';
    expect(fs.writeFile).toHaveBeenCalledWith(expect.any(String), expectedContent, { mode: 0o755 });
  });
});
