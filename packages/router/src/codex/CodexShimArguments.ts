import * as path from 'path';

export interface CodexProtocolInvocation {
  mode: 'protocol';
  command: 'tui' | 'resume' | 'fork';
  cwd: string;
  appServerArgs: string[];
  tuiArgs: string[];
}

export interface CodexPassthroughInvocation {
  mode: 'passthrough';
  reason: string;
  tuiArgs: string[];
}

export type CodexInvocationPlan = CodexProtocolInvocation | CodexPassthroughInvocation;

const NON_INTERACTIVE_COMMANDS = new Set([
  'exec',
  'e',
  'review',
  'login',
  'logout',
  'mcp',
  'plugin',
  'mcp-server',
  'app-server',
  'remote-control',
  'app',
  'completion',
  'update',
  'doctor',
  'sandbox',
  'debug',
  'apply',
  'a',
  'archive',
  'delete',
  'unarchive',
  'cloud',
  'exec-server',
  'features',
  'help',
]);

const VALUE_OPTIONS = new Map<string, string>([
  ['-c', '--config'],
  ['--config', '--config'],
  ['--enable', '--enable'],
  ['--disable', '--disable'],
  ['-i', '--image'],
  ['--image', '--image'],
  ['-m', '--model'],
  ['--model', '--model'],
  ['--local-provider', '--local-provider'],
  ['-s', '--sandbox'],
  ['--sandbox', '--sandbox'],
  ['-C', '--cd'],
  ['--cd', '--cd'],
  ['--add-dir', '--add-dir'],
  ['-a', '--ask-for-approval'],
  ['--ask-for-approval', '--ask-for-approval'],
]);

const BOOLEAN_OPTIONS = new Set([
  '--strict-config',
  '--oss',
  '--dangerously-bypass-approvals-and-sandbox',
  '--dangerously-bypass-hook-trust',
  '--search',
  '--no-alt-screen',
]);

const APP_SERVER_OPTIONS = new Set(['--config', '--enable', '--disable', '--strict-config']);

export function planCodexInvocation(
  args: string[],
  invocationCwd = process.cwd(),
): CodexInvocationPlan {
  let command: CodexProtocolInvocation['command'] = 'tui';
  let rootPositionals = 0;
  let subcommandPositionals = 0;
  let requestedCwd: string | undefined;
  let usesOss = false;
  let localProvider: string | undefined;
  const appServerArgs = ['app-server', '--stdio'];

  for (let index = 0; index < args.length; index++) {
    const raw = args[index];
    if (raw === '--') return passthrough(args, 'argument separator is not classified');
    if (['-h', '--help', '-V', '--version'].includes(raw)) {
      return passthrough(args, 'help and version commands do not start a TUI session');
    }
    if (raw === '-p' || raw === '--profile' || raw.startsWith('--profile=')) {
      return passthrough(args, 'profiles are not forwarded to app-server');
    }
    if (
      raw === '--remote' ||
      raw.startsWith('--remote=') ||
      raw === '--remote-auth-token-env' ||
      raw.startsWith('--remote-auth-token-env=')
    ) {
      return passthrough(args, 'an explicit remote endpoint must not be replaced');
    }

    const parsedLong = parseLongOption(raw);
    const option = parsedLong?.name ?? raw;
    if (BOOLEAN_OPTIONS.has(option)) {
      if (parsedLong?.value !== undefined) {
        return passthrough(args, `${option} does not accept an inline value`);
      }
      if (option === '--oss') usesOss = true;
      if (APP_SERVER_OPTIONS.has(option)) appServerArgs.push(option);
      continue;
    }

    const canonicalOption = VALUE_OPTIONS.get(option);
    if (canonicalOption) {
      const value = parsedLong?.value ?? args[++index];
      if (value === undefined || value.length === 0) {
        return passthrough(args, `${option} is missing its value`);
      }
      if (canonicalOption === '--local-provider') {
        if (value !== 'ollama' && value !== 'lmstudio') {
          return passthrough(args, 'the OSS provider is not recognized');
        }
        localProvider = value;
      }
      if (canonicalOption === '--cd') requestedCwd = value;
      if (APP_SERVER_OPTIONS.has(canonicalOption)) {
        appServerArgs.push(canonicalOption, value);
      }
      continue;
    }

    if (raw.startsWith('-')) {
      if (command !== 'tui' && ['--last', '--all'].includes(raw)) {
        continue;
      }
      if (command === 'resume' && raw === '--include-non-interactive') {
        continue;
      }
      return passthrough(args, `unknown option: ${raw}`);
    }

    if (command === 'tui' && rootPositionals === 0) {
      if (raw === 'resume' || raw === 'fork') {
        command = raw;
        continue;
      }
      if (NON_INTERACTIVE_COMMANDS.has(raw)) {
        return passthrough(args, `${raw} is not an interactive TUI command`);
      }
      rootPositionals++;
      continue;
    }

    if (command === 'tui') {
      rootPositionals++;
      if (rootPositionals > 1) {
        return passthrough(args, 'too many positional arguments for an interactive session');
      }
    } else {
      subcommandPositionals++;
      if (subcommandPositionals > 2) {
        return passthrough(args, `too many positional arguments for codex ${command}`);
      }
    }
  }

  if (usesOss && !localProvider) {
    return passthrough(args, 'the OSS provider cannot be determined safely');
  }

  const cwd = requestedCwd ? path.resolve(invocationCwd, requestedCwd) : invocationCwd;
  return {
    mode: 'protocol',
    command,
    cwd,
    appServerArgs,
    tuiArgs: [...args],
  };
}

export function injectRemoteArguments(
  plan: CodexProtocolInvocation,
  address: string,
  tokenEnvironmentVariable: string,
): string[] {
  const remoteArgs = ['--remote', address, '--remote-auth-token-env', tokenEnvironmentVariable];
  if (plan.command === 'tui') {
    return [...remoteArgs, ...plan.tuiArgs];
  }
  const subcommandIndex = plan.tuiArgs.indexOf(plan.command);
  if (subcommandIndex < 0) return [...plan.tuiArgs, ...remoteArgs];
  return [
    ...plan.tuiArgs.slice(0, subcommandIndex + 1),
    ...remoteArgs,
    ...plan.tuiArgs.slice(subcommandIndex + 1),
  ];
}

export function isCodexProtocolVersion(versionOutput: string): boolean {
  const match = versionOutput.match(/\b(\d+)\.(\d+)\.(\d+)(?:[-+][^\s]+)?\b/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return major > 0 || minor > 145 || (minor === 145 && patch >= 0);
}

function parseLongOption(raw: string): { name: string; value?: string } | undefined {
  if (!raw.startsWith('--')) return undefined;
  const separator = raw.indexOf('=');
  return separator < 0
    ? { name: raw }
    : { name: raw.slice(0, separator), value: raw.slice(separator + 1) };
}

function passthrough(args: string[], reason: string): CodexPassthroughInvocation {
  return { mode: 'passthrough', reason, tuiArgs: [...args] };
}
