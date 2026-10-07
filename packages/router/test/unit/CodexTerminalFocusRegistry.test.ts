import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockExtensionContext, window } from 'vscode';

import { CodexTerminalFocusRegistry } from '../../src/terminal/CodexTerminalFocusRegistry';
import { TmuxTerminalLocator } from '../../src/terminal/TmuxTerminalLocator';
import { readTerminalProcessIdentity } from '../../src/terminal/TerminalProcessIdentity';

vi.mock('../../src/terminal/TerminalProcessIdentity', () => ({
  readTerminalProcessIdentity: vi.fn(async (pid: number) => `start-${pid}`),
}));

describe('CodexTerminalFocusRegistry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.terminals.splice(0);
  });

  it('maps a Codex process ancestry to the owning terminal and focuses it', async () => {
    const terminal = createTerminal('Codex', 4100);
    window.terminals.push(terminal);
    const context = createMockExtensionContext();
    const registry = new CodexTerminalFocusRegistry(context.workspaceState as never);

    await registry.track('session-1', [7000, 6000, 4100, 3000]);
    const result = await registry.focus({ session_id: 'session-1' });

    expect(result).toEqual({ ok: true, reason: 'focused', terminal_name: 'Codex' });
    expect(terminal.show).toHaveBeenCalledWith(false);
    registry.dispose();
  });

  it('does not guess when no terminal process appears in the ancestry', async () => {
    window.terminals.push(createTerminal('Other', 9999));
    const context = createMockExtensionContext();
    const registry = new CodexTerminalFocusRegistry(context.workspaceState as never);

    await registry.track('session-1', [7000, 6000]);

    await expect(registry.focus({ session_id: 'session-1' })).resolves.toEqual({
      ok: false,
      reason: 'session-not-mapped',
    });
    registry.dispose();
  });

  it('restores a persisted terminal process mapping after extension reload', async () => {
    const terminal = createTerminal('Restored Codex', 4200);
    window.terminals.push(terminal);
    const context = createMockExtensionContext();
    const first = new CodexTerminalFocusRegistry(context.workspaceState as never);
    await first.track('session-restored', [8000, 4200]);
    first.dispose();

    const restored = new CodexTerminalFocusRegistry(context.workspaceState as never);
    const result = await restored.focus({ session_id: 'session-restored' });

    expect(result.ok).toBe(true);
    expect(terminal.show).toHaveBeenCalledWith(false);
    restored.dispose();
  });

  it('keeps older sessions focusable when the same terminal starts a new session', async () => {
    const terminal = createTerminal('Codex', 4300);
    window.terminals.push(terminal);
    const context = createMockExtensionContext();
    const registry = new CodexTerminalFocusRegistry(context.workspaceState as never);

    await registry.track('session-old', [4300]);
    await registry.track('session-new', [4300]);

    await expect(registry.focus({ session_id: 'session-old' })).resolves.toMatchObject({
      ok: true,
      terminal_name: 'Codex',
    });
    await expect(registry.focus({ session_id: 'session-new' })).resolves.toMatchObject({
      ok: true,
      terminal_name: 'Codex',
    });
    registry.dispose();
  });

  it('rejects malformed focus requests', async () => {
    const context = createMockExtensionContext();
    const registry = new CodexTerminalFocusRegistry(context.workspaceState as never);

    await expect(registry.focus({ session_id: '' })).resolves.toEqual({
      ok: false,
      reason: 'invalid-request',
    });
    registry.dispose();
  });

  it('restores a tmux pane mapping and focuses its current attached terminal', async () => {
    const terminal = createTerminal('Attached tmux', 9000);
    window.terminals.push(terminal);
    const target = { socket: '/tmp/tmux/default', pane: '%7', panePid: 700 };
    const tmux = {
      find: vi.fn().mockResolvedValue(target),
      clients: vi.fn().mockResolvedValue([{ ancestry: [9100, 9000] }]),
      activate: vi.fn().mockResolvedValue(true),
    } as unknown as TmuxTerminalLocator;
    const context = createMockExtensionContext();
    const registry = new CodexTerminalFocusRegistry(
      context.workspaceState as never,
      undefined,
      tmux,
    );
    await registry.track('tmux-session', [701, 700, 50]);
    registry.dispose();
    const restored = new CodexTerminalFocusRegistry(
      context.workspaceState as never,
      undefined,
      tmux,
    );
    expect(await restored.focus({ session_id: 'tmux-session' })).toMatchObject({
      ok: true,
      terminal_name: 'Attached tmux',
    });
    expect(tmux.activate).toHaveBeenCalledWith(target);
    expect(terminal.show).toHaveBeenCalledWith(false);
    restored.dispose();
  });

  it('does not focus an arbitrary terminal when multiple attached clients match', async () => {
    window.terminals.push(createTerminal('First', 9000), createTerminal('Second', 9100));
    const tmux = {
      find: vi.fn().mockResolvedValue({ socket: '/tmp/tmux/default', pane: '%7', panePid: 700 }),
      clients: vi.fn().mockResolvedValue([{ ancestry: [9000] }, { ancestry: [9100] }]),
      activate: vi.fn(),
    } as unknown as TmuxTerminalLocator;
    const context = createMockExtensionContext();
    const registry = new CodexTerminalFocusRegistry(
      context.workspaceState as never,
      undefined,
      tmux,
    );
    await registry.track('tmux-session', [701, 700, 50]);
    expect(await registry.focus({ session_id: 'tmux-session' })).toMatchObject({ ok: false });
    expect(tmux.activate).not.toHaveBeenCalled();
    registry.dispose();
  });

  it('retries the newest ancestry rather than focusing a previous invocation terminal', async () => {
    const previous = createTerminal('Previous', 4300);
    const current = createTerminal('Resumed', 4400);
    window.terminals.push(previous);
    const context = createMockExtensionContext();
    const registry = new CodexTerminalFocusRegistry(context.workspaceState as never);
    await registry.track('session-resumed', [4300]);
    await registry.track('session-resumed', [8000, 4400]);
    window.terminals.push(current);

    await expect(registry.focus({ session_id: 'session-resumed' })).resolves.toMatchObject({
      ok: true,
      terminal_name: 'Resumed',
    });
    expect(previous.show).not.toHaveBeenCalled();
    registry.dispose();
  });

  it('selects the nearest owning process, not the first terminal in window order', async () => {
    const outer = createTerminal('Outer', 4300);
    const inner = createTerminal('Current', 4400);
    window.terminals.push(outer, inner);
    const context = createMockExtensionContext();
    const registry = new CodexTerminalFocusRegistry(context.workspaceState as never);
    await registry.track('session-nested', [8000, 4400, 4300]);
    await expect(registry.focus({ session_id: 'session-nested' })).resolves.toMatchObject({
      ok: true,
      terminal_name: 'Current',
    });
    registry.dispose();
  });

  it('does not focus a terminal that closes while its restored process ID is resolving', async () => {
    let resolveProcess!: (value: number) => void;
    const terminal = {
      name: 'Closed during reload',
      processId: new Promise<number>((resolve) => {
        resolveProcess = resolve;
      }),
      show: vi.fn(),
    };
    window.terminals.push(terminal);
    const context = createMockExtensionContext();
    await context.workspaceState.update('codexTerminalFocus.mappings', {
      'session-race': { processId: 4200, processIdentity: 'start-4200', updatedAt: Date.now() },
    });
    const registry = new CodexTerminalFocusRegistry(context.workspaceState as never);
    const focusing = registry.focus({ session_id: 'session-race' });
    window.terminals.splice(0);
    resolveProcess(4200);

    expect(await focusing).toMatchObject({ ok: false });
    expect(terminal.show).not.toHaveBeenCalled();
    registry.dispose();
  });

  it('does not restore a closed terminal mapping onto an unrelated process with a reused PID', async () => {
    const original = createTerminal('Original', 5200);
    window.terminals.push(original);
    const context = createMockExtensionContext();
    const first = new CodexTerminalFocusRegistry(context.workspaceState as never);
    await first.track('pid-reused-session', [5200]);
    first.dispose();
    const unrelated = createTerminal('Unrelated', 5200);
    window.terminals.splice(0, window.terminals.length, unrelated);
    vi.mocked(readTerminalProcessIdentity).mockResolvedValueOnce('different-start');
    const reloaded = new CodexTerminalFocusRegistry(context.workspaceState as never);
    expect(await reloaded.focus({ session_id: 'pid-reused-session' })).toMatchObject({ ok: false });
    expect(unrelated.show).not.toHaveBeenCalled();
    reloaded.dispose();
  });

  it('does not let an older asynchronous mapping overwrite the latest terminal', async () => {
    const terminal = createTerminal('Latest', 5200);
    window.terminals.push(terminal);
    let resolveOld!: (value: { socket: string; pane: string; panePid: number }) => void;
    const tmux = {
      find: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      ),
      clients: vi.fn().mockResolvedValue([]),
    } as unknown as TmuxTerminalLocator;
    const context = createMockExtensionContext();
    const registry = new CodexTerminalFocusRegistry(
      context.workspaceState as never,
      undefined,
      tmux,
    );
    const older = registry.track('same-session', [5100]);
    await vi.waitFor(() => expect(tmux.find).toHaveBeenCalled());
    await registry.track('same-session', [5200]);
    resolveOld({ socket: '/tmp/tmux/default', pane: '%7', panePid: 5100 });
    await older;
    expect(await registry.focus({ session_id: 'same-session' })).toMatchObject({
      ok: true,
      terminal_name: 'Latest',
    });
    expect(tmux.clients).not.toHaveBeenCalled();
    registry.dispose();
  });

  it('does not let a slow unrelated terminal stall routing', async () => {
    const stalled = { name: 'Stalled', processId: new Promise<number>(() => {}), show: vi.fn() };
    const target = createTerminal('Target', 5200);
    window.terminals.push(stalled, target);
    const context = createMockExtensionContext();
    const registry = new CodexTerminalFocusRegistry(
      context.workspaceState as never,
      undefined,
      undefined,
      { processIdTimeoutMs: 10 },
    );
    await registry.track('target-session', [5200]);
    expect(await registry.focus({ session_id: 'target-session' })).toMatchObject({
      ok: true,
      terminal_name: 'Target',
    });
    expect(stalled.show).not.toHaveBeenCalled();
    registry.dispose();
  });

  it('rejects duplicate terminal ownership instead of choosing window order', async () => {
    const first = createTerminal('First', 5200);
    const second = createTerminal('Second', 5200);
    window.terminals.push(first, second);
    const context = createMockExtensionContext();
    const registry = new CodexTerminalFocusRegistry(context.workspaceState as never);
    await registry.track('ambiguous-session', [5200]);
    expect(await registry.focus({ session_id: 'ambiguous-session' })).toMatchObject({ ok: false });
    expect(first.show).not.toHaveBeenCalled();
    expect(second.show).not.toHaveBeenCalled();
    registry.dispose();
  });

  it('isolates persisted mappings in same-workspace windows and restores only the originating scope', async () => {
    const firstTerminal = createTerminal('First window', 5200);
    const secondTerminal = createTerminal('Second window', 5300);
    window.terminals.push(firstTerminal, secondTerminal);
    const context = createMockExtensionContext();
    const first = new CodexTerminalFocusRegistry(
      context.workspaceState as never,
      undefined,
      undefined,
      { scopeId: 'first-window' },
    );
    const second = new CodexTerminalFocusRegistry(
      context.workspaceState as never,
      undefined,
      undefined,
      { scopeId: 'second-window' },
    );
    await first.track('same-session', [5200]);
    await second.track('same-session', [5300]);
    first.dispose();
    const reloaded = new CodexTerminalFocusRegistry(
      context.workspaceState as never,
      undefined,
      undefined,
      { scopeId: 'first-window' },
    );
    expect(await reloaded.focus({ session_id: 'same-session' })).toMatchObject({
      ok: true,
      terminal_name: 'First window',
    });
    expect(secondTerminal.show).not.toHaveBeenCalled();
    reloaded.dispose();
    second.dispose();
  });
});

function createTerminal(name: string, processId: number) {
  return {
    name,
    processId: Promise.resolve(processId),
    show: vi.fn(),
  };
}
