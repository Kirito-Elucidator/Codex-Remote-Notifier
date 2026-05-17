import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { window } from 'vscode';
import { GeminiAutoConfigProvider } from '../../src/autoconfig/GeminiAutoConfigProvider';

vi.mock('../../src/installer/CodeNotifyScriptInstaller', () => ({
  getBinDir: () => path.join(os.homedir(), '.local', 'bin'),
  SCRIPT_NAME: 'code-notify',
  CodeNotifyScriptInstaller: vi.fn(),
}));

describe('GeminiAutoConfigProvider', () => {
  let provider: GeminiAutoConfigProvider;
  const settingsPath = path.join(os.homedir(), '.gemini', 'settings.json');

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new GeminiAutoConfigProvider();
  });

  describe('processConfigs', () => {
    it('adds hooks and disables native notifications in empty settings', async () => {
      const loaded = new Map([[settingsPath, '{}']]);
      const result = await provider.processConfigs(loaded, 'unix', true);

      expect(result).not.toBeNull();
      expect(result!.stats.added).toBe(2);
      expect(result!.stats.updated).toBe(1); // general.enableNotifications

      const parsed = JSON.parse(result!.modifiedFiles.get(settingsPath)!);
      expect(parsed.hooks.AfterAgent).toHaveLength(1);
      expect(parsed.hooks.Notification).toHaveLength(1);
      expect(parsed.general.enableNotifications).toBe(false);
    });

    it('updates existing hooks', async () => {
      const existing = {
        hooks: {
          AfterAgent: [
            {
              matcher: '*',
              hooks: [{ name: 'old', type: 'command', command: 'code-notify old', timeout: 1 }],
            },
          ],
        },
        general: { enableNotifications: false },
      };
      const loaded = new Map([[settingsPath, JSON.stringify(existing)]]);
      const result = await provider.processConfigs(loaded, 'unix', false);

      expect(result!.stats.updated).toBe(1); // hook update
      const parsed = JSON.parse(result!.modifiedFiles.get(settingsPath)!);
      expect(parsed.hooks.AfterAgent[0].hooks[0].timeout).toBe(5000);
    });

    it('preserves other settings', async () => {
      const existing = {
        model: 'gemini-pro',
        general: { theme: 'dark', enableNotifications: true },
      };
      const loaded = new Map([[settingsPath, JSON.stringify(existing)]]);
      const result = await provider.processConfigs(loaded, 'unix', false);

      const parsed = JSON.parse(result!.modifiedFiles.get(settingsPath)!);
      expect(parsed.model).toBe('gemini-pro');
      expect(parsed.general.theme).toBe('dark');
      expect(parsed.general.enableNotifications).toBe(false);
    });

    it('skips when already configured', async () => {
      const desired = provider.buildHooks('unix', false);
      const existing = {
        hooks: desired,
        general: { enableNotifications: false },
      };
      const loaded = new Map([[settingsPath, JSON.stringify(existing)]]);
      const result = await provider.processConfigs(loaded, 'unix', false);

      expect(result!.stats.skipped).toBe(2);
      expect(result!.modifiedFiles.size).toBe(0);
    });

    it('handles invalid JSON', async () => {
      const loaded = new Map([[settingsPath, 'invalid{']]);
      const result = await provider.processConfigs(loaded, 'unix', false);

      expect(result).toBeNull();
      expect(window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('invalid JSON'));
    });
  });
});
