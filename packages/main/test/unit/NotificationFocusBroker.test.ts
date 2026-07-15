import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commands } from 'vscode';

import {
  COMMAND_FOCUS_CODEX_SESSION,
  COMMAND_FOCUS_CODEX_SESSION_PREFIX,
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

    const launchUri = broker.createLaunchUri({
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
  });

  it('routes a click from the topmost window back to the originating window broker', async () => {
    const origin = await createBroker();
    const topmost = await createBroker();
    const uri = asVscodeUri(
      origin.createLaunchUri({
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
      origin.createLaunchUri({
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
      broker.createLaunchUri({
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

  it('falls back to the stable focus command when a persisted notification has a stale command', async () => {
    const broker = await createBroker();
    vi.mocked(commands.executeCommand).mockImplementation(async (command) => {
      if (command === instanceCommand) throw new Error('command not found');
      if (command === COMMAND_FOCUS_CODEX_SESSION) {
        return { ok: true, reason: 'focused', terminal_name: 'Restored Codex' };
      }
      return undefined;
    });
    const uri = asVscodeUri(
      broker.createLaunchUri({
        message: 'Done',
        source: 'codex',
        session_id: 'session-after-reload',
        codex_focus_command: instanceCommand,
      }),
    );

    broker.handleUri(uri as never);

    await vi.waitFor(() => {
      expect(commands.executeCommand).toHaveBeenCalledWith(COMMAND_FOCUS_CODEX_SESSION, {
        session_id: 'session-after-reload',
      });
    });
  });

  it('keeps session fallback data when the loopback broker could not start', async () => {
    const broker = new NotificationFocusBroker(undefined, 0);
    brokers.push(broker);
    const launchUri = broker.createLaunchUri({
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
      expect(commands.executeCommand).toHaveBeenCalledWith(COMMAND_FOCUS_CODEX_SESSION, {
        session_id: 'session-safe',
      });
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
