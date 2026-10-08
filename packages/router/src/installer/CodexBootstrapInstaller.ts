import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import type * as vscode from 'vscode';

const MARKER = 'REMOTE_NOTIFIER_STARTUP_BOOTSTRAP';

export function wrapNpmCodexLauncher(original: string, platform: 'cmd' | 'powershell'): string {
  if (original.includes(MARKER)) return original;
  if (platform === 'cmd')
    return [
      '@echo off',
      `rem ${MARKER}`,
      'if /I not "%TERM_PROGRAM%"=="vscode" goto remote_notifier_original',
      'if not exist "%USERPROFILE%\\.local\\bin\\codex-notifier-bootstrap.js" goto remote_notifier_original',
      'node.exe "%USERPROFILE%\\.local\\bin\\codex-notifier-bootstrap.js" --real "%~dp0codex.cmd" -- %*',
      'exit /b %ERRORLEVEL%',
      ':remote_notifier_original',
      original,
    ].join('\r\n');
  return [
    `# ${MARKER}`,
    '$notifierBootstrap = Join-Path $env:USERPROFILE ".local\\bin\\codex-notifier-bootstrap.js"',
    'if ($env:TERM_PROGRAM -eq "vscode" -and (Test-Path -LiteralPath $notifierBootstrap)) {',
    '  & node.exe $notifierBootstrap --real (Join-Path $PSScriptRoot "codex.cmd") -- @args',
    '  exit $LASTEXITCODE',
    '}',
    original,
  ].join('\r\n');
}

export function createUnixCodexLauncher(bootstrap: string, original: string): string {
  return [
    '#!/bin/sh',
    `# ${MARKER}`,
    'if [ "${TERM_PROGRAM:-}" = vscode ] && [ -f ' + quote(bootstrap) + ' ]; then',
    `  exec node ${quote(bootstrap)} --real ${quote(original)} -- "$@"`,
    'fi',
    `exec node ${quote(original)} "$@"`,
    '',
  ].join('\n');
}

export class CodexBootstrapInstaller {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log?: vscode.OutputChannel,
  ) {}

  async install(): Promise<void> {
    const bin = path.join(os.homedir(), '.local', 'bin');
    const source = path.join(this.context.extensionPath, 'dist', 'codex-notifier-bootstrap.js');
    await fs.mkdir(bin, { recursive: true, mode: 0o700 });
    const script = path.join(bin, 'codex-notifier-bootstrap.js');
    const temporary = `${script}.${process.pid}.tmp`;
    await fs.copyFile(source, temporary);
    await fs.rename(temporary, script);
    if (process.platform === 'win32') {
      await fs.writeFile(
        path.join(bin, 'codex-notifier.cmd'),
        ['@echo off', `node.exe "${script}" %*`, 'exit /b %ERRORLEVEL%', ''].join('\r\n'),
      );
      await this.installWindowsAdapters();
    } else {
      const launcher = path.join(bin, 'codex-notifier');
      await fs.writeFile(
        launcher,
        [
          '#!/bin/sh',
          `if command -v node >/dev/null 2>&1; then exec node ${quote(script)} "$@"; fi`,
          `exec ${quote(process.execPath)} ${quote(script)} "$@"`,
          '',
        ].join('\n'),
        { mode: 0o755 },
      );
      await fs.chmod(launcher, 0o755);
      await this.installUnixAdapters(script);
    }
    this.log?.appendLine('[CodexBootstrap] Installed startup-safe launcher');
  }

  private async installUnixAdapters(bootstrap: string): Promise<void> {
    for (const directory of new Set(
      (process.env.PATH ?? '').split(path.delimiter).filter(Boolean),
    )) {
      const file = path.resolve(directory, 'codex');
      // Replace only user-owned npm symlinks, never a custom script or the package's JavaScript.
      if (!file.startsWith(`${os.homedir()}${path.sep}`)) continue;
      try {
        if (!(await fs.lstat(file)).isSymbolicLink()) continue;
        const original = await fs.realpath(file);
        if (!/\/node_modules\/@openai\/codex\/bin\/codex\.js$/.test(original)) continue;
        await fs
          .symlink(await fs.readlink(file), `${file}.before-remote-notifier-startup`)
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'EEXIST') throw error;
          });
        const temporary = `${file}.${process.pid}.tmp`;
        await fs.writeFile(temporary, createUnixCodexLauncher(bootstrap, original), {
          mode: 0o755,
        });
        await fs.rename(temporary, file);
        this.log?.appendLine('[CodexBootstrap] Wrapped npm codex with original symlink preserved');
      } catch {
        // PATH also contains directories without a Codex installation.
      }
    }
  }

  private async installWindowsAdapters(): Promise<void> {
    const directories = new Set((process.env.PATH ?? '').split(path.delimiter).filter(Boolean));
    if (process.env.APPDATA) directories.add(path.join(process.env.APPDATA, 'npm'));
    for (const directory of directories) {
      const module = path.join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      if (
        !(await fs.access(module).then(
          () => true,
          () => false,
        ))
      )
        continue;
      for (const [name, platform] of [
        ['codex.cmd', 'cmd'],
        ['codex.ps1', 'powershell'],
      ] as const) {
        const file = path.join(directory, name);
        try {
          const original = await fs.readFile(file, 'utf8');
          if (original.includes(MARKER)) continue;
          if (!/node_modules[\\/]@openai[\\/]codex[\\/]bin[\\/]codex\.js/.test(original)) continue;
          // Do not bypass a user's custom account or proxy setup by replacing its entry point.
          if (/CODEX_HOME\s*=|codex-vpn-session|codex-session-sync/i.test(original)) continue;
          const backup = `${file}.before-remote-notifier-startup`;
          await fs
            .copyFile(file, backup, fs.constants.COPYFILE_EXCL)
            .catch((error: NodeJS.ErrnoException) => {
              if (error.code !== 'EEXIST') throw error;
            });
          const temporary = `${file}.${process.pid}.tmp`;
          await fs.writeFile(temporary, wrapNpmCodexLauncher(original, platform), 'utf8');
          await fs.rename(temporary, file);
          this.log?.appendLine(
            `[CodexBootstrap] Wrapped npm ${name} with original content preserved`,
          );
        } catch {
          this.log?.appendLine(`[CodexBootstrap] Could not update npm ${name}`);
        }
      }
    }
  }
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
