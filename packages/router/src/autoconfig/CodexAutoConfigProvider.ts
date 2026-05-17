import { window } from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { BaseAutoConfigProvider, Platform, ProcessResult } from './BaseAutoConfigProvider';
import { SCRIPT_NAME } from '../installer/CodeNotifyScriptInstaller';

interface HookEntry {
  matcher?: string;
  hooks: { type: string; command: string; timeout: number }[];
}

interface CodexHooksConfig {
  hooks?: Record<string, HookEntry[]>;
  [key: string]: unknown;
}

const HOOKS_CONFIG_PATH = path.join(os.homedir(), '.codex', 'hooks.json');
const TOML_CONFIG_PATH = path.join(os.homedir(), '.codex', 'config.toml');

export class CodexAutoConfigProvider extends BaseAutoConfigProvider {
  readonly id = 'codex';
  readonly label = 'Codex';
  readonly description = 'Configure Codex hooks to send notifications';

  protected getConfigFiles(): string[] {
    return [HOOKS_CONFIG_PATH, TOML_CONFIG_PATH];
  }

  protected handleMissingFile(_filePath: string, _error: unknown): boolean {
    // Codex might not have these files yet, we'll create them in processConfigs if needed
    // So we return true to continue even if files are missing
    return true;
  }

  async processConfigs(
    loaded: Map<string, string>,
    platform: Platform,
    useJq: boolean,
  ): Promise<ProcessResult | null> {
    const modifiedFiles = new Map<string, string>();
    let added = 0;
    let updated = 0;
    let skipped = 0;

    // 1. Process Hooks (JSON)
    const rawHooks = loaded.get(HOOKS_CONFIG_PATH) || '{}';
    let hooksConfig: CodexHooksConfig;
    try {
      hooksConfig = JSON.parse(rawHooks);
    } catch {
      window.showErrorMessage(
        `Codex hooks at ${HOOKS_CONFIG_PATH} contains invalid JSON. Please fix it manually.`,
      );
      return null;
    }

    const desiredHooks = this.buildHooks(platform, useJq);
    if (!hooksConfig.hooks) {
      hooksConfig.hooks = {};
    }

    for (const [category, entries] of Object.entries(desiredHooks)) {
      if (!hooksConfig.hooks[category]) {
        hooksConfig.hooks[category] = [];
      }
      const existing = hooksConfig.hooks[category];

      for (const entry of entries) {
        const idx = existing.findIndex(
          (e) => this.isCodeNotifyHook(e) && this.matchesMatcher(e, entry),
        );

        if (idx === -1) {
          existing.push(entry);
          added++;
        } else if (this.isIdentical(existing[idx], entry)) {
          skipped++;
        } else {
          existing[idx] = entry;
          updated++;
        }
      }
    }

    if (added > 0 || updated > 0) {
      modifiedFiles.set(HOOKS_CONFIG_PATH, JSON.stringify(hooksConfig, null, 2) + '\n');
    }

    // 2. Process TUI (TOML)
    const rawToml = loaded.get(TOML_CONFIG_PATH) || '';
    const { content: modifiedToml, changed } = this.updateTomlTui(rawToml);

    if (changed) {
      modifiedFiles.set(TOML_CONFIG_PATH, modifiedToml);
      // We don't track added/updated for TOML in stats for now,
      // but if it's the only change, we should ensure it's saved.
      if (added === 0 && updated === 0) {
        // Just increment something so configure() knows to save
        updated++;
      }
    }

    return {
      modifiedFiles,
      stats: { added, updated, skipped },
    };
  }

  private updateTomlTui(content: string): { content: string; changed: boolean } {
    const tuiSectionRegex = /^\[tui\]/m;

    if (tuiSectionRegex.test(content)) {
      const lines = content.split(/\r?\n/);
      const tuiIndex = lines.findIndex((l) => l.trim() === '[tui]');

      let foundNotifications = false;
      let lastTuiLine = tuiIndex;

      for (let i = tuiIndex + 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('[') && line.endsWith(']')) break;
        if (line.startsWith('notifications')) {
          if (line === 'notifications = false') {
            return { content, changed: false };
          }
          lines[i] = 'notifications = false';
          foundNotifications = true;
          break;
        }
        if (line !== '' || i === lastTuiLine + 1) lastTuiLine = i;
      }

      if (!foundNotifications) {
        lines.splice(tuiIndex + 1, 0, 'notifications = false');
      }
      return { content: lines.join('\n'), changed: true };
    } else {
      const prefix = content.endsWith('\n') || content === '' ? '' : '\n';
      return {
        content: content + `${prefix}\n[tui]\nnotifications = false\n`,
        changed: true,
      };
    }
  }

  private buildHooks(platform: Platform, useJq: boolean): Record<string, HookEntry[]> {
    const cmdPath = this.getCommandPath(platform);

    const permissionCommand = useJq
      ? `msg=$(jq -r '.tool_input.description // "Waiting for permission to use a tool"' 2>/dev/null) && ${cmdPath} -i ICON_CODEX -d system 'Codex' "$msg" 2>/dev/null || true`
      : `${cmdPath} -i ICON_CODEX -d system 'Codex' 'Waiting for permission to use a tool' 2>/dev/null || true`;

    const stopCommand =
      platform === 'windows'
        ? `${cmdPath} -i ICON_CODEX -d system "Codex" "Finished - waiting for your input" 2>nul`
        : `${cmdPath} -i ICON_CODEX -d system 'Codex' 'Finished - waiting for your input' 2>/dev/null || true`;

    return {
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: stopCommand,
              timeout: 5,
            },
          ],
        },
      ],
      PermissionRequest: [
        {
          hooks: [
            {
              type: 'command',
              command: permissionCommand,
              timeout: 5,
            },
          ],
        },
      ],
    };
  }

  private isCodeNotifyHook(entry: HookEntry): boolean {
    return entry.hooks?.some((h) => h.command?.includes(SCRIPT_NAME)) ?? false;
  }

  private matchesMatcher(a: HookEntry, b: HookEntry): boolean {
    return (a.matcher ?? '') === (b.matcher ?? '');
  }

  private isIdentical(a: HookEntry, b: HookEntry): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
  }
}
