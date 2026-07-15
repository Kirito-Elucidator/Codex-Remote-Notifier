import * as vscode from 'vscode';

import { CodexFocusRequest, CodexFocusResult } from 'remote-notifier-shared';

const STATE_KEY = 'codexTerminalFocus.mappings';
const MAX_MAPPINGS = 100;

interface PersistedTerminalMapping {
  processId: number;
  updatedAt: number;
}

type PersistedTerminalMappings = Record<string, PersistedTerminalMapping>;

export class CodexTerminalFocusRegistry implements vscode.Disposable {
  private readonly terminalRefs = new Map<string, vscode.Terminal>();
  private readonly pendingAncestries = new Map<string, number[]>();
  private readonly closeSubscription: vscode.Disposable;
  private mappings: PersistedTerminalMappings;

  constructor(
    private readonly workspaceState: vscode.Memento,
    private readonly log?: vscode.OutputChannel,
  ) {
    this.mappings = workspaceState.get<PersistedTerminalMappings>(STATE_KEY, {});
    this.closeSubscription = vscode.window.onDidCloseTerminal((terminal) => {
      void this.removeClosedTerminal(terminal);
    });
  }

  async track(sessionId: string, processAncestry: number[]): Promise<void> {
    const candidates = this.normalizeProcessIds(processAncestry);
    if (!sessionId || candidates.length === 0) return;

    const terminal = await this.findTerminal(new Set(candidates));
    if (!terminal) {
      this.pendingAncestries.set(sessionId, candidates);
      this.log?.appendLine(`[CodexTerminalFocusRegistry] No terminal matched session ${sessionId}`);
      return;
    }

    const processId = await this.getProcessId(terminal);
    if (!processId) return;

    this.terminalRefs.set(sessionId, terminal);
    this.pendingAncestries.delete(sessionId);
    this.mappings[sessionId] = { processId, updatedAt: Date.now() };
    this.pruneMappings();
    await this.persistSafely();
    this.log?.appendLine(
      `[CodexTerminalFocusRegistry] Mapped session ${sessionId} to terminal "${terminal.name}" (${processId})`,
    );
  }

  async focus(request: CodexFocusRequest | unknown): Promise<CodexFocusResult> {
    if (!this.isFocusRequest(request)) {
      return { ok: false, reason: 'invalid-request' };
    }

    const sessionId = request.session_id;
    let terminal = this.terminalRefs.get(sessionId);
    if (terminal && !vscode.window.terminals.includes(terminal)) {
      this.terminalRefs.delete(sessionId);
      terminal = undefined;
    }

    if (!terminal) {
      const mapping = this.mappings[sessionId];
      if (mapping) {
        terminal = await this.findTerminal(new Set([mapping.processId]));
      }
    }

    if (!terminal) {
      const ancestry = this.pendingAncestries.get(sessionId);
      if (ancestry) {
        terminal = await this.findTerminal(new Set(ancestry));
      }
    }

    if (!terminal) {
      const reason = this.mappings[sessionId] ? 'terminal-not-found' : 'session-not-mapped';
      this.log?.appendLine(
        `[CodexTerminalFocusRegistry] Cannot focus session ${sessionId}: ${reason}`,
      );
      return { ok: false, reason };
    }

    const processId = await this.getProcessId(terminal);
    if (processId) {
      this.terminalRefs.set(sessionId, terminal);
      this.mappings[sessionId] = { processId, updatedAt: Date.now() };
      void this.persistSafely();
    }
    terminal.show(false);
    this.log?.appendLine(
      `[CodexTerminalFocusRegistry] Focused session ${sessionId} in terminal "${terminal.name}"`,
    );
    return { ok: true, reason: 'focused', terminal_name: terminal.name };
  }

  dispose(): void {
    this.closeSubscription.dispose();
    this.terminalRefs.clear();
    this.pendingAncestries.clear();
  }

  private async findTerminal(processIds: Set<number>): Promise<vscode.Terminal | undefined> {
    for (const terminal of vscode.window.terminals) {
      const processId = await this.getProcessId(terminal);
      if (processId && processIds.has(processId)) return terminal;
    }
    return undefined;
  }

  private async getProcessId(terminal: vscode.Terminal): Promise<number | undefined> {
    try {
      const processId = await terminal.processId;
      return typeof processId === 'number' && Number.isSafeInteger(processId) && processId > 0
        ? processId
        : undefined;
    } catch {
      return undefined;
    }
  }

  private normalizeProcessIds(processIds: number[]): number[] {
    return [...new Set(processIds)].filter(
      (processId) => Number.isSafeInteger(processId) && processId > 0,
    );
  }

  private isFocusRequest(request: unknown): request is CodexFocusRequest {
    if (typeof request !== 'object' || request === null) return false;
    const sessionId = (request as Record<string, unknown>).session_id;
    return typeof sessionId === 'string' && sessionId.length > 0 && sessionId.length <= 200;
  }

  private async removeClosedTerminal(terminal: vscode.Terminal): Promise<void> {
    const processId = await this.getProcessId(terminal);
    let changed = false;
    for (const [sessionId, mappedTerminal] of this.terminalRefs) {
      if (mappedTerminal === terminal) {
        this.terminalRefs.delete(sessionId);
      }
    }
    if (processId) {
      for (const [sessionId, mapping] of Object.entries(this.mappings)) {
        if (mapping.processId === processId) {
          delete this.mappings[sessionId];
          changed = true;
        }
      }
    }
    if (changed) await this.persistSafely();
  }

  private pruneMappings(): void {
    const entries = Object.entries(this.mappings);
    if (entries.length <= MAX_MAPPINGS) return;
    entries
      .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
      .slice(MAX_MAPPINGS)
      .forEach(([sessionId]) => {
        delete this.mappings[sessionId];
        this.terminalRefs.delete(sessionId);
        this.pendingAncestries.delete(sessionId);
      });
  }

  private async persistSafely(): Promise<void> {
    try {
      await this.workspaceState.update(STATE_KEY, { ...this.mappings });
    } catch (error) {
      this.log?.appendLine(
        `[CodexTerminalFocusRegistry] Failed to persist terminal mappings: ${error}`,
      );
    }
  }
}
