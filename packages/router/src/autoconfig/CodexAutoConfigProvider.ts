import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { window } from 'vscode';

import { SCRIPT_NAME } from '../installer/CodeNotifyScriptInstaller';
import {
  CODEX_ATTENTION_HOOK_NAME,
  CodexAttentionHookInstaller,
  getCodexAttentionHookPath,
  getCodexAttentionHookWindowsPath,
} from '../installer/CodexAttentionHookInstaller';
import { BaseAutoConfigProvider, Platform, ProcessResult } from './BaseAutoConfigProvider';

interface HookEntry {
  matcher?: string;
  hooks: HookCommand[];
  [key: string]: unknown;
}

interface HookCommand {
  type: string;
  command: string;
  timeout: number;
  [key: string]: unknown;
}

interface CodexHooksConfig {
  hooks?: Record<string, HookEntry[]>;
  [key: string]: unknown;
}

export function resolveCodexHome(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = os.homedir(),
): string {
  const configuredHome = environment.CODEX_HOME?.trim();
  return configuredHome ? path.resolve(configuredHome) : path.join(homeDirectory, '.codex');
}

const CODEX_HOME_PATH = resolveCodexHome();
const HOOKS_CONFIG_PATH = path.join(CODEX_HOME_PATH, 'hooks.json');
const TOML_CONFIG_PATH = path.join(CODEX_HOME_PATH, 'config.toml');

export class CodexAutoConfigProvider extends BaseAutoConfigProvider {
  readonly id = 'codex';
  readonly label = 'Codex';
  readonly description = 'Configure Codex hooks to send notifications';

  constructor(
    log?: import('vscode').OutputChannel,
    private readonly hookInstaller = new CodexAttentionHookInstaller(log),
  ) {
    super(log);
  }

  async configure(): Promise<void> {
    try {
      await this.hookInstaller.ensureInstalled();
    } catch (error) {
      window.showErrorMessage(`Failed to install the Codex attention helper: ${error}`);
      return;
    }
    await super.configure();
  }

  async unconfigure(): Promise<void> {
    let raw = '{}';
    try {
      raw = await fs.readFile(HOOKS_CONFIG_PATH, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        window.showErrorMessage(`Failed to read Codex hooks at ${HOOKS_CONFIG_PATH}: ${error}`);
        return;
      }
    }

    const result = this.removeOwnedHooks(raw);
    if (result === null) return;

    try {
      if (result.changed) {
        await fs.writeFile(HOOKS_CONFIG_PATH, result.content, 'utf-8');
      }
      await this.hookInstaller.uninstall();
      window.showInformationMessage(
        result.changed
          ? 'Remote Notifier: Removed Codex notification hooks and helper.'
          : 'Remote Notifier: Codex notification hooks were not installed; helper removed.',
      );
    } catch (error) {
      window.showErrorMessage(`Failed to remove the Codex notification configuration: ${error}`);
    }
  }

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

    const hooks = hooksConfig.hooks;

    for (const [category, entries] of Object.entries(desiredHooks)) {
      if (!hooks[category]) {
        hooks[category] = [];
      }
      const existing = hooks[category];

      for (const entry of entries) {
        const idx = existing.findIndex(
          (e: HookEntry) => this.isOwnedHook(e) && this.matchesMatcher(e, entry),
        );

        if (idx === -1) {
          existing.push(entry);
          added++;
        } else {
          const merged = this.replaceOwnedCommands(existing[idx], entry);
          if (this.isIdentical(existing[idx], merged)) {
            skipped++;
            continue;
          }
          existing[idx] = merged;
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

  removeOwnedHooks(raw: string): { content: string; changed: boolean } | null {
    let config: CodexHooksConfig;
    try {
      config = JSON.parse(raw || '{}');
    } catch {
      window.showErrorMessage(
        `Codex hooks at ${HOOKS_CONFIG_PATH} contains invalid JSON. Please fix it manually.`,
      );
      return null;
    }

    if (!config.hooks) return { content: raw, changed: false };
    let changed = false;

    for (const [category, entries] of Object.entries(config.hooks)) {
      const remaining: HookEntry[] = [];
      for (const entry of entries) {
        const commands = entry.hooks.filter((hook) => !this.isOwnedCommand(hook));
        if (commands.length !== entry.hooks.length) changed = true;
        if (commands.length > 0) remaining.push({ ...entry, hooks: commands });
      }
      if (remaining.length > 0) config.hooks[category] = remaining;
      else if (entries.length > 0 && remaining.length === 0) delete config.hooks[category];
    }

    return {
      content: changed ? JSON.stringify(config, null, 2) + '\n' : raw,
      changed,
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
    void useJq;
    const hookPath = getCodexAttentionHookPath();
    const command =
      platform === 'windows'
        ? getCodexAttentionHookWindowsPath().replace(/\\/g, '/')
        : `${hookPath} 2>/dev/null || true`;
    const hook = (): HookCommand => ({ type: 'command', command, timeout: 3 });

    return {
      Stop: [
        {
          hooks: [hook()],
        },
      ],
      PreToolUse: [
        {
          matcher: '^request_user_input$',
          hooks: [hook()],
        },
      ],
      PermissionRequest: [
        {
          hooks: [hook()],
        },
      ],
    };
  }

  protected async checkJqAvailable(): Promise<boolean> {
    return false;
  }

  private isOwnedHook(entry: HookEntry): boolean {
    return entry.hooks?.some((hook) => this.isOwnedCommand(hook)) ?? false;
  }

  private isOwnedCommand(hook: HookCommand): boolean {
    return (
      hook.command?.includes(CODEX_ATTENTION_HOOK_NAME) ||
      (hook.command?.includes(SCRIPT_NAME) && hook.command.includes('ICON_CODEX'))
    );
  }

  private replaceOwnedCommands(existing: HookEntry, desired: HookEntry): HookEntry {
    const userCommands = existing.hooks.filter((hook) => !this.isOwnedCommand(hook));
    return {
      ...existing,
      ...(desired.matcher === undefined ? {} : { matcher: desired.matcher }),
      hooks: [...userCommands, ...desired.hooks],
    };
  }

  private matchesMatcher(a: HookEntry, b: HookEntry): boolean {
    return (a.matcher ?? '') === (b.matcher ?? '');
  }

  private isIdentical(a: HookEntry, b: HookEntry): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
  }
}
