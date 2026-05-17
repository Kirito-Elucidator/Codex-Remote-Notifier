import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { window } from 'vscode';

vi.mock('fs/promises');

const mockInstall = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/installer/CodeNotifyScriptInstaller', () => ({
  getBinDir: () => path.join(os.homedir(), '.local', 'bin'),
  SCRIPT_NAME: 'code-notify',
  CodeNotifyScriptInstaller: vi.fn().mockImplementation(function () {
    return {
      install: mockInstall,
    };
  }),
}));

const jqCheckResult: { value: ReturnType<typeof vi.fn> } = {
  value: vi.fn().mockRejectedValue(new Error('not found')),
};

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('util', () => ({
  promisify:
    () =>
    (...args: unknown[]) =>
      jqCheckResult.value(...args),
}));

import { ClaudeCodeAutoConfigProvider } from '../../src/autoconfig/ClaudeCodeAutoConfigProvider';

const mockAccess = vi.mocked(fs.access);
const mockReadFile = vi.mocked(fs.readFile);
const mockWriteFile = vi.mocked(fs.writeFile);

describe('ClaudeCodeAutoConfigProvider', () => {
  let provider: ClaudeCodeAutoConfigProvider;
  const originalPlatform = process.platform;

  function setPlatform(platform: string) {
    Object.defineProperty(process, 'platform', { value: platform, writable: true });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    setPlatform('linux');
    mockAccess.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    jqCheckResult.value = vi.fn().mockRejectedValue(new Error('not found'));
    mockInstall.mockResolvedValue(undefined);
    provider = new ClaudeCodeAutoConfigProvider();
  });

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  describe('processConfigs', () => {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');

    it('adds hooks to empty settings', async () => {
      const loaded = new Map([[settingsPath, '{}']]);
      const result = await provider.processConfigs(loaded, 'unix', false);

      expect(result).not.toBeNull();
      expect(result!.stats.added).toBe(3);
      expect(result!.stats.updated).toBe(0);

      const parsed = JSON.parse(result!.modifiedFiles.get(settingsPath)!);
      expect(parsed.hooks.Stop).toHaveLength(1);
    });

    it('updates existing hooks', async () => {
      const existing = {
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'code-notify old', timeout: 1 }] }],
        },
      };
      const loaded = new Map([[settingsPath, JSON.stringify(existing)]]);
      const result = await provider.processConfigs(loaded, 'unix', false);

      expect(result!.stats.updated).toBe(1);
      const parsed = JSON.parse(result!.modifiedFiles.get(settingsPath)!);
      expect(parsed.hooks.Stop[0].hooks[0].command).toContain('code-notify');
    });

    it('skips identical hooks', async () => {
      const desired = provider.buildHooks('unix', false);
      const existing = { hooks: desired };
      const loaded = new Map([[settingsPath, JSON.stringify(existing)]]);
      const result = await provider.processConfigs(loaded, 'unix', false);

      expect(result!.stats.skipped).toBe(3);
      expect(result!.modifiedFiles.size).toBe(0);
    });

    it('returns null and shows error on invalid JSON', async () => {
      const loaded = new Map([[settingsPath, 'invalid{']]);
      const result = await provider.processConfigs(loaded, 'unix', false);

      expect(result).toBeNull();
      expect(window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('invalid JSON'));
    });
  });

  describe('configure', () => {
    function mockSettingsFile(content: string) {
      mockReadFile.mockResolvedValue(content as unknown as Buffer);
    }

    function getWrittenSettings(): Record<string, unknown> {
      const call = mockWriteFile.mock.calls[0];
      return JSON.parse(call[1] as string);
    }

    it('shows error when settings file does not exist', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT'));
      // jq prompt won't be reached since we exit early
      await provider.configure();

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Could not find Claude Code settings'),
      );
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('shows error when settings file contains invalid JSON', async () => {
      mockSettingsFile('not valid json{{{');
      vi.mocked(window.showWarningMessage).mockResolvedValue('Use simple notification' as never);
      await provider.configure();

      expect(window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('invalid JSON'));
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('adds all hooks to empty settings object', async () => {
      mockSettingsFile('{}');
      // User chooses "Use simple notification" when jq not found
      vi.mocked(window.showWarningMessage).mockResolvedValue('Use simple notification' as never);

      await provider.configure();

      expect(mockWriteFile).toHaveBeenCalled();
      const settings = getWrittenSettings();
      const hooks = settings.hooks as Record<string, unknown[]>;
      expect(hooks.Stop).toHaveLength(1);
      expect(hooks.Notification).toHaveLength(2);
      expect(window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('3 added'),
      );
    });

    it('preserves existing non-code-notify hooks', async () => {
      const existing = {
        model: 'claude-opus-4-6',
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'echo done', timeout: 10 }] }],
          PreToolUse: [{ hooks: [{ type: 'command', command: 'echo tool', timeout: 5 }] }],
        },
      };
      mockSettingsFile(JSON.stringify(existing));
      vi.mocked(window.showWarningMessage).mockResolvedValue('Use simple notification' as never);

      await provider.configure();

      const settings = getWrittenSettings();
      expect(settings.model).toBe('claude-opus-4-6');
      const hooks = settings.hooks as Record<string, unknown[]>;
      // Original Stop hook + new code-notify Stop hook
      expect(hooks.Stop).toHaveLength(2);
      expect(hooks.PreToolUse).toHaveLength(1);
      expect(hooks.Notification).toHaveLength(2);
    });

    it('replaces outdated code-notify hooks', async () => {
      const existing = {
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'old-code-notify done', timeout: 3 }] }],
          Notification: [
            {
              matcher: 'permission_prompt',
              hooks: [{ type: 'command', command: 'old-code-notify perm', timeout: 3 }],
            },
          ],
        },
      };
      mockSettingsFile(JSON.stringify(existing));
      vi.mocked(window.showWarningMessage).mockResolvedValue('Use simple notification' as never);

      await provider.configure();

      const settings = getWrittenSettings();
      const hooks = settings.hooks as Record<string, unknown[]>;
      // Replaced, not appended
      expect(hooks.Stop).toHaveLength(1);
      expect((hooks.Stop[0] as { hooks: { command: string }[] }).hooks[0].command).toContain(
        '~/.local/bin/code-notify',
      );
      expect(hooks.Notification).toHaveLength(2);
      expect(window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('updated'),
      );
    });

    it('skips when identical hooks are already present', async () => {
      const desiredHooks = provider.buildHooks('unix', false);
      const existing = { hooks: desiredHooks };
      mockSettingsFile(JSON.stringify(existing));
      vi.mocked(window.showWarningMessage).mockResolvedValue('Use simple notification' as never);

      await provider.configure();

      expect(mockWriteFile).not.toHaveBeenCalled();
      expect(window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('already configured'),
      );
    });

    it('adds missing hooks when only some exist', async () => {
      const desired = provider.buildHooks('unix', false);
      const existing = {
        hooks: {
          Stop: desired.Stop,
        },
      };
      mockSettingsFile(JSON.stringify(existing));
      vi.mocked(window.showWarningMessage).mockResolvedValue('Use simple notification' as never);

      await provider.configure();

      const settings = getWrittenSettings();
      const hooks = settings.hooks as Record<string, unknown[]>;
      expect(hooks.Stop).toHaveLength(1);
      expect(hooks.Notification).toHaveLength(2);
      expect(window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('2 added'),
      );
    });

    it('returns early when user cancels jq prompt', async () => {
      mockSettingsFile('{}');
      vi.mocked(window.showWarningMessage).mockResolvedValue('Cancel' as never);

      await provider.configure();

      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('uses jq-based hook when jq is available', async () => {
      jqCheckResult.value = vi.fn().mockResolvedValue({ stdout: '/usr/bin/jq' });
      mockSettingsFile('{}');

      await provider.configure();

      expect(mockWriteFile).toHaveBeenCalled();
      const settings = getWrittenSettings();
      const hooks = settings.hooks as Record<
        string,
        { matcher?: string; hooks: { command: string }[] }[]
      >;
      const elicitation = hooks.Notification.find((e) => e.matcher === 'elicitation_dialog');
      expect(elicitation!.hooks[0].command).toContain('jq');
      expect(elicitation!.hooks[0].command).toContain('$msg');
    });

    it('uses Windows paths and simple hooks on win32', async () => {
      setPlatform('win32');
      provider = new ClaudeCodeAutoConfigProvider();
      mockSettingsFile('{}');
      // No jq prompt on Windows

      await provider.configure();

      expect(mockWriteFile).toHaveBeenCalled();
      const settings = getWrittenSettings();
      const hooks = settings.hooks as Record<string, { hooks: { command: string }[] }[]>;
      expect(hooks.Stop[0].hooks[0].command).toContain('%LOCALAPPDATA%');
      expect(hooks.Stop[0].hooks[0].command).toContain('code-notify.cmd');
      expect(hooks.Stop[0].hooks[0].command).toContain('2>nul');
      expect(hooks.Notification[1].hooks[0].command).not.toContain('jq');
    });

    it('preserves all top-level settings keys', async () => {
      const existing = {
        model: 'claude-opus-4-6',
        env: { FOO: 'bar' },
        hooks: {},
        statusLine: { type: 'command', command: 'echo hi' },
      };
      mockSettingsFile(JSON.stringify(existing));
      vi.mocked(window.showWarningMessage).mockResolvedValue('Use simple notification' as never);

      await provider.configure();

      const settings = getWrittenSettings();
      expect(settings.model).toBe('claude-opus-4-6');
      expect(settings.env).toEqual({ FOO: 'bar' });
      expect(settings.statusLine).toEqual({ type: 'command', command: 'echo hi' });
    });

    it('writes file with trailing newline', async () => {
      mockSettingsFile('{}');
      vi.mocked(window.showWarningMessage).mockResolvedValue('Use simple notification' as never);

      await provider.configure();

      const writtenContent = mockWriteFile.mock.calls[0][1] as string;
      expect(writtenContent.endsWith('\n')).toBe(true);
    });
  });
});
