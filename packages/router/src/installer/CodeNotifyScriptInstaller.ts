import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

import * as vscode from 'vscode';

import { fileExists } from 'remote-notifier-shared';

import windowsScript from './code-notify.cmd';
import unixScript from './code-notify.sh';

const execFileAsync = promisify(execFile);

export const SCRIPT_NAME = 'code-notify';

export function getBinDir(): string {
  if (process.platform === 'win32') {
    return path.join(
      process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
      'RemoteNotifier',
      'bin',
    );
  }
  return path.join(os.homedir(), '.local', 'bin');
}

export class CodeNotifyScriptInstaller {
  private readonly binDir = getBinDir();

  constructor(private readonly log?: vscode.OutputChannel) {}

  async isInstalled(): Promise<boolean> {
    const isWindows = process.platform === 'win32';
    const fileName = isWindows ? `${SCRIPT_NAME}.cmd` : SCRIPT_NAME;
    const scriptPath = path.join(this.binDir, fileName);

    if (!(await fileExists(scriptPath))) {
      return false;
    }

    // Also check if it's on PATH
    const dirs = (process.env.PATH ?? '').split(path.delimiter);
    return dirs.includes(this.binDir);
  }

  async needsUpdate(): Promise<boolean> {
    const isWindows = process.platform === 'win32';
    const fileName = isWindows ? `${SCRIPT_NAME}.cmd` : SCRIPT_NAME;
    const scriptPath = path.join(this.binDir, fileName);

    try {
      const installedContent = await fs.readFile(scriptPath, 'utf-8');
      const bundledContent = isWindows ? windowsScript : unixScript;

      // Normalize line endings for comparison
      const normalize = (str: string) => str.replace(/\r\n/g, '\n').trim();

      return normalize(installedContent) !== normalize(bundledContent);
    } catch {
      // If we can't read it, assume it needs "installation" (which is an update)
      return true;
    }
  }

  async install(silent: boolean = false, isUpdate: boolean = false): Promise<void> {
    const isWindows = process.platform === 'win32';
    const action = isUpdate ? 'Updating' : 'Installing';
    this.log?.appendLine(
      `[CodeNotifyScriptInstaller] ${action} ${SCRIPT_NAME} to ${this.binDir} (platform: ${process.platform})`,
    );

    await fs.mkdir(this.binDir, { recursive: true });

    const fileName = isWindows ? `${SCRIPT_NAME}.cmd` : SCRIPT_NAME;
    const scriptPath = path.join(this.binDir, fileName);
    const content = isWindows ? windowsScript : unixScript;

    await fs.writeFile(scriptPath, content, { mode: 0o755 });
    this.log?.appendLine(`[CodeNotifyScriptInstaller] Wrote script to ${scriptPath}`);

    const pathNote = await this.ensureOnPath(isWindows);

    if (isUpdate) {
      if (!silent) {
        vscode.window.showInformationMessage(
          `Remote Notifier: Updated \`${SCRIPT_NAME}\` to the latest version.`,
        );
      }
      return;
    }

    const messages = [`Installed \`${SCRIPT_NAME}\` to ${this.binDir}.`];
    if (pathNote) {
      messages.push(pathNote);
    }
    messages.push('Usage: `code-notify "Title" "Message"`');

    if (!silent) {
      vscode.window.showInformationMessage(messages.join('\n'));
    }
  }

  private async ensureOnPath(isWindows: boolean): Promise<string | null> {
    const dirs = (process.env.PATH ?? '').split(path.delimiter);
    if (dirs.includes(this.binDir)) {
      this.log?.appendLine('[CodeNotifyScriptInstaller] binDir already on PATH');
      return null;
    }

    return isWindows ? this.addToPathWindows() : this.addToPathUnix();
  }

  private async addToPathWindows(): Promise<string> {
    this.log?.appendLine('[CodeNotifyScriptInstaller] Adding to Windows user PATH via PowerShell');
    try {
      const escapedDir = this.binDir.replace(/'/g, "''");
      const script = [
        `$cur = [Environment]::GetEnvironmentVariable('PATH', 'User');`,
        `if ($cur -notlike '*${escapedDir}*') {`,
        `  $sep = if ($cur -and -not $cur.EndsWith(';')) {';'} else {''};`,
        `  [Environment]::SetEnvironmentVariable('PATH', $cur + $sep + '${escapedDir}', 'User')`,
        `}`,
      ].join(' ');
      await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
      this.log?.appendLine('[CodeNotifyScriptInstaller] Windows user PATH updated');
      return 'Restart your terminal for PATH changes to take effect.';
    } catch (err) {
      this.log?.appendLine(`[CodeNotifyScriptInstaller] Failed to update Windows PATH: ${err}`);
      return `Add \`${this.binDir}\` to your PATH manually.`;
    }
  }

  private async addToPathUnix(): Promise<string> {
    const exportLine = `export PATH="${this.binDir}:$PATH"`;
    const rcFiles = this.getShellRcFiles();

    for (const rcFile of rcFiles) {
      try {
        const existing = await fs.readFile(rcFile, 'utf-8').catch(() => '');
        if (existing.includes(this.binDir)) {
          this.log?.appendLine(`[CodeNotifyScriptInstaller] ${rcFile} already contains binDir`);
          continue;
        }
        await fs.appendFile(rcFile, `\n# Added by Remote Notifier\n${exportLine}\n`);
        this.log?.appendLine(`[CodeNotifyScriptInstaller] Appended PATH to ${rcFile}`);
      } catch (err) {
        this.log?.appendLine(`[CodeNotifyScriptInstaller] Failed to update ${rcFile}: ${err}`);
      }
    }

    const name = path.basename(rcFiles[0]);
    return `Restart your terminal or run \`source ~/${name}\` for PATH changes.`;
  }

  private getShellRcFiles(): string[] {
    const home = os.homedir();
    const shell = process.env.SHELL ?? '';
    const files: string[] = [];

    if (shell.includes('zsh')) {
      files.push(path.join(home, '.zshrc'));
    }
    if (shell.includes('bash') || files.length === 0) {
      files.push(path.join(home, '.bashrc'));
    }

    return files;
  }
}
