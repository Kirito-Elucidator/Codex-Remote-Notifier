import * as vscode from 'vscode';

export class RouterAutoInstaller {
  private static readonly TARGET_EXTENSION_ID = 'ddyndo.remote-notifier-codex-router';
  private static readonly ENSURE_STARTED_COMMAND = 'remoteNotifier.ensureRouterStarted';

  private static readonly DEBOUNCE_DELAY_MS = 3000;
  private static readonly COOLDOWN_MS = 30000;
  private static readonly IGNORE_MAP_KEY = 'routerAutoInstaller.ignoredWorkspaces';

  private isInstalling = false;
  private lastCheckTime = 0;
  private debounceTimer: NodeJS.Timeout | undefined;

  private static isInstalledInSession = false;

  /** @internal For testing only */
  public static resetState(): void {
    this.isInstalledInSession = false;
  }

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.OutputChannel,
  ) {}

  public async checkAndInstall(): Promise<void> {
    if (this.isInstalling || RouterAutoInstaller.isInstalledInSession) {
      return;
    }

    // Check if user ignored this workspace globally
    if (this.isWorkspaceIgnored()) {
      this.log.appendLine(`[RouterAutoInstaller] Workspace ignored by user. skipping.`);
      return;
    }

    const now = Date.now();
    if (now - this.lastCheckTime < RouterAutoInstaller.COOLDOWN_MS) {
      return;
    }
    this.lastCheckTime = now;

    this.log.appendLine(
      `[RouterAutoInstaller] Starting detection for ${RouterAutoInstaller.TARGET_EXTENSION_ID}`,
    );

    const found = await this.performDetection();
    if (found) {
      this.log.appendLine(
        `[RouterAutoInstaller] Extension ${RouterAutoInstaller.TARGET_EXTENSION_ID} is active/present. Skipping install.`,
      );
      RouterAutoInstaller.isInstalledInSession = true;
      return;
    }

    this.log.appendLine(
      `[RouterAutoInstaller] Extension ${RouterAutoInstaller.TARGET_EXTENSION_ID} missing or unreachable. Prompting user.`,
    );
    await this.promptUserForInstallation();
  }

  private isWorkspaceIgnored(): boolean {
    const id = this.getWorkspaceId();
    if (!id) return false;
    const ignored = this.context.globalState.get<Record<string, boolean>>(
      RouterAutoInstaller.IGNORE_MAP_KEY,
      {},
    );
    return !!ignored[id];
  }

  private async ignoreWorkspace(): Promise<void> {
    const id = this.getWorkspaceId();
    if (!id) return;
    const ignored = this.context.globalState.get<Record<string, boolean>>(
      RouterAutoInstaller.IGNORE_MAP_KEY,
      {},
    );
    ignored[id] = true;
    await this.context.globalState.update(RouterAutoInstaller.IGNORE_MAP_KEY, ignored);
  }

  private getWorkspaceId(): string | undefined {
    return this.getAuthoritySourceUri()?.toString();
  }

  private getAuthoritySourceUri(): vscode.Uri | undefined {
    return vscode.workspace.workspaceFile ?? vscode.workspace.workspaceFolders?.[0]?.uri;
  }

  private async performDetection(): Promise<boolean> {
    // Phase 1: Local check (fast)
    this.log.appendLine(`[RouterAutoInstaller] Phase 1: Checking via getExtension...`);
    const localExt = vscode.extensions.getExtension(RouterAutoInstaller.TARGET_EXTENSION_ID);
    if (localExt) {
      this.log.appendLine(
        `[RouterAutoInstaller] Phase 1: Found ${RouterAutoInstaller.TARGET_EXTENSION_ID} via getExtension`,
      );
      return true;
    }

    // Phase 2: Active Trigger
    if (RouterAutoInstaller.ENSURE_STARTED_COMMAND) {
      this.log.appendLine(
        `[RouterAutoInstaller] Phase 2: Attempting to force-start via command ${RouterAutoInstaller.ENSURE_STARTED_COMMAND}...`,
      );
      try {
        await vscode.commands.executeCommand(RouterAutoInstaller.ENSURE_STARTED_COMMAND);
        this.log.appendLine(
          `[RouterAutoInstaller] Phase 2: Command executed successfully. Extension is active.`,
        );
        return true;
      } catch {
        this.log.appendLine(
          `[RouterAutoInstaller] Phase 2: Command execution failed (likely missing).`,
        );
      }
    }

    return false;
  }

  private async promptUserForInstallation(): Promise<void> {
    const remoteName = vscode.env.remoteName;
    const remoteLabel = this.getRemoteLabel();

    // Remote: "Install in WSL: Ubuntu"
    // Local: "Install in local workspace"
    const installItem = remoteName ? `Install in ${remoteLabel}` : 'Install in local workspace';
    const viewItem = 'View in Marketplace';
    const ignoreItem = `Don't ask me again (in ${remoteLabel})`;

    const workspaceDesc = remoteName ? remoteLabel : 'local';
    const message = `Remote Notifier (Router) extension was not found in current workspace (${workspaceDesc}) but it's required for Remote Notifier to work properly. Would you like to install it now?`;

    const result = await vscode.window.showInformationMessage(
      message,
      installItem,
      viewItem,
      ignoreItem,
    );

    switch (result) {
      case installItem:
        await this.installExtension();
        break;

      case viewItem:
        await vscode.commands.executeCommand(
          'extension.open',
          RouterAutoInstaller.TARGET_EXTENSION_ID,
        );
        break;

      case ignoreItem:
        this.log.appendLine(`[RouterAutoInstaller] User chose to ignore this workspace.`);
        await this.ignoreWorkspace();
        break;
    }
  }

  private getRemoteLabel(): string {
    const remoteName = vscode.env.remoteName;
    if (!remoteName) {
      return 'local workspace';
    }

    const prefixMap: Record<string, string> = {
      wsl: 'WSL',
      'ssh-remote': 'SSH',
      'dev-container': 'Container',
      'attached-container': 'Container',
      codespaces: 'Codespaces',
      tunnel: 'Tunnel',
    };
    const prefix = prefixMap[remoteName] ?? remoteName;

    const authority = this.getAuthoritySourceUri()?.authority;
    if (!authority) {
      return prefix;
    }

    // Extract detail from authority (strip type prefix if present, e.g. "wsl+ubuntu" -> "ubuntu")
    let detail = authority;
    const plusIndex = authority.indexOf('+');
    if (plusIndex !== -1) {
      detail = authority.substring(plusIndex + 1);
    }

    if (detail.length > 15) {
      detail = detail.substring(0, 12) + '...';
    }

    // Make name of the WSL distro start with uppercase
    if (prefix == 'WSL') {
      detail = detail.charAt(0).toUpperCase() + detail.slice(1);
    }

    return `${prefix}: ${detail}`;
  }

  public debouncedCheck(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.checkAndInstall().catch((err) => {
        this.log.appendLine(`[RouterAutoInstaller] Error in debounced check: ${err}`);
      });
    }, RouterAutoInstaller.DEBOUNCE_DELAY_MS);
  }

  private async installExtension(): Promise<void> {
    this.isInstalling = true;
    const extensionId = RouterAutoInstaller.TARGET_EXTENSION_ID;

    try {
      await vscode.commands.executeCommand('extension.open', extensionId);

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Remote Notifier',
          cancellable: false,
        },
        async (progress) => {
          progress.report({ message: `Installing required dependency: ${extensionId}...` });
          await vscode.commands.executeCommand(
            'workbench.extensions.installExtension',
            extensionId,
          );
        },
      );

      this.log.appendLine(`[RouterAutoInstaller] Installation successful for ${extensionId}`);
      RouterAutoInstaller.isInstalledInSession = true;
      vscode.window.showInformationMessage(
        `Remote Notifier (Router) has been installed successfully.`,
      );
    } catch (err) {
      this.log.appendLine(`[RouterAutoInstaller] Installation failed: ${err}`);
      vscode.window.showErrorMessage(`Failed to automatically install dependency: ${err}`);
    } finally {
      this.isInstalling = false;
    }
  }
}
