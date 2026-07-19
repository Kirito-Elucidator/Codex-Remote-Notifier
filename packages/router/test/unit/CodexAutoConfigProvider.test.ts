import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { window } from 'vscode';
import {
  CodexAutoConfigProvider,
  resolveCodexHome,
} from '../../src/autoconfig/CodexAutoConfigProvider';

vi.mock('../../src/installer/CodeNotifyScriptInstaller', () => ({
  getBinDir: () => path.join(os.homedir(), '.local', 'bin'),
  SCRIPT_NAME: 'code-notify',
  CodeNotifyScriptInstaller: vi.fn(),
}));
vi.mock('fs/promises');

vi.mock('../../src/installer/CodexAttentionHookInstaller', () => ({
  CODEX_ATTENTION_HOOK_NAME: 'codex-attention-hook',
  getCodexAttentionHookPath: () => path.join(os.homedir(), '.local', 'bin', 'codex-attention-hook'),
  getCodexAttentionHookWindowsPath: () =>
    path.join(os.homedir(), '.local', 'bin', 'codex-attention-hook.cmd'),
  CodexAttentionHookInstaller: vi.fn(),
}));

describe('CodexAutoConfigProvider', () => {
  let provider: CodexAutoConfigProvider;
  const codexHome = resolveCodexHome();
  const hooksPath = path.join(codexHome, 'hooks.json');
  const tomlPath = path.join(codexHome, 'config.toml');

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    provider = new CodexAutoConfigProvider();
  });

  it('uses CODEX_HOME when it is configured', () => {
    expect(resolveCodexHome({ CODEX_HOME: 'E:/custom-codex' }, 'C:/Users/test')).toBe(
      path.resolve('E:/custom-codex'),
    );
  });

  it('falls back to the user home directory', () => {
    expect(resolveCodexHome({}, 'C:/Users/test')).toBe(path.join('C:/Users/test', '.codex'));
  });

  it('automatically upgrades owned Hooks without rewriting unrelated TOML', async () => {
    const existing = {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: 'command', command: 'echo third-party', timeout: 9 },
              {
                type: 'command',
                command: '/home/u/.local/bin/codex-attention-hook',
                timeout: 3,
              },
            ],
          },
        ],
      },
    };
    vi.spyOn(provider, 'isConfigured').mockResolvedValue(true);
    vi.mocked(fs.readFile).mockImplementation(async (filePath) =>
      String(filePath) === hooksPath ? JSON.stringify(existing) : '[tui]\nnotifications = true\n',
    );

    await expect(provider.upgradeOwnedHooks()).resolves.toBe(true);

    expect(fs.writeFile).toHaveBeenCalledTimes(1);
    expect(fs.writeFile).toHaveBeenCalledWith(
      hooksPath,
      expect.stringContaining('UserPromptSubmit'),
      'utf-8',
    );
    const upgraded = JSON.parse(vi.mocked(fs.writeFile).mock.calls[0][1] as string);
    expect(upgraded.hooks.Stop[0].hooks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: 'echo third-party', timeout: 9 }),
        expect.objectContaining({ timeout: 5 }),
      ]),
    );
    expect(window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('trust the updated Hook'),
    );
  });

  describe('processConfigs', () => {
    it('adds hooks to empty JSON and creates TUI section in TOML', async () => {
      const loaded = new Map<string, string>();
      const result = await provider.processConfigs(loaded, 'unix', true);

      expect(result).not.toBeNull();
      expect(result!.stats.added).toBe(5);

      const hooks = JSON.parse(result!.modifiedFiles.get(hooksPath)!);
      expect(hooks.hooks.SessionStart).toHaveLength(1);
      expect(hooks.hooks.UserPromptSubmit).toHaveLength(1);
      expect(hooks.hooks.Stop).toHaveLength(1);
      expect(hooks.hooks.PreToolUse[0].matcher).toBe('^request_user_input$');
      expect(hooks.hooks.PermissionRequest[0].hooks[0].command).toContain('codex-attention-hook');
      expect(hooks.hooks.PermissionRequest[0].hooks[0].timeout).toBe(5);

      const toml = result!.modifiedFiles.get(tomlPath)!;
      expect(toml).toContain('[tui]');
      expect(toml).toContain('notifications = false');
    });

    it('explicitly invokes the Windows helper through cmd.exe', async () => {
      const result = await provider.processConfigs(new Map(), 'windows', false);
      const hooks = JSON.parse(result!.modifiedFiles.get(hooksPath)!);
      const command = hooks.hooks.Stop[0].hooks[0].command;
      const hookPath = path
        .join(os.homedir(), '.local', 'bin', 'codex-attention-hook.cmd')
        .replace(/\\/g, '/');

      expect(command).toBe(`cmd.exe /d /c call "${hookPath}"`);
    });

    it('updates existing hooks in JSON', async () => {
      const existingHooks = {
        hooks: {
          Stop: [
            {
              hooks: [{ type: 'command', command: 'code-notify -i ICON_CODEX old', timeout: 1 }],
            },
          ],
        },
      };
      const loaded = new Map([
        [hooksPath, JSON.stringify(existingHooks)],
        [tomlPath, '[tui]\nnotifications = true\n'],
      ]);
      const result = await provider.processConfigs(loaded, 'unix', false);

      expect(result!.stats.updated).toBe(1);
      const hooks = JSON.parse(result!.modifiedFiles.get(hooksPath)!);
      expect(hooks.hooks.Stop[0].hooks[0].timeout).toBe(5);

      const toml = result!.modifiedFiles.get(tomlPath)!;
      expect(toml).toContain('notifications = false');
    });

    it('surgical TOML update: preserves other TUI settings', async () => {
      const existingToml = `
[general]
api_key = "abc"

[tui]
theme = "dark"
notifications = true
font = "monaco"

[other]
foo = "bar"
`;
      const loaded = new Map([[tomlPath, existingToml]]);
      const result = await provider.processConfigs(loaded, 'unix', false);

      const toml = result!.modifiedFiles.get(tomlPath)!;
      expect(toml).toContain('theme = "dark"');
      expect(toml).toContain('notifications = false');
      expect(toml).toContain('font = "monaco"');
      expect(toml).toContain('[general]');
      expect(toml).toContain('[other]');
    });

    it('surgical TOML update: adds notifications if missing in [tui] section', async () => {
      const existingToml = `[tui]\ntheme = "dark"\n`;
      const loaded = new Map([[tomlPath, existingToml]]);
      const result = await provider.processConfigs(loaded, 'unix', false);

      const toml = result!.modifiedFiles.get(tomlPath)!;
      expect(toml).toContain('[tui]\nnotifications = false\ntheme = "dark"');
    });

    it('handles invalid JSON in hooks file', async () => {
      const loaded = new Map([[hooksPath, 'invalid{']]);
      const result = await provider.processConfigs(loaded, 'unix', false);

      expect(result).toBeNull();
      expect(window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('invalid JSON'));
    });

    it('skips when everything is already configured', async () => {
      const desiredHooks = (provider as any).buildHooks('unix', false);
      const loaded = new Map([
        [hooksPath, JSON.stringify({ hooks: desiredHooks })],
        [tomlPath, '[tui]\nnotifications = false\n'],
      ]);
      const result = await provider.processConfigs(loaded, 'unix', false);

      expect(result!.stats.skipped).toBe(5);
      expect(result!.modifiedFiles.size).toBe(0);
    });

    it('preserves unrelated root fields, hook groups, and commands while upgrading', async () => {
      const existingHooks = {
        custom: { enabled: true },
        hooks: {
          SessionStart: [
            { matcher: 'startup', hooks: [{ type: 'command', command: 'echo user', timeout: 9 }] },
          ],
          Stop: [
            {
              note: 'keep me',
              hooks: [
                { type: 'command', command: 'echo user-stop', timeout: 9 },
                {
                  type: 'command',
                  command: "code-notify -i ICON_CODEX 'old'",
                  timeout: 5,
                },
              ],
            },
          ],
        },
      };
      const result = await provider.processConfigs(
        new Map([
          [hooksPath, JSON.stringify(existingHooks)],
          [tomlPath, '[tui]\nnotifications = false\n'],
        ]),
        'unix',
        false,
      );

      const hooks = JSON.parse(result!.modifiedFiles.get(hooksPath)!);
      expect(hooks.custom).toEqual({ enabled: true });
      expect(hooks.hooks.SessionStart).toEqual(
        expect.arrayContaining(existingHooks.hooks.SessionStart),
      );
      expect(
        hooks.hooks.SessionStart.flatMap((entry: any) => entry.hooks).filter((hook: any) =>
          hook.command.includes('codex-attention-hook'),
        ),
      ).toHaveLength(1);
      expect(hooks.hooks.Stop[0].note).toBe('keep me');
      expect(hooks.hooks.Stop[0].hooks).toEqual(
        expect.arrayContaining([expect.objectContaining({ command: 'echo user-stop' })]),
      );
      expect(
        hooks.hooks.Stop[0].hooks.filter((hook: any) =>
          hook.command.includes('codex-attention-hook'),
        ),
      ).toHaveLength(1);
    });

    it('cleanly removes only Remote Notifier Codex hooks', () => {
      const configured = {
        keep: 'root',
        hooks: {
          Stop: [
            {
              hooks: [
                { type: 'command', command: 'echo keep', timeout: 2 },
                { type: 'command', command: '/home/u/.local/bin/codex-attention-hook', timeout: 3 },
              ],
            },
          ],
          PreToolUse: [
            {
              matcher: '^request_user_input$',
              hooks: [
                { type: 'command', command: '/home/u/.local/bin/codex-attention-hook', timeout: 3 },
              ],
            },
          ],
          SessionStart: [{ hooks: [{ type: 'command', command: 'echo untouched', timeout: 2 }] }],
        },
      };

      const removed = provider.removeOwnedHooks(JSON.stringify(configured));
      expect(removed).not.toBeNull();
      expect(removed!.changed).toBe(true);
      const hooks = JSON.parse(removed!.content);
      expect(hooks.keep).toBe('root');
      expect(hooks.hooks.Stop[0].hooks).toEqual([
        { type: 'command', command: 'echo keep', timeout: 2 },
      ]);
      expect(hooks.hooks.PreToolUse).toBeUndefined();
      expect(hooks.hooks.SessionStart).toEqual(configured.hooks.SessionStart);
    });
  });
});
