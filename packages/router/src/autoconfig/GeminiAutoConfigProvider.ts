import * as os from 'os';
import * as path from 'path';

import { window } from 'vscode';

import { SCRIPT_NAME } from '../installer/CodeNotifyScriptInstaller';
import { BaseAutoConfigProvider, Platform, ProcessResult } from './BaseAutoConfigProvider';

interface HookEntry {
  matcher?: string;
  hooks: { name?: string; type: string; command: string; timeout: number }[];
}

interface GeminiSettings {
  hooks?: Record<string, HookEntry[]>;
  general?: {
    enableNotifications?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export class GeminiAutoConfigProvider extends BaseAutoConfigProvider {
  readonly id = 'gemini';
  readonly label = 'Gemini CLI';
  readonly description =
    'Configure Gemini CLI hooks to send notifications and disable redundant native alerts';

  protected getConfigFiles(): string[] {
    return [path.join(os.homedir(), '.gemini', 'settings.json')];
  }

  async processConfigs(
    loaded: Map<string, string>,
    platform: Platform,
    useJq: boolean,
  ): Promise<ProcessResult | null> {
    const settingsPath = this.getConfigFiles()[0];
    const raw = loaded.get(settingsPath) || '{}';

    let settings: GeminiSettings;
    try {
      settings = JSON.parse(raw);
    } catch {
      window.showErrorMessage(
        `Gemini CLI settings at ${settingsPath} contains invalid JSON. Please fix it manually.`,
      );
      return null;
    }

    const desired = this.buildHooks(platform, useJq);

    if (!settings.hooks) {
      settings.hooks = {};
    }

    const hooks = settings.hooks;
    let added = 0;
    let updated = 0;
    let skipped = 0;

    // 1. Configure Hooks
    for (const [category, entries] of Object.entries(desired)) {
      if (!hooks[category]) {
        hooks[category] = [];
      }
      const existing = hooks[category];

      for (const entry of entries) {
        const idx = existing.findIndex(
          (e: HookEntry) => this.isCodeNotifyHook(e) && this.matchesMatcher(e, entry),
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

    // 2. Disable Native Notifications
    if (!settings.general) {
      settings.general = {};
    }
    if (settings.general.enableNotifications !== false) {
      settings.general.enableNotifications = false;
      updated++;
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

    const cmdSuffix = platform === 'windows' ? `2>nul` : `2>/dev/null || true`;

    const notificationCommand = useJq
      ? `msg=$(jq -r '.message // "Has a question for you"' 2>/dev/null) && ${cmdPath} -i ICON_GEMINI 'Gemini' "$msg" ${cmdSuffix}`
      : `${cmdPath} -i ICON_GEMINI 'Gemini' 'Has a question for you' ${cmdSuffix}`;

    const afterAgentCommand =
      platform === 'windows'
        ? `${cmdPath} -i ICON_GEMINI "Gemini" "Session finished" ${cmdSuffix}`
        : `${cmdPath} -i ICON_GEMINI 'Gemini' 'Session finished' ${cmdSuffix}`;

    return {
      AfterAgent: [
        {
          matcher: '*',
          hooks: [
            {
              name: 'remote-notifier-finished',
              type: 'command',
              command: afterAgentCommand,
              timeout: 5000,
            },
          ],
        },
      ],
      Notification: [
        {
          matcher: 'ToolPermission',
          hooks: [
            {
              name: 'remote-notifier-notification',
              type: 'command',
              command: notificationCommand,
              timeout: 5000,
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
