import * as vscode from 'vscode';
import {
  COMMAND_SHOW_SESSION_INFO,
  COMMAND_ENSURE_ROUTER_STARTED,
  COMMAND_REGENERATE_TOKEN,
  COMMAND_COPY_NOTIFY_COMMAND,
  COMMAND_INSTALL_SCRIPT,
  COMMAND_AUTO_CONFIGURE,
  VscodePresenter,
} from 'remote-notifier-shared';
import { createAutoConfigRegistry } from './autoconfig/Registry';
import { CodeNotifyScriptInstaller } from './installer/CodeNotifyScriptInstaller';
import { Configuration } from './config/Configuration';
import { CommandPresenter } from './presenter/CommandPresenter';
import { NotificationHandler } from './handler/NotificationHandler';
import { NotificationServer } from './server/NotificationServer';
import { SessionManager } from './session/SessionManager';
import { StatusBar } from './ui/StatusBar';

let log: vscode.OutputChannel;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  log = vscode.window.createOutputChannel('Remote Notifier');
  log.appendLine('[Router] activate() called');
  log.appendLine(`[Router] Extension path: ${context.extensionPath}`);

  const config = new Configuration();
  if (!config.enabled) {
    log.appendLine('[Router] Extension disabled via config, skipping');
    return;
  }

  const vscodePresenter = new VscodePresenter();
  const presenter = new CommandPresenter(vscodePresenter, log);
  const handler = new NotificationHandler(presenter, config);
  const sessionManager = new SessionManager(context);
  const server = new NotificationServer(handler, config);

  await server.start(sessionManager.token);
  log.appendLine(`[Router] HTTP server listening on port ${server.port}`);

  await sessionManager.initialize(server.port);
  log.appendLine(`[Router] Session file written, env vars set`);

  const statusBar = new StatusBar(server.port);

  // Auto-install or update script
  const installer = new CodeNotifyScriptInstaller(log);
  installer
    .isInstalled()
    .then(async (installed) => {
      if (!installed) {
        log.appendLine('[Router] code-notify script not found, installing...');
        return installer.install(true);
      } else {
        const needsUpdate = await installer.needsUpdate();
        if (needsUpdate) {
          log.appendLine('[Router] code-notify script is outdated, updating...');
          return installer.install(true, true);
        }
      }
    })
    .catch((err) => {
      log.appendLine(`[Router] Failed to auto-install or update script: ${err}`);
    });

  context.subscriptions.push(
    log,
    server,
    {
      dispose: () => {
        sessionManager.dispose().catch(() => {});
      },
    },
    statusBar,
    vscode.commands.registerCommand(COMMAND_ENSURE_ROUTER_STARTED, () => {
      log.appendLine('[Router] ensureRouterStarted triggered');
      return {
        ok: true,
        port: server.port,
        version: vscode.extensions.getExtension('ddyndo.remote-notifier-router')?.packageJSON
          ?.version,
      };
    }),
    vscode.commands.registerCommand(COMMAND_SHOW_SESSION_INFO, () => {
      const url = `http://127.0.0.1:${server.port}/notify`;
      const maskedToken = sessionManager.token.slice(0, 8) + '...';
      vscode.window
        .showInformationMessage(
          `Remote Notifier — URL: ${url} | Token: ${maskedToken}`,
          'Copy curl command',
        )
        .then((selection) => {
          if (selection === 'Copy curl command') {
            const cmd = buildCurlCommand(server.port, sessionManager.token);
            vscode.env.clipboard.writeText(cmd);
          }
        });
    }),
    vscode.commands.registerCommand(COMMAND_REGENERATE_TOKEN, async () => {
      await sessionManager.regenerateToken(server.port);
      server.updateToken(sessionManager.token);
      vscode.window.showInformationMessage(
        'Remote Notifier: Token regenerated. New terminals will use the new token.',
      );
    }),
    vscode.commands.registerCommand(COMMAND_COPY_NOTIFY_COMMAND, () => {
      const cmd = buildCurlCommand(server.port, sessionManager.token);
      vscode.env.clipboard.writeText(cmd);
      vscode.window.showInformationMessage('Notify command copied to clipboard.');
    }),
    vscode.commands.registerCommand(COMMAND_INSTALL_SCRIPT, async () => {
      const installer = new CodeNotifyScriptInstaller(log);
      await installer.install();
    }),
    vscode.commands.registerCommand(COMMAND_AUTO_CONFIGURE, async () => {
      const registry = createAutoConfigRegistry(log);
      const items = registry.getAll().map((p) => ({
        label: p.label,
        description: p.description,
        provider: p,
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a tool to configure notifications for...',
      });

      if (selected) {
        await selected.provider.configure();
      }
    }),
  );

  log.appendLine('[Router] Fully activated');
}

export function deactivate(): void {
  log?.appendLine('[Router] deactivate() called');
}

function buildCurlCommand(port: number, token: string): string {
  return `curl -s -X POST http://127.0.0.1:${port}/notify -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" -d '{"message":"Task completed"}'`;
}
