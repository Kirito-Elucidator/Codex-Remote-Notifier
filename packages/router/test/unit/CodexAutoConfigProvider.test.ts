import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { window } from 'vscode';
import { CodexAutoConfigProvider } from '../../src/autoconfig/CodexAutoConfigProvider';

vi.mock('../../src/installer/CodeNotifyScriptInstaller', () => ({
  getBinDir: () => path.join(os.homedir(), '.local', 'bin'),
  SCRIPT_NAME: 'code-notify',
  CodeNotifyScriptInstaller: vi.fn(),
}));

describe('CodexAutoConfigProvider', () => {
  let provider: CodexAutoConfigProvider;
  const hooksPath = path.join(os.homedir(), '.codex', 'hooks.json');
  const tomlPath = path.join(os.homedir(), '.codex', 'config.toml');

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new CodexAutoConfigProvider();
  });

  describe('processConfigs', () => {
    it('adds hooks to empty JSON and creates TUI section in TOML', async () => {
      const loaded = new Map<string, string>();
      const result = await provider.processConfigs(loaded, 'unix', true);

      expect(result).not.toBeNull();
      expect(result!.stats.added).toBe(2);

      const hooks = JSON.parse(result!.modifiedFiles.get(hooksPath)!);
      expect(hooks.hooks.Stop).toHaveLength(1);
      expect(hooks.hooks.PermissionRequest[0].hooks[0].command).toContain('jq');

      const toml = result!.modifiedFiles.get(tomlPath)!;
      expect(toml).toContain('[tui]');
      expect(toml).toContain('notifications = false');
    });

    it('updates existing hooks in JSON', async () => {
      const existingHooks = {
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'code-notify old', timeout: 1 }] }],
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

      expect(result!.stats.skipped).toBe(2);
      expect(result!.modifiedFiles.size).toBe(0);
    });
  });
});
