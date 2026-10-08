import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import {
  ENV_CODEX_HOOK_AVAILABLE,
  ENV_CODEX_PROTOCOL_MONITORING,
  ENV_PORT,
  ENV_SESSION_FILE,
  ENV_TOKEN,
  ENV_URL,
  SESSION_DIR,
  SESSION_SCOPES_DIR,
} from 'remote-notifier-shared/constants';

import { planCodexInvocation } from '../codex/CodexShimArguments';
import {
  CodexStartupRoute,
  resolveCodexStartupRoute,
  resolveTmuxStartupAncestry,
} from '../session/CodexStartupRoute';
import { TmuxTerminalLocator } from '../terminal/TmuxTerminalLocator';
import {
  processAncestry,
  resolveCodexLauncher,
  runCodex,
  withoutShimPath,
} from './codex-notifier-sidecar';

export async function runBootstrap(
  argv = process.argv.slice(2),
  inheritedEnvironment = process.env,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const separator = argv.indexOf('--');
  const options = separator >= 0 ? argv.slice(0, separator) : [];
  const args = separator >= 0 ? argv.slice(separator + 1) : argv;
  const realIndex = options.indexOf('--real');
  const shimIndex = options.indexOf('--shim-dir');
  const shimDirectory = shimIndex >= 0 ? options[shimIndex + 1] : undefined;
  const environment = withoutShimPath(inheritedEnvironment, shimDirectory);
  if (realIndex >= 0 && options[realIndex + 1])
    environment.REMOTE_NOTIFIER_CODEX_REAL = options[realIndex + 1];
  const passthrough = async () =>
    runCodex(await resolveCodexLauncher(environment), args, {
      env: environment,
      cwd: process.cwd(),
      stdio: 'inherit',
    });
  if (environment.TERM_PROGRAM !== 'vscode' || planCodexInvocation(args).mode === 'passthrough')
    return passthrough();

  // Discovery can fail without breaking Codex. Never retry the frontend after it has started.
  const route = await findStartupRoute(environment).catch(() => undefined);
  const launcher = route?.info.codexLauncher;
  if (!route || !launcher) {
    process.stderr.write(
      '[remote-notifier] No verified window route was found; this invocation is not monitored.\n',
    );
    return passthrough();
  }
  if (launcher.mode === 'disabled') return passthrough();
  environment[ENV_SESSION_FILE] = route.sessionFile;
  environment[ENV_PORT] = String(route.info.port);
  environment[ENV_TOKEN] = route.info.token;
  environment[ENV_URL] = `http://127.0.0.1:${route.info.port}/notify`;
  environment[ENV_CODEX_HOOK_AVAILABLE] = '1';
  environment[ENV_CODEX_PROTOCOL_MONITORING] = launcher.mode === 'protocol' ? '1' : '0';
  const runtimeEnvironment = { ...environment };
  if (!/^node(?:\.exe)?$/i.test(path.basename(process.execPath))) {
    runtimeEnvironment.ELECTRON_RUN_AS_NODE = '1';
    runtimeEnvironment.REMOTE_NOTIFIER_CODEX_ELECTRON_NODE_SHIM = '1';
  }
  return runCodex(
    { command: process.execPath, prefixArgs: [launcher.sidecarPath] },
    ['--shim-dir', launcher.shimDirectory, '--', ...args],
    { env: runtimeEnvironment, cwd: process.cwd(), stdio: 'inherit', windowsHide: true },
  );
}

async function findStartupRoute(
  environment: NodeJS.ProcessEnv,
): Promise<CodexStartupRoute | undefined> {
  const readAncestry = async (): Promise<number[]> => {
    const ancestry = [process.pid, ...(await processAncestry())];
    return process.platform === 'linux' && environment.TMUX
      ? resolveTmuxStartupAncestry(ancestry, new TmuxTerminalLocator())
      : ancestry;
  };
  let ancestry = await readAncestry();
  const directories = [path.join(os.homedir(), SESSION_DIR, SESSION_SCOPES_DIR)];
  const deadline = Date.now() + 8000;
  let attempts = 0;
  do {
    const route = await resolveCodexStartupRoute({
      directories,
      ancestry,
      inheritedSessionFile: environment[ENV_SESSION_FILE],
    });
    if (
      route?.info.codexLauncher &&
      (route.info.codexLauncher.mode === 'disabled' ||
        (await fs.access(route.info.codexLauncher.sidecarPath).then(
          () => true,
          () => false,
        )))
    )
      return route;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (++attempts % 3 === 0) ancestry = await readAncestry();
  } while (Date.now() < deadline);
  return undefined;
}

if (require.main === module) {
  void runBootstrap()
    .then((result) => {
      if (result.signal && process.platform !== 'win32') {
        process.removeAllListeners(result.signal);
        process.kill(process.pid, result.signal);
        return;
      }
      process.exitCode = result.code ?? 1;
    })
    .catch(() => {
      process.stderr.write(
        '[remote-notifier] Startup routing failed. No notification target was guessed.\n',
      );
      process.exitCode = 1;
    });
}
