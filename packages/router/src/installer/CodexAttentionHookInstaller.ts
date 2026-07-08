import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import * as vscode from 'vscode';

import { fileExists } from 'remote-notifier-shared';

import windowsHookScript from './codex-attention-hook.cmd';
import hookScript from './codex-attention-hook.py';

export const CODEX_ATTENTION_HOOK_NAME = 'codex-attention-hook';
export const CODEX_ATTENTION_HOOK_WINDOWS_NAME = 'codex-attention-hook.cmd';

export function getCodexAttentionHookPath(): string {
  return path.join(os.homedir(), '.local', 'bin', CODEX_ATTENTION_HOOK_NAME);
}

export function getCodexAttentionHookWindowsPath(): string {
  return path.join(os.homedir(), '.local', 'bin', CODEX_ATTENTION_HOOK_WINDOWS_NAME);
}

export class CodexAttentionHookInstaller {
  constructor(private readonly log?: vscode.OutputChannel) {}

  async isInstalled(): Promise<boolean> {
    const installed = await Promise.all([
      fileExists(getCodexAttentionHookPath()),
      fileExists(getCodexAttentionHookWindowsPath()),
    ]);
    return installed.every(Boolean);
  }

  async needsUpdate(): Promise<boolean> {
    try {
      const [installedHook, installedWindowsHook] = await Promise.all([
        fs.readFile(getCodexAttentionHookPath(), 'utf-8'),
        fs.readFile(getCodexAttentionHookWindowsPath(), 'utf-8'),
      ]);
      return (
        this.normalize(installedHook) !== this.normalize(hookScript) ||
        this.normalize(installedWindowsHook) !== this.normalize(windowsHookScript)
      );
    } catch {
      return true;
    }
  }

  async install(silent = false): Promise<void> {
    const scriptPath = getCodexAttentionHookPath();
    const windowsScriptPath = getCodexAttentionHookWindowsPath();
    await fs.mkdir(path.dirname(scriptPath), { recursive: true });
    await Promise.all([
      fs.writeFile(scriptPath, hookScript, { mode: 0o755 }),
      fs.writeFile(windowsScriptPath, windowsHookScript, { mode: 0o755 }),
    ]);
    await Promise.all([
      fs.chmod(scriptPath, 0o755).catch(() => {}),
      fs.chmod(windowsScriptPath, 0o755).catch(() => {}),
    ]);
    this.log?.appendLine(
      `[CodexAttentionHookInstaller] Installed ${scriptPath} and ${windowsScriptPath}`,
    );
    if (!silent) {
      vscode.window.showInformationMessage(
        `Remote Notifier: Installed Codex attention helper to ${scriptPath}.`,
      );
    }
  }

  async ensureInstalled(): Promise<void> {
    if (!(await this.isInstalled()) || (await this.needsUpdate())) {
      await this.install(true);
    }
  }

  async uninstall(): Promise<void> {
    const paths = [getCodexAttentionHookPath(), getCodexAttentionHookWindowsPath()];
    await Promise.all(
      paths.map((scriptPath) =>
        fs.unlink(scriptPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        }),
      ),
    );
    this.log?.appendLine(`[CodexAttentionHookInstaller] Removed ${paths.join(' and ')}`);
  }

  private normalize(value: string): string {
    return value.replace(/\r\n/g, '\n').trim();
  }
}
