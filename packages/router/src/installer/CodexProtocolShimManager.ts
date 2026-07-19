import * as fs from 'fs/promises';
import * as path from 'path';

import * as vscode from 'vscode';

import { fileExists } from 'remote-notifier-shared';

const UNIX_SHIM_NAME = 'codex';
const WINDOWS_SHIM_NAME = 'codex.cmd';
const SIDECAR_NAME = 'codex-notifier-sidecar.js';
const ELECTRON_NODE_MARKER = 'REMOTE_NOTIFIER_CODEX_ELECTRON_NODE_SHIM';

export class CodexProtocolShimManager {
  readonly shimDirectory: string;
  private readonly unixShimPath: string;
  private readonly windowsShimPath: string;
  private readonly sidecarPath: string;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log?: vscode.OutputChannel,
  ) {
    this.shimDirectory = path.join(context.globalStorageUri.fsPath, 'codex-shim');
    this.unixShimPath = path.join(this.shimDirectory, UNIX_SHIM_NAME);
    this.windowsShimPath = path.join(this.shimDirectory, WINDOWS_SHIM_NAME);
    this.sidecarPath = path.join(context.extensionPath, 'dist', SIDECAR_NAME);
  }

  async enable(): Promise<void> {
    await this.install();
    const collection = this.context.environmentVariableCollection;
    collection.delete('PATH');
    collection.prepend('PATH', `${this.shimDirectory}${path.delimiter}`);
    this.log?.appendLine(
      `[CodexProtocolShim] Enabled for new integrated terminals via ${this.shimDirectory}`,
    );
  }

  async disable(removeFiles = false): Promise<void> {
    this.context.environmentVariableCollection.delete('PATH');
    if (removeFiles) {
      await Promise.all([
        unlinkIfPresent(this.unixShimPath),
        unlinkIfPresent(this.windowsShimPath),
      ]);
    }
    this.log?.appendLine('[CodexProtocolShim] Disabled for new integrated terminals');
  }

  async isInstalled(): Promise<boolean> {
    const [unixInstalled, windowsInstalled, sidecarInstalled] = await Promise.all([
      fileExists(this.unixShimPath),
      fileExists(this.windowsShimPath),
      fileExists(this.sidecarPath),
    ]);
    return unixInstalled && windowsInstalled && sidecarInstalled;
  }

  private async install(): Promise<void> {
    if (!(await fileExists(this.sidecarPath))) {
      throw new Error(`Codex protocol sidecar is missing at ${this.sidecarPath}`);
    }
    await fs.mkdir(this.shimDirectory, { recursive: true, mode: 0o700 });

    const executable = process.execPath;
    const sidecarArguments = `${quoteShell(this.sidecarPath)} --shim-dir ${quoteShell(
      this.shimDirectory,
    )} -- "$@"`;
    const unixScript = [
      '#!/bin/sh',
      'if command -v node >/dev/null 2>&1; then',
      `  exec node ${sidecarArguments}`,
      'fi',
      `export ${ELECTRON_NODE_MARKER}=1`,
      'export ELECTRON_RUN_AS_NODE=1',
      `exec ${quoteShell(executable)} ${sidecarArguments}`,
      '',
    ].join('\n');
    const windowsArguments = `"${escapeBatchPath(
      this.sidecarPath,
    )}" --shim-dir "${escapeBatchPath(this.shimDirectory)}" -- %*`;
    const windowsScript = [
      '@echo off',
      'setlocal',
      'where.exe node.exe >nul 2>nul',
      'if errorlevel 1 goto electron_node',
      `node.exe ${windowsArguments}`,
      'exit /b %errorlevel%',
      ':electron_node',
      `set "${ELECTRON_NODE_MARKER}=1"`,
      'set "ELECTRON_RUN_AS_NODE=1"',
      `"${escapeBatchPath(executable)}" ${windowsArguments}`,
      'exit /b %errorlevel%',
      '',
    ].join('\r\n');

    await Promise.all([
      fs.writeFile(this.unixShimPath, unixScript, { mode: 0o755 }),
      fs.writeFile(this.windowsShimPath, windowsScript, { mode: 0o755 }),
    ]);
    await Promise.all([
      fs.chmod(this.unixShimPath, 0o755).catch(() => {}),
      fs.chmod(this.windowsShimPath, 0o755).catch(() => {}),
    ]);
  }
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function escapeBatchPath(value: string): string {
  return value.replace(/%/g, '%%').replace(/"/g, '""');
}

async function unlinkIfPresent(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
