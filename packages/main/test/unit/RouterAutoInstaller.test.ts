import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { RouterAutoInstaller } from '../../src/RouterAutoInstaller';
import { createMockExtensionContext } from 'vscode';

describe('RouterAutoInstaller', () => {
  let log: vscode.OutputChannel;
  let context: vscode.ExtensionContext;
  let autoInstaller: RouterAutoInstaller;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    RouterAutoInstaller.resetState();

    log = {
      appendLine: vi.fn(),
      append: vi.fn(),
      clear: vi.fn(),
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
    } as any;

    context = createMockExtensionContext() as any;
    autoInstaller = new RouterAutoInstaller(context, log);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('detects via getExtension (Phase 1) and skips install', async () => {
    vi.mocked(vscode.extensions.getExtension).mockReturnValue({} as any);

    await autoInstaller.checkAndInstall();

    expect(vscode.extensions.getExtension).toHaveBeenCalledWith(
      'ddyndo.remote-notifier-codex-router',
    );
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('detects via active trigger (Phase 2) and skips install', async () => {
    vi.mocked(vscode.extensions.getExtension).mockReturnValue(undefined);
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined); // Success

    await autoInstaller.checkAndInstall();

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'remoteNotifier.ensureRouterStarted',
    );
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('prompts user and installs if both phases fail', async () => {
    vi.mocked(vscode.extensions.getExtension).mockReturnValue(undefined);
    vi.mocked(vscode.commands.executeCommand).mockImplementation((command) => {
      if (command === 'remoteNotifier.ensureRouterStarted') {
        return Promise.reject(new Error('Command not found'));
      }
      return Promise.resolve();
    });
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(
      'Install in local workspace' as any,
    );

    await autoInstaller.checkAndInstall();

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('was not found in current workspace (local)'),
      'Install in local workspace',
      'View in Marketplace',
      "Don't ask me again (in local workspace)",
    );

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'extension.open',
      'ddyndo.remote-notifier-codex-router',
    );
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'workbench.extensions.installExtension',
      'ddyndo.remote-notifier-codex-router',
    );
  });

  it('handles "Don\'t ask me again" globally via map', async () => {
    vi.mocked(vscode.extensions.getExtension).mockReturnValue(undefined);
    vi.mocked(vscode.commands.executeCommand).mockImplementation((command) => {
      if (command === 'remoteNotifier.ensureRouterStarted') {
        return Promise.reject(new Error('Command not found'));
      }
      return Promise.resolve();
    });
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(
      "Don't ask me again (in local workspace)" as any,
    );

    await autoInstaller.checkAndInstall();

    // Verify it updated globalState with a map
    expect(context.globalState.update).toHaveBeenCalledWith(
      'routerAutoInstaller.ignoredWorkspaces',
      expect.objectContaining({ '/test/workspace': true }),
    );

    // Reset mocks for second call
    vi.clearAllMocks();
    vi.mocked(context.globalState.get).mockReturnValue({ '/test/workspace': true });

    await autoInstaller.checkAndInstall();
    expect(vscode.extensions.getExtension).not.toHaveBeenCalled();
  });

  it('respects session cache after successful detection', async () => {
    vi.mocked(vscode.extensions.getExtension).mockReturnValue({} as any);

    await autoInstaller.checkAndInstall();
    expect(vscode.extensions.getExtension).toHaveBeenCalledTimes(1);

    // Second call should skip immediately
    await autoInstaller.checkAndInstall();
    expect(vscode.extensions.getExtension).toHaveBeenCalledTimes(1);
  });

  it('debounces checks', async () => {
    vi.mocked(vscode.extensions.getExtension).mockReturnValue({} as any);
    const spy = vi.spyOn(autoInstaller, 'checkAndInstall');

    autoInstaller.debouncedCheck();
    autoInstaller.debouncedCheck();

    await vi.advanceTimersByTimeAsync(3000);

    expect(spy).toHaveBeenCalledTimes(1);
  });
});
