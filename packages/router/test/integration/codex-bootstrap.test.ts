import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

import {
  createUnixCodexLauncher,
  wrapNpmCodexLauncher,
} from '../../src/installer/CodexBootstrapInstaller';
import { readTerminalProcessIdentity } from '../../src/terminal/TerminalProcessIdentity';

describe('Codex bootstrap process boundary', () => {
  it
    .skipIf(process.platform === 'darwin')
    .each(
      process.platform === 'win32'
        ? ['bootstrap', 'npm-cmd', 'npm-powershell']
        : ['bootstrap', 'npm-unix', 'private-shim'],
    )(
    'repairs expired startup environment through %s without starting two frontends',
    async (entry) => {
      const home = await fs.mkdtemp(path.join(os.tmpdir(), 'notifier-bootstrap-'));
      const server = http.createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"ok":true}');
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('No health endpoint');
        const identity = await readTerminalProcessIdentity(process.pid);
        expect(identity).toBeDefined();
        const directory = path.join(home, '.remote-notifier', 'sessions');
        await fs.mkdir(directory, { recursive: true });
        const current = path.join(directory, 'current.json');
        const inherited = path.join(directory, 'expired.json');
        const bundle = path.join(home, 'bootstrap.js');
        const sidecar = path.resolve('packages/router/dist/codex-notifier-sidecar.js');
        await fs.writeFile(
          current,
          JSON.stringify({
            port: address.port,
            token: 'a'.repeat(64),
            pid: process.pid,
            terminalProcesses: [{ pid: process.pid, identity }],
            codexLauncher: {
              mode: 'compatibility',
              sidecarPath: sidecar,
              shimDirectory: path.join(home, 'shim'),
            },
          }),
        );
        await fs.writeFile(inherited, JSON.stringify({ port: 1, token: 'b'.repeat(64), pid: 1 }));
        const executable = path.join(home, 'codex.cmd');
        const npmScript = path.join(home, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
        const probes = path.join(home, 'version-probes.log');
        await fs.mkdir(path.dirname(npmScript), { recursive: true });
        await fs.writeFile(executable, '');
        await fs.writeFile(
          npmScript,
          [
            'const args = process.argv.slice(2);',
            `if (args.length === 1 && args[0] === "--version") { require('fs').appendFileSync(${JSON.stringify(probes)}, 'probe\\n'); console.log("codex-cli 0.160.0"); }`,
            'else console.log(JSON.stringify({args, route: process.env.REMOTE_NOTIFIER_SESSION_FILE, mode: process.env.REMOTE_NOTIFIER_CODEX_PROTOCOL_MONITORING}));',
          ].join('\n'),
        );
        await build({
          entryPoints: [path.resolve('packages/router/src/sidecar/codex-notifier-bootstrap.ts')],
          bundle: true,
          platform: 'node',
          format: 'cjs',
          target: 'node18',
          outfile: bundle,
          logLevel: 'silent',
        });
        const installed = path.join(home, '.local', 'bin', 'codex-notifier-bootstrap.js');
        await fs.mkdir(path.dirname(installed), { recursive: true });
        await fs.copyFile(bundle, installed);
        const powershell = path.join(home, 'codex.ps1');
        await fs.writeFile(
          executable,
          wrapNpmCodexLauncher(
            '@echo off\r\nnode "%~dp0node_modules\\@openai\\codex\\bin\\codex.js" %*',
            'cmd',
          ),
        );
        await fs.writeFile(
          powershell,
          wrapNpmCodexLauncher(
            '& node.exe "$PSScriptRoot/node_modules/@openai/codex/bin/codex.js" @args',
            'powershell',
          ),
        );
        const unix = path.join(home, 'codex');
        await fs.writeFile(unix, createUnixCodexLauncher(installed, npmScript), { mode: 0o755 });
        if (process.platform !== 'win32')
          await fs.symlink(npmScript, `${unix}.before-remote-notifier-startup`);
        const command =
          entry === 'npm-cmd'
            ? (process.env.ComSpec ?? 'cmd.exe')
            : entry === 'npm-powershell'
              ? 'powershell.exe'
              : entry === 'npm-unix'
                ? unix
                : process.execPath;
        const codexArgs = ['resume', 'session-id', 'hello with spaces'];
        const arguments_ =
          entry === 'npm-cmd'
            ? ['/d', '/s', '/c', `""${executable}" resume session-id "hello with spaces""`]
            : entry === 'npm-powershell'
              ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', powershell, ...codexArgs]
              : entry === 'npm-unix'
                ? codexArgs
                : entry === 'private-shim'
                  ? [bundle, '--shim-dir', path.join(home, 'shim'), '--', ...codexArgs]
                  : [bundle, '--real', executable, '--', ...codexArgs];
        const child = spawn(command, arguments_, {
          env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            TERM_PROGRAM: 'vscode',
            PATH: [home, process.env.PATH].join(path.delimiter),
            REMOTE_NOTIFIER_CODEX_REAL: undefined,
            REMOTE_NOTIFIER_SESSION_FILE: inherited,
            REMOTE_NOTIFIER_CODEX_PROTOCOL_MONITORING: undefined,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          windowsVerbatimArguments: entry === 'npm-cmd',
        });
        let stdout = '',
          stderr = '';
        child.stdout.on('data', (chunk) => {
          stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
          stderr += chunk;
        });
        const timeout = setTimeout(() => child.kill(), 15000);
        const code = await new Promise<number | null>((resolve, reject) => {
          child.once('error', reject);
          child.once('exit', resolve);
        }).finally(() => clearTimeout(timeout));
        expect(code, stderr).toBe(0);
        expect(stderr).toBe('');
        const lines = stdout.trim().split(/\r?\n/);
        expect(lines).toHaveLength(1);
        expect(JSON.parse(lines[0])).toEqual({
          args: ['--no-daemon', ...codexArgs],
          route: current,
          mode: '0',
        });
        expect(await fs.readFile(probes, 'utf8')).toBe('probe\n');
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await fs.rm(home, { recursive: true, force: true });
      }
    },
    20000,
  );
});
