import * as vscode from 'vscode';

import {
  COMMAND_SHOW_NOTIFICATION,
  COMMAND_TEST_SYSTEM,
  COMMAND_TEST_VSCODE,
  NotificationPayload,
  VscodePresenter,
} from 'remote-notifier-shared';

import { NotificationFocusBroker } from './NotificationFocusBroker';
import { FocusAwarePresenter } from './presenter/FocusAwarePresenter';
import { RateLimitedPresenter } from './presenter/RateLimitedPresenter';
import { SystemPresenter } from './presenter/SystemPresenter';
import { RouterAutoInstaller } from './RouterAutoInstaller';

let log: vscode.OutputChannel;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  log = vscode.window.createOutputChannel('Remote Notifier');
  log.appendLine('[Main] activate() called');
  log.appendLine(`[Main] Extension path: ${context.extensionPath}`);

  try {
    const vscodePresenter = new VscodePresenter(log);
    const focusBroker = new NotificationFocusBroker(log);
    try {
      await focusBroker.start();
    } catch (error) {
      log.appendLine(`[Main] Notification focus broker failed to start: ${error}`);
    }
    const systemPresenter = new SystemPresenter(log, (payload) =>
      focusBroker.createLaunchUri(payload),
    );
    const focusAware = new FocusAwarePresenter(vscodePresenter, systemPresenter, log);
    const presenter = new RateLimitedPresenter(focusAware);
    const autoInstaller = new RouterAutoInstaller(context, log);

    const testPayload: NotificationPayload = {
      message: 'This is a test notification from Remote Notifier.',
      title: 'Remote Notifier Test',
      level: 'information',
    };

    context.subscriptions.push(
      log,
      focusBroker,
      { dispose: () => presenter.dispose() },
      vscode.commands.registerCommand(COMMAND_SHOW_NOTIFICATION, (payload: NotificationPayload) => {
        log.appendLine(`[Main] Received notification command: ${JSON.stringify(payload)}`);
        return presenter.present(payload);
      }),
      vscode.commands.registerCommand(COMMAND_TEST_VSCODE, () => {
        log.appendLine('[Main] Test VS Code notification triggered');
        return vscodePresenter.present(testPayload);
      }),
      vscode.commands.registerCommand(COMMAND_TEST_SYSTEM, () => {
        log.appendLine('[Main] Test System notification triggered');
        return systemPresenter.present(testPayload);
      }),
      vscode.commands.registerCommand('remoteNotifier.resetIgnoredWorkspaces', async () => {
        log.appendLine('[Main] Resetting ignored workspaces');
        await context.globalState.update('routerAutoInstaller.ignoredWorkspaces', {});
        vscode.window.showInformationMessage(
          'Remote Notifier: Ignored workspaces have been reset.',
        );
      }),
      vscode.window.registerUriHandler({
        handleUri: (uri) => focusBroker.handleUri(uri),
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => autoInstaller.debouncedCheck()),
    );

    // Initial check
    autoInstaller.checkAndInstall().catch((err) => {
      log.appendLine(`[Main] Initial auto-install check failed: ${err}`);
    });

    log.appendLine('[Main] All commands registered successfully');
  } catch (err) {
    log.appendLine(`[Main] activate() FAILED: ${err}`);
    vscode.window.showErrorMessage(`Remote Notifier failed to activate: ${err}`);
  }
}

export function deactivate(): void {
  log?.appendLine('[Main] deactivate() called');
}
