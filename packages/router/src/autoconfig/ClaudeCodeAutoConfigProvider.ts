import { window } from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { BaseAutoConfigProvider, Platform, ProcessResult } from './BaseAutoConfigProvider';
import { SCRIPT_NAME } from '../installer/CodeNotifyScriptInstaller';

interface HookEntry {
  matcher?: string;
  hooks: { type: string; command: string; timeout: number }[];
}

interface ClaudeSettings {
  hooks?: Record<string, HookEntry[]>;
  [key: string]: unknown;
}

export class ClaudeCodeAutoConfigProvider extends BaseAutoConfigProvider {
  readonly id = 'claude-code';
  readonly label = 'Claude Code';
  readonly description =
    'Configure Claude Code hooks to send notifications when finished or needs user input';

  protected getConfigFiles(): string[] {
    return [path.join(os.homedir(), '.claude', 'settings.json')];
  }

  async processConfigs(
    loaded: Map<string, string>,
    platform: Platform,
    useJq: boolean,
  ): Promise<ProcessResult | null> {
    const settingsPath = this.getConfigFiles()[0];
    const raw = loaded.get(settingsPath);
    if (raw === undefined) {
      return null;
    }

    let settings: ClaudeSettings;
    try {
      settings = JSON.parse(raw);
    } catch {
      window.showErrorMessage(
        `Claude Code settings at ${settingsPath} contains invalid JSON. Please fix it manually before running auto-configure.`,
      );
      return null;
    }

    const desired = this.buildHooks(platform, useJq);

    if (!settings.hooks) {
      settings.hooks = {};
    }

    let added = 0;
    let updated = 0;
    let skipped = 0;

    for (const [category, entries] of Object.entries(desired)) {
      if (!settings.hooks[category]) {
        settings.hooks[category] = [];
      }
      const existing = settings.hooks[category];

      for (const entry of entries) {
        const idx = existing.findIndex(
          (e) => this.isCodeNotifyHook(e) && this.matchesMatcher(e, entry),
        );

        if (idx === -1) {
          existing.push(entry);
          added++;
          this.log?.appendLine(
            `[ClaudeCodeAutoConfig] Added ${category}${entry.matcher ? ` (${entry.matcher})` : ''} hook`,
          );
        } else if (this.isIdentical(existing[idx], entry)) {
          skipped++;
          this.log?.appendLine(
            `[ClaudeCodeAutoConfig] Skipped ${category}${entry.matcher ? ` (${entry.matcher})` : ''} hook (identical)`,
          );
        } else {
          existing[idx] = entry;
          updated++;
          this.log?.appendLine(
            `[ClaudeCodeAutoConfig] Updated ${category}${entry.matcher ? ` (${entry.matcher})` : ''} hook`,
          );
        }
      }
    }

    const modifiedFiles = new Map<string, string>();
    if (added > 0 || updated > 0) {
      modifiedFiles.set(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    }

    return {
      modifiedFiles,
      stats: { added, updated, skipped },
    };
  }

  buildHooks(platform: Platform, useJq: boolean): Record<string, HookEntry[]> {
    const cmdPath = this.getCommandPath(platform);

    if (platform === 'windows') {
      return this.buildWindowsHooks(cmdPath);
    }
    return this.buildUnixHooks(cmdPath, useJq);
  }

  private buildUnixHooks(cmdPath: string, useJq: boolean): Record<string, HookEntry[]> {
    const elicitationCommand = useJq
      ? `msg=$(jq -r '(.tool_input.questions // [{}])[0].question // "Has a question for you"' 2>/dev/null) && ${cmdPath} -i ICON_CLAUDE_CODE 'Claude Code' "$msg" 2>/dev/null || true`
      : `${cmdPath} -i ICON_CLAUDE_CODE 'Claude Code' 'Has a question for you' 2>/dev/null || true`;

    return {
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: `${cmdPath} -i ICON_CLAUDE_CODE 'Claude Code' 'Finished — waiting for your input' 2>/dev/null || true`,
              timeout: 5,
            },
          ],
        },
      ],
      Notification: [
        {
          matcher: 'permission_prompt',
          hooks: [
            {
              type: 'command',
              command: `${cmdPath} -i ICON_CLAUDE_CODE 'Claude Code' 'Waiting for permission to use a tool' 2>/dev/null || true`,
              timeout: 5,
            },
          ],
        },
        {
          matcher: 'elicitation_dialog',
          hooks: [
            {
              type: 'command',
              command: elicitationCommand,
              timeout: 5,
            },
          ],
        },
      ],
    };
  }

  private buildWindowsHooks(cmdPath: string): Record<string, HookEntry[]> {
    return {
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: `${cmdPath} -i ICON_CLAUDE_CODE "Claude Code" "Finished — waiting for your input" 2>nul`,
              timeout: 5,
            },
          ],
        },
      ],
      Notification: [
        {
          matcher: 'permission_prompt',
          hooks: [
            {
              type: 'command',
              command: `${cmdPath} -i ICON_CLAUDE_CODE "Claude Code" "Waiting for permission to use a tool" 2>nul`,
              timeout: 5,
            },
          ],
        },
        {
          matcher: 'elicitation_dialog',
          hooks: [
            {
              type: 'command',
              command: `${cmdPath} -i ICON_CLAUDE_CODE "Claude Code" "Has a question for you" 2>nul`,
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
