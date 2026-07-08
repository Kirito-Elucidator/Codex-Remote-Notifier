import { randomBytes } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import * as vscode from 'vscode';

import {
  ENV_CODEX_PREVIEW_LENGTH,
  ENV_PORT,
  ENV_TOKEN,
  ENV_URL,
  SESSION_DIR,
  SESSION_FILE,
  SessionInfo,
} from 'remote-notifier-shared';

export interface SessionManagerOptions {
  sessionFilePath?: string;
  codexPreviewLength?: number;
}

export class SessionManager implements vscode.Disposable {
  private _token: string;
  private sessionFilePath: string;
  private envCollection: vscode.EnvironmentVariableCollection;
  private codexPreviewLength: number;

  get token(): string {
    return this._token;
  }

  constructor(
    private readonly context: vscode.ExtensionContext,
    options?: SessionManagerOptions,
  ) {
    this._token = this.generateToken();
    this.sessionFilePath =
      options?.sessionFilePath ?? path.join(os.homedir(), SESSION_DIR, SESSION_FILE);
    this.codexPreviewLength = this.normalizePreviewLength(options?.codexPreviewLength ?? 16);
    this.envCollection = context.environmentVariableCollection;
  }

  async initialize(port: number): Promise<void> {
    await this.cleanupStaleSession();
    await this.writeSessionFile(port);
    this.setEnvironmentVariables(port);
  }

  async regenerateToken(port: number): Promise<void> {
    this._token = this.generateToken();
    await this.writeSessionFile(port);
    this.setEnvironmentVariables(port);
  }

  async updateCodexPreviewLength(length: number, port: number): Promise<void> {
    this.codexPreviewLength = this.normalizePreviewLength(length);
    await this.writeSessionFile(port);
    this.setEnvironmentVariables(port);
  }

  async dispose(): Promise<void> {
    await this.removeSessionFile();
    this.envCollection.clear();
  }

  getSessionFilePath(): string {
    return this.sessionFilePath;
  }

  private generateToken(): string {
    return randomBytes(32).toString('hex');
  }

  private async writeSessionFile(port: number): Promise<void> {
    const dir = path.dirname(this.sessionFilePath);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

    const info: SessionInfo = {
      port,
      token: this._token,
      pid: process.pid,
      workspaceFolder,
      createdAt: new Date().toISOString(),
      codexPreviewLength: this.codexPreviewLength,
    };

    await fs.writeFile(this.sessionFilePath, JSON.stringify(info, null, 2), {
      mode: 0o600,
    });
  }

  private async removeSessionFile(): Promise<void> {
    try {
      await fs.unlink(this.sessionFilePath);
    } catch {
      // File may not exist, that's fine
    }
  }

  private async cleanupStaleSession(): Promise<void> {
    try {
      const content = await fs.readFile(this.sessionFilePath, 'utf-8');
      const info: SessionInfo = JSON.parse(content);
      if (!this.isProcessRunning(info.pid)) {
        await fs.unlink(this.sessionFilePath);
      }
    } catch {
      // No existing session file or parse error
    }
  }

  private isProcessRunning(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private setEnvironmentVariables(port: number): void {
    this.envCollection.replace(ENV_PORT, String(port));
    this.envCollection.replace(ENV_TOKEN, this._token);
    this.envCollection.replace(ENV_URL, `http://127.0.0.1:${port}/notify`);
    this.envCollection.replace(ENV_CODEX_PREVIEW_LENGTH, String(this.codexPreviewLength));
  }

  private normalizePreviewLength(value: number): number {
    if (!Number.isFinite(value)) return 16;
    return Math.max(1, Math.min(100, Math.trunc(value)));
  }
}
