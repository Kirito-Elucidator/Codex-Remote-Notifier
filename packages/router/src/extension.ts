import { randomBytes } from 'crypto';

import * as vscode from 'vscode';

import {
  COMMAND_AUTO_CONFIGURE,
  COMMAND_COPY_NOTIFY_COMMAND,
  COMMAND_ENSURE_ROUTER_STARTED,
  COMMAND_FOCUS_CODEX_SESSION,
  COMMAND_FOCUS_CODEX_SESSION_PREFIX,
  COMMAND_INSTALL_SCRIPT,
  COMMAND_REGENERATE_TOKEN,
  COMMAND_REMOVE_CODEX_CONFIG,
  COMMAND_SHOW_SESSION_INFO,
  VscodePresenter,
} from 'remote-notifier-shared';

import { CodexAutoConfigProvider } from './autoconfig/CodexAutoConfigProvider';
import { createAutoConfigRegistry } from './autoconfig/Registry';
import { CodexAttentionNormalizationRegistry } from './codex/CodexAttentionNormalization';
import { CodexEventHandler } from './codex/CodexEventHandler';
import { CodexMonitoringStatus } from './codex/CodexMonitoringStatus';
import { Configuration } from './config/Configuration';
import { NotificationHandler } from './handler/NotificationHandler';
import { CodeNotifyScriptInstaller } from './installer/CodeNotifyScriptInstaller';
import { CodexAttentionHookInstaller } from './installer/CodexAttentionHookInstaller';
import { CodexProtocolShimManager } from './installer/CodexProtocolShimManager';
import { CommandPresenter } from './presenter/CommandPresenter';
import { PresentationCommandBridge } from './presenter/PresentationCommandBridge';
import { NotificationServer } from './server/NotificationServer';
import { SessionManager } from './session/SessionManager';
import { CodexTerminalFocusRegistry } from './terminal/CodexTerminalFocusRegistry';
import { StatusBar } from './ui/StatusBar';

let log: vscode.OutputChannel;
const CODEX_PROTOCOL_MIGRATION_KEY = 'codexProtocolMonitoring.migrationDecision';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  log = vscode.window.createOutputChannel('Remote Notifier');
  log.appendLine('[Router] activate() called');
  log.appendLine(`[Router] Extension path: ${context.extensionPath}`);

  const config = new Configuration();
  if (!config.enabled) {
    context.environmentVariableCollection.delete('PATH');
    log.appendLine('[Router] Extension disabled via config, skipping');
    return;
  }

  const vscodePresenter = new VscodePresenter();
  const presenter = new CommandPresenter(vscodePresenter, log);
  const terminalFocus = new CodexTerminalFocusRegistry(context.workspaceState, log);
  const codexFocusCommand = `${COMMAND_FOCUS_CODEX_SESSION_PREFIX}${randomBytes(16).toString('hex')}`;
  const handler = new NotificationHandler(presenter, config, terminalFocus, codexFocusCommand);
  const codexMonitoring = new CodexMonitoringStatus(log);
  const codexEvents = new CodexEventHandler(handler, config, undefined, log, codexMonitoring, {
    notifySuccessfulTurns: true,
    reconnectionAlertThreshold: 5,
  });
  const codexAttention = new CodexAttentionNormalizationRegistry(
    new PresentationCommandBridge(),
    (change) => codexMonitoring.update(change),
    undefined,
    { notifySuccessfulTurns: true, notifyRetryableErrors: true, reconnectionAlertThreshold: 5 },
  );
  const sessionManager = new SessionManager(context, {
    codexPreviewLength: config.codexPreviewLength,
  });
  const codexProtocolShim = new CodexProtocolShimManager(context, log);
  const codexHookInstaller = new CodexAttentionHookInstaller(log);
  const codexProvider = new CodexAutoConfigProvider(log, codexHookInstaller, {
    onConfigured: async () => {
      await context.globalState.update(CODEX_PROTOCOL_MIGRATION_KEY, true);
      if (!config.codexProtocolMonitoring) return;
      await codexProtocolShim.enable();
      vscode.window.showInformationMessage(
        'Remote Notifier: Exact Codex protocol monitoring will be active in new integrated terminals.',
      );
    },
    onUnconfigured: () => codexProtocolShim.disable(true),
  });
  const server = new NotificationServer(handler, config, codexEvents, codexAttention);

  await server.start(sessionManager.token);
  log.appendLine(`[Router] HTTP server listening on port ${server.port}`);

  await sessionManager.initialize(server.port);
  log.appendLine(`[Router] Session file written, env vars set`);

  const statusBar = new StatusBar(server.port);
  codexMonitoring.setOnChange((summary) => statusBar.updateMonitoring(summary));

  // Auto-install or update script
  const installer = new CodeNotifyScriptInstaller(log);
  installer
    .isInstalled()
    .then(async (installed) => {
      if (!installed) {
        log.appendLine('[Router] code-notify script not found, installing...');
        return installer.install(false);
      } else {
        const needsUpdate = await installer.needsUpdate();
        if (needsUpdate) {
          log.appendLine('[Router] code-notify script is outdated, updating...');
          return installer.install(false, true);
        }
      }
    })
    .catch((err) => {
      log.appendLine(`[Router] Failed to auto-install or update script: ${err}`);
    });

  codexProvider
    .isConfigured()
    .then(async (configured) => {
      if (!configured) return;
      await codexHookInstaller.ensureInstalled();
      await codexProvider.upgradeOwnedHooks();
    })
    .catch((err) => {
      log.appendLine(`[Router] Failed to auto-update Codex notification configuration: ${err}`);
    });

  void initializeCodexProtocolMonitoring(context, config, codexProvider, codexProtocolShim);

  context.subscriptions.push(
    log,
    server,
    codexEvents,
    {
      dispose: () => {
        sessionManager.dispose().catch(() => {});
      },
    },
    statusBar,
    terminalFocus,
    vscode.commands.registerCommand(COMMAND_ENSURE_ROUTER_STARTED, () => {
      log.appendLine('[Router] ensureRouterStarted triggered');
      return {
        ok: true,
        port: server.port,
        version: vscode.extensions.getExtension('ddyndo.remote-notifier-codex-router')?.packageJSON
          ?.version,
      };
    }),
    vscode.commands.registerCommand(COMMAND_FOCUS_CODEX_SESSION, (request) =>
      terminalFocus.focus(request),
    ),
    vscode.commands.registerCommand(codexFocusCommand, (request) => terminalFocus.focus(request)),
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
      const registry = createAutoConfigRegistry(log, codexProvider);
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
    vscode.commands.registerCommand(COMMAND_REMOVE_CODEX_CONFIG, async () => {
      await codexProvider.unconfigure();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('remoteNotifier.codexPreviewLength')) {
        sessionManager
          .updateCodexPreviewLength(config.codexPreviewLength, server.port)
          .catch((err) => {
            log.appendLine(`[Router] Failed to update Codex preview length: ${err}`);
          });
      }
      if (event.affectsConfiguration('remoteNotifier.codexProtocolMonitoring')) {
        void updateCodexProtocolSetting(context, config, codexProvider, codexProtocolShim);
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

async function initializeCodexProtocolMonitoring(
  context: vscode.ExtensionContext,
  config: Configuration,
  provider: CodexAutoConfigProvider,
  shim: CodexProtocolShimManager,
): Promise<void> {
  try {
    if (!config.codexProtocolMonitoring || !(await provider.isConfigured())) {
      await shim.disable(false);
      return;
    }

    let enabled = context.globalState.get<boolean | undefined>(
      CODEX_PROTOCOL_MIGRATION_KEY,
      undefined,
    );
    if (enabled === undefined) {
      const selection = await vscode.window.showInformationMessage(
        'Remote Notifier can use Codex 0.145+ protocol events for exact completion, approval, safety-check, and terminal-error notifications. This applies to new integrated terminals.',
        'Enable exact monitoring',
        'Keep Hook fallback',
      );
      enabled = selection === 'Enable exact monitoring';
      await context.globalState.update(CODEX_PROTOCOL_MIGRATION_KEY, enabled);
    }
    if (enabled) await shim.enable();
    else await shim.disable(false);
  } catch (error) {
    log.appendLine(`[Router] Failed to initialize Codex protocol monitoring: ${error}`);
  }
}

async function updateCodexProtocolSetting(
  context: vscode.ExtensionContext,
  config: Configuration,
  provider: CodexAutoConfigProvider,
  shim: CodexProtocolShimManager,
): Promise<void> {
  try {
    if (!config.codexProtocolMonitoring) {
      await shim.disable(false);
      return;
    }
    if (!(await provider.isConfigured())) return;
    await context.globalState.update(CODEX_PROTOCOL_MIGRATION_KEY, true);
    await shim.enable();
    vscode.window.showInformationMessage(
      'Remote Notifier: Codex protocol monitoring setting changed. Open a new integrated terminal to apply it.',
    );
  } catch (error) {
    log.appendLine(`[Router] Failed to update Codex protocol monitoring: ${error}`);
  }
}
