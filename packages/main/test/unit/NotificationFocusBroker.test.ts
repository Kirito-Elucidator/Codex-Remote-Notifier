import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commands, env, window } from 'vscode';

import {
  COMMAND_FOCUS_CODEX_SESSION,
  COMMAND_FOCUS_CODEX_SESSION_PREFIX,
  createCodexReturnTarget,
} from 'remote-notifier-shared';

import { NotificationFocusBroker } from '../../src/NotificationFocusBroker';

describe('NotificationFocusBroker', () => {
  const instanceCommand = `${COMMAND_FOCUS_CODEX_SESSION_PREFIX}${'a'.repeat(32)}`;
  const brokers: NotificationFocusBroker[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(commands.executeCommand).mockImplementation(async (command) => {
      if (
        command === COMMAND_FOCUS_CODEX_SESSION ||
        command.startsWith(COMMAND_FOCUS_CODEX_SESSION_PREFIX)
      ) {
        return { ok: true, reason: 'focused', terminal_name: 'Codex' };
      }
      return undefined;
    });
  });

  afterEach(() => {
    brokers.splice(0).forEach((broker) => broker.dispose());
  });

  it('creates a per-notification activation URI for Codex sessions', async () => {
    const broker = await createBroker();

    const launchUri = await broker.createLaunchUri({
      message: 'Done',
      source: 'codex',
      session_id: 'session-1',
      codex_focus_command: instanceCommand,
    });
    const parsed = new URL(launchUri);

    expect(parsed.protocol).toBe('vscode:');
    expect(parsed.hostname).toBe('ddyndo.remote-notifier-codex');
    expect(parsed.pathname).toBe('/notification');
    expect(parsed.searchParams.get('port')).toMatch(/^\d+$/);
    expect(parsed.searchParams.get('activation')).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.searchParams.get('session_id')).toBe('session-1');
    expect(parsed.searchParams.get('focus_command')).toBe(instanceCommand);
    expect(parsed.searchParams.get('windowId')).toBe('17');
  });

  it('routes a click from the topmost window back to the originating window broker', async () => {
    const origin = await createBroker();
    const topmost = await createBroker();
    const uri = asVscodeUri(
      await origin.createLaunchUri({
        message: 'Done',
        source: 'codex',
        session_id: 'session-origin',
        codex_focus_command: instanceCommand,
      }),
    );

    topmost.handleUri(uri as never);

    await vi.waitFor(() => {
      expect(commands.executeCommand).toHaveBeenCalledWith(instanceCommand, {
        session_id: 'session-origin',
      });
    });

    expect(commands.executeCommand).toHaveBeenCalledWith('workbench.action.focusWindow');
  });

  it('acknowledges cross-window routing before the originating focus operation finishes', async () => {
    let releaseFocus!: () => void;
    const focusGate = new Promise<void>((resolve) => {
      releaseFocus = resolve;
    });
    let reportFocusStarted!: () => void;
    const focusStarted = new Promise<void>((resolve) => {
      reportFocusStarted = resolve;
    });
    const topmostLog = { appendLine: vi.fn() };
    vi.mocked(commands.executeCommand).mockImplementation(async (command) => {
      if (command === 'workbench.action.focusWindow') {
        reportFocusStarted();
        await focusGate;
        return undefined;
      }
      if (
        command === COMMAND_FOCUS_CODEX_SESSION ||
        command.startsWith(COMMAND_FOCUS_CODEX_SESSION_PREFIX)
      ) {
        return { ok: true, reason: 'focused', terminal_name: 'Codex' };
      }
      return undefined;
    });
    const origin = await createBroker();
    const topmost = await createBroker(topmostLog as never);
    const uri = asVscodeUri(
      await origin.createLaunchUri({
        message: 'Done',
        source: 'codex',
        session_id: 'session-slow-origin',
        codex_focus_command: instanceCommand,
      }),
    );

    topmost.handleUri(uri as never);
    await focusStarted;
    await vi.waitFor(() => {
      expect(topmostLog.appendLine).toHaveBeenCalledWith(
        '[NotificationFocusBroker] Originating window accepted the activation',
      );
    });

    const focusWindowCalls = vi
      .mocked(commands.executeCommand)
      .mock.calls.filter(([command]) => command === 'workbench.action.focusWindow');
    expect(focusWindowCalls).toHaveLength(1);
    expect(topmostLog.appendLine).not.toHaveBeenCalledWith(
      '[NotificationFocusBroker] Originating window is unavailable; using the current window fallback',
    );
    releaseFocus();
    await vi.waitFor(() => {
      expect(commands.executeCommand).toHaveBeenCalledWith(instanceCommand, {
        session_id: 'session-slow-origin',
      });
    });
  });

  it('defers local focus until after the URI handler returns', async () => {
    const broker = await createBroker();
    const uri = asVscodeUri(
      await broker.createLaunchUri({
        message: 'Done',
        source: 'codex',
        session_id: 'session-local',
        codex_focus_command: instanceCommand,
      }),
    );

    broker.handleUri(uri as never);

    expect(commands.executeCommand).not.toHaveBeenCalledWith(instanceCommand, expect.anything());
    await vi.waitFor(() => {
      expect(commands.executeCommand).toHaveBeenCalledWith(instanceCommand, {
        session_id: 'session-local',
      });
    });
  });

  it('falls back to the current window when the originating broker is gone', async () => {
    const broker = await createBroker();
    const activation = 'a'.repeat(64);

    broker.handleUri({
      path: '/notification',
      query: `port=1&activation=${activation}&session_id=session-fallback&focus_command=${instanceCommand}`,
    } as never);

    await vi.waitFor(() => {
      expect(commands.executeCommand).toHaveBeenCalledWith(instanceCommand, {
        session_id: 'session-fallback',
      });
    });
  });

  it('reports a stale scoped command without guessing the current window after reload', async () => {
    const broker = await createBroker();
    vi.mocked(commands.executeCommand).mockImplementation(async (command) => {
      if (command === instanceCommand) throw new Error('command not found');
      if (command === COMMAND_FOCUS_CODEX_SESSION) {
        return { ok: true, reason: 'focused', terminal_name: 'Restored Codex' };
      }
      return undefined;
    });
    const uri = asVscodeUri(
      await broker.createLaunchUri({
        message: 'Done',
        source: 'codex',
        session_id: 'session-after-reload',
        codex_focus_command: instanceCommand,
      }),
    );

    broker.handleUri(uri as never);

    await vi.waitFor(() => {
      expect(window.showWarningMessage).toHaveBeenCalled();
    });
    expect(commands.executeCommand).not.toHaveBeenCalledWith(
      COMMAND_FOCUS_CODEX_SESSION,
      expect.anything(),
    );
    expect(commands.executeCommand).not.toHaveBeenCalledWith('workbench.action.focusWindow');
  });

  it('does not claim an opaque broker target through a generic fallback', async () => {
    const broker = await createBroker();
    vi.mocked(commands.executeCommand).mockImplementation(async (command) => {
      if (command === instanceCommand) return { ok: false, reason: 'session-not-mapped' };
      if (command === COMMAND_FOCUS_CODEX_SESSION) {
        return { ok: true, reason: 'focused', terminal_name: 'Remote Codex' };
      }
      return undefined;
    });

    await expect(
      broker.claimReturnTarget(
        createCodexReturnTarget({
          originCommand: instanceCommand,
          sessionId: 'remote-session-1',
        }),
      ),
    ).resolves.toBe(false);

    const commandCalls = vi.mocked(commands.executeCommand).mock.calls;
    expect(commandCalls).toEqual([[instanceCommand, { session_id: 'remote-session-1' }]]);
  });

  it('keeps a successful target claim when foreground window focus fails', async () => {
    const log = { appendLine: vi.fn() };
    const broker = await createBroker(log);
    vi.mocked(commands.executeCommand).mockImplementation(async (command) => {
      if (command === instanceCommand) {
        return { ok: true, reason: 'focused', terminal_name: 'Remote Codex' };
      }
      if (command === 'workbench.action.focusWindow') throw new Error('window no longer exists');
      return undefined;
    });

    await expect(
      broker.claimReturnTarget(
        createCodexReturnTarget({ sessionId: 'remote-session-2', originCommand: instanceCommand }),
      ),
    ).resolves.toBe(true);
    expect(log.appendLine).toHaveBeenCalledWith(
      expect.stringContaining('Focus-window command failed after broker target claim'),
    );
  });

  it('does not let another window claim a target when the originating command is unavailable', async () => {
    const broker = await createBroker();
    vi.mocked(commands.executeCommand).mockImplementation(async (command) => {
      if (command === instanceCommand) throw new Error('command not found after reload');
      if (command === COMMAND_FOCUS_CODEX_SESSION) {
        return { ok: true, reason: 'focused', terminal_name: 'Wrong window copy' };
      }
      return undefined;
    });

    await expect(
      broker.claimReturnTarget(
        createCodexReturnTarget({ originCommand: instanceCommand, sessionId: 'shared-session' }),
      ),
    ).resolves.toBe(false);
    expect(commands.executeCommand).not.toHaveBeenCalledWith(
      COMMAND_FOCUS_CODEX_SESSION,
      expect.anything(),
    );
    expect(commands.executeCommand).not.toHaveBeenCalledWith('workbench.action.focusWindow');
  });

  it('does not claim malformed opaque broker targets', async () => {
    const broker = await createBroker();

    await expect(broker.claimReturnTarget('{"sessionId":"private"}')).resolves.toBe(false);
    expect(commands.executeCommand).not.toHaveBeenCalled();
  });

  it('keeps session fallback data when the loopback broker could not start', async () => {
    const broker = new NotificationFocusBroker(undefined, 0);
    brokers.push(broker);
    const launchUri = await broker.createLaunchUri({
      message: 'Done',
      source: 'codex',
      session_id: 'session-no-broker',
      codex_focus_command: instanceCommand,
    });
    const parsed = new URL(launchUri);

    expect(parsed.searchParams.get('port')).toBeNull();
    expect(parsed.searchParams.get('activation')).toBeNull();
    expect(parsed.searchParams.get('session_id')).toBe('session-no-broker');
    expect(parsed.searchParams.get('focus_command')).toBe(instanceCommand);

    broker.handleUri(asVscodeUri(launchUri) as never);
    await vi.waitFor(() => {
      expect(commands.executeCommand).toHaveBeenCalledWith(instanceCommand, {
        session_id: 'session-no-broker',
      });
    });
  });

  it('does not execute an arbitrary command supplied by a notification URI', async () => {
    const broker = await createBroker();

    broker.handleUri({
      path: '/notification',
      query: 'session_id=session-safe&focus_command=workbench.action.closeWindow',
    } as never);

    await vi.waitFor(() => {
      expect(window.showWarningMessage).toHaveBeenCalled();
    });
    expect(commands.executeCommand).not.toHaveBeenCalledWith(
      'workbench.action.closeWindow',
      expect.anything(),
    );
  });

  it('keeps legacy notification URIs as focus-window-only actions', async () => {
    const broker = await createBroker();

    broker.handleUri({ path: '/notification', query: '' } as never);

    await vi.waitFor(() => {
      expect(commands.executeCommand).toHaveBeenCalledWith('workbench.action.focusWindow');
    });
    expect(commands.executeCommand).not.toHaveBeenCalledWith(
      COMMAND_FOCUS_CODEX_SESSION,
      expect.anything(),
    );
  });

  it('does not claim an unscoped session-only target across multiple windows', async () => {
    const broker = await createBroker();
    expect(
      await broker.claimReturnTarget(createCodexReturnTarget({ sessionId: 'shared-session' })),
    ).toBe(false);
    expect(commands.executeCommand).not.toHaveBeenCalled();
  });

  it('passes the complete activation URI through the host without altering the resolved URI', async () => {
    const broker = await createBroker();
    vi.mocked(env.asExternalUri).mockResolvedValueOnce({
      toString: () => 'vscode://opaque-host/result?host-state=private',
    } as never);
    expect(
      await broker.createLaunchUri({
        message: 'Done',
        source: 'codex',
        session_id: 'session-external',
        codex_focus_command: instanceCommand,
      }),
    ).toBe('vscode://opaque-host/result?host-state=private');
    expect(env.asExternalUri).toHaveBeenCalledWith(
      expect.objectContaining({
        toString: expect.any(Function),
      }),
    );
  });

  async function createBroker(log?: {
    appendLine: (message: string) => void;
  }): Promise<NotificationFocusBroker> {
    const broker = new NotificationFocusBroker(log as never, 0);
    brokers.push(broker);
    await broker.start();
    return broker;
  }
});

function asVscodeUri(value: string): { path: string; query: string } {
  const parsed = new URL(value);
  return { path: parsed.pathname, query: parsed.search.slice(1) };
}
