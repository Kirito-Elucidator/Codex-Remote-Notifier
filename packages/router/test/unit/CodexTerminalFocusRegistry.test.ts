import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockExtensionContext, window } from 'vscode';

import { CodexTerminalFocusRegistry } from '../../src/terminal/CodexTerminalFocusRegistry';

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
});

function createTerminal(name: string, processId: number) {
  return {
    name,
    processId: Promise.resolve(processId),
    show: vi.fn(),
  };
}
