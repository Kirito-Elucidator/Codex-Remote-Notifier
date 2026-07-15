import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import * as vscode from 'vscode';

import {
  ENV_CODEX_PREVIEW_LENGTH,
  ENV_PORT,
  ENV_SESSION_FILE,
  ENV_TOKEN,
  ENV_URL,
  SESSION_DIR,
  SESSION_FILE,
  SESSION_SCOPES_DIR,
  SessionInfo,
} from 'remote-notifier-shared';

export interface SessionManagerOptions {
  sessionFilePath?: string;
  legacySessionFilePath?: string;
  codexPreviewLength?: number;
}

export class SessionManager implements vscode.Disposable {
  private _token: string;
  private sessionFilePath: string;
  private legacySessionFilePath: string;
  private workspaceFolders: string[];
  private workspaceKey: string;
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
    this.workspaceFolders = this.getWorkspaceFolders();
    this.workspaceKey = this.createWorkspaceKey(this.workspaceFolders);
    const sessionDirectory = path.join(os.homedir(), SESSION_DIR);
    this.sessionFilePath =
      options?.sessionFilePath ??
      path.join(sessionDirectory, SESSION_SCOPES_DIR, `${this.workspaceKey}.json`);
    this.legacySessionFilePath =
      options?.legacySessionFilePath ??
      (options?.sessionFilePath
        ? options.sessionFilePath
        : path.join(sessionDirectory, SESSION_FILE));
    this.codexPreviewLength = this.normalizePreviewLength(options?.codexPreviewLength ?? 16);
    this.envCollection = context.environmentVariableCollection;
  }

  async initialize(port: number): Promise<void> {
    await Promise.all(
      this.sessionFilePaths().map((filePath) => this.cleanupStaleSession(filePath)),
    );
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
    await Promise.all(
      this.sessionFilePaths().map((filePath) => this.removeOwnedSessionFile(filePath)),
    );
    this.envCollection.clear();
  }

  getSessionFilePath(): string {
    return this.sessionFilePath;
  }

  private generateToken(): string {
    return randomBytes(32).toString('hex');
  }

  private async writeSessionFile(port: number): Promise<void> {
    const info: SessionInfo = {
      port,
      token: this._token,
      pid: process.pid,
      workspaceFolder: this.workspaceFolders[0] ?? '',
      workspaceFolders: this.workspaceFolders,
      workspaceKey: this.workspaceKey,
      createdAt: new Date().toISOString(),
      codexPreviewLength: this.codexPreviewLength,
    };

    await Promise.all(
      this.sessionFilePaths().map(async (filePath) => {
        await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
        await fs.writeFile(filePath, JSON.stringify(info, null, 2), { mode: 0o600 });
      }),
    );
  }

  private async removeOwnedSessionFile(filePath: string): Promise<void> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const info: SessionInfo = JSON.parse(content);
      if (info.token === this._token && info.pid === process.pid) {
        await fs.unlink(filePath);
      }
    } catch {
      // File may not exist, that's fine
    }
  }

  private async cleanupStaleSession(filePath: string): Promise<void> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const info: SessionInfo = JSON.parse(content);
      if (!this.isProcessRunning(info.pid)) {
        await fs.unlink(filePath);
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
    this.envCollection.replace(ENV_SESSION_FILE, this.sessionFilePath);
    this.envCollection.replace(ENV_CODEX_PREVIEW_LENGTH, String(this.codexPreviewLength));
  }

  private sessionFilePaths(): string[] {
    return [...new Set([this.sessionFilePath, this.legacySessionFilePath])];
  }

  private getWorkspaceFolders(): string[] {
    return (vscode.workspace.workspaceFolders ?? [])
      .map((folder) => folder.uri.fsPath)
      .filter(Boolean);
  }

  private createWorkspaceKey(workspaceFolders: string[]): string {
    const identity = workspaceFolders.length
      ? workspaceFolders.map((folder) => this.normalizeWorkspacePath(folder)).sort()
      : [this.context.storageUri?.fsPath ?? 'empty-window'];
    return createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 32);
  }

  private normalizeWorkspacePath(value: string): string {
    const normalized = path.resolve(value).replaceAll('\\', '/');
    return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
  }

  private normalizePreviewLength(value: number): number {
    if (!Number.isFinite(value)) return 16;
    return Math.max(1, Math.min(100, Math.trunc(value)));
  }
}
