import { runSidecar } from './codex-notifier-sidecar';

void runSidecar()
  .then((result) => {
    if (result.signal && process.platform !== 'win32') {
      process.removeAllListeners(result.signal);
      process.kill(process.pid, result.signal);
      return;
    }
    process.exitCode = result.code ?? 1;
  })
  .catch(() => {
    process.stderr.write('[remote-notifier] Codex sidecar startup failed.\n');
    process.exitCode = 1;
  });
