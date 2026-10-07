import * as vscode from 'vscode';

import { CodexFocusRequest, CodexFocusResult } from 'remote-notifier-shared';

import { readTerminalProcessIdentity } from './TerminalProcessIdentity';
import { TmuxTarget, TmuxTerminalLocator } from './TmuxTerminalLocator';

const STATE_KEY = 'codexTerminalFocus.mappings';
const MAX_MAPPINGS = 100;

interface RegistryOptions {
  scopeId?: string;
  processIdTimeoutMs?: number;
}

interface PersistedTerminalMapping {
  processId?: number;
  processIdentity?: string;
  tmux?: TmuxTarget;
  updatedAt: number;
}

type PersistedTerminalMappings = Record<string, PersistedTerminalMapping>;

export class CodexTerminalFocusRegistry implements vscode.Disposable {
  private readonly terminalRefs = new Map<string, vscode.Terminal>();
  private readonly pendingAncestries = new Map<string, number[]>();
  private readonly closeSubscription: vscode.Disposable;
  private mappings: PersistedTerminalMappings;
  private readonly stateKey: string;
  private readonly revisions = new Map<string, object>();
  private readonly processIdentities = new WeakMap<vscode.Terminal, Promise<string | undefined>>();
  private disposed = false;

  constructor(
    private readonly workspaceState: vscode.Memento,
    private readonly log?: vscode.OutputChannel,
    private readonly tmux = process.platform === 'linux' ? new TmuxTerminalLocator() : undefined,
    private readonly options: RegistryOptions = {},
  ) {
    this.stateKey = options.scopeId ? `${STATE_KEY}.${options.scopeId}` : STATE_KEY;
    this.mappings = { ...workspaceState.get<PersistedTerminalMappings>(this.stateKey, {}) };
    this.closeSubscription = vscode.window.onDidCloseTerminal((terminal) => {
      void this.removeClosedTerminal(terminal);
    });
  }

  async track(sessionId: string, processAncestry: number[]): Promise<void> {
    const candidates = this.normalizeProcessIds(processAncestry);
    if (this.disposed || !sessionId || candidates.length === 0) return;
    const revision = {};
    this.revisions.set(sessionId, revision);

    const terminal = await this.findTerminal(candidates);
    if (!terminal) {
      const target = await this.tmux?.find(candidates);
      if (this.disposed || this.revisions.get(sessionId) !== revision) return;
      this.terminalRefs.delete(sessionId);
      if (target) {
        this.mappings[sessionId] = { tmux: target, updatedAt: Date.now() };
        this.pendingAncestries.delete(sessionId);
        this.pruneMappings();
        await this.persistSafely();
        return;
      }
      delete this.mappings[sessionId];
      this.pendingAncestries.set(sessionId, candidates);
      if (this.pendingAncestries.size > MAX_MAPPINGS) {
        const oldest = this.pendingAncestries.keys().next().value!;
        this.pendingAncestries.delete(oldest);
        this.revisions.delete(oldest);
      }
      await this.persistSafely();
      this.log?.appendLine(`[CodexTerminalFocusRegistry] No terminal matched session ${sessionId}`);
      return;
    }

    const processId = await this.getProcessId(terminal);
    const processIdentity = processId
      ? await this.getProcessIdentity(terminal, processId)
      : undefined;
    if (!processId || !this.isLive(terminal) || this.revisions.get(sessionId) !== revision) return;

    this.terminalRefs.set(sessionId, terminal);
    this.pendingAncestries.delete(sessionId);
    this.mappings[sessionId] = { processId, processIdentity, updatedAt: Date.now() };
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
    const revision = this.revisions.get(sessionId);
    const tmuxTarget = this.mappings[sessionId]?.tmux;
    if (tmuxTarget) {
      const matches = new Set<vscode.Terminal>();
      for (const client of (await this.tmux?.clients(tmuxTarget)) ?? []) {
        const match = await this.findTerminal(client.ancestry);
        if (match) matches.add(match);
      }
      if (matches.size !== 1 || !(await this.tmux?.activate(tmuxTarget))) {
        return { ok: false, reason: 'terminal-not-found' };
      }
      const terminal = [...matches][0];
      if (!this.isLive(terminal) || this.revisions.get(sessionId) !== revision) {
        return { ok: false, reason: 'terminal-not-found' };
      }
      terminal.show(false);
      return { ok: true, reason: 'focused', terminal_name: terminal.name };
    }
    let terminal = this.terminalRefs.get(sessionId);
    if (terminal && !this.isLive(terminal)) {
      this.terminalRefs.delete(sessionId);
      terminal = undefined;
    }

    if (!terminal) {
      const mapping = this.mappings[sessionId];
      if (mapping?.processId && mapping.processIdentity) {
        terminal = await this.findTerminal([mapping.processId]);
        if (
          terminal &&
          (await this.getProcessIdentity(terminal, mapping.processId)) !== mapping.processIdentity
        ) {
          terminal = undefined;
        }
      }
    }

    if (!terminal) {
      const ancestry = this.pendingAncestries.get(sessionId);
      if (ancestry) {
        terminal = await this.findTerminal(ancestry);
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
    const processIdentity = processId
      ? await this.getProcessIdentity(terminal, processId)
      : undefined;
    if (!this.isLive(terminal) || this.revisions.get(sessionId) !== revision) {
      return { ok: false, reason: 'terminal-not-found' };
    }
    if (processId) {
      this.terminalRefs.set(sessionId, terminal);
      this.mappings[sessionId] = { processId, processIdentity, updatedAt: Date.now() };
      void this.persistSafely();
    }
    terminal.show(false);
    this.log?.appendLine(
      `[CodexTerminalFocusRegistry] Focused session ${sessionId} in terminal "${terminal.name}"`,
    );
    return { ok: true, reason: 'focused', terminal_name: terminal.name };
  }

  dispose(): void {
    this.disposed = true;
    this.closeSubscription.dispose();
    this.terminalRefs.clear();
    this.pendingAncestries.clear();
    this.revisions.clear();
  }

  private async findTerminal(processIds: number[]): Promise<vscode.Terminal | undefined> {
    let nearest: vscode.Terminal | undefined;
    let nearestIndex = processIds.length;
    const terminals = [...vscode.window.terminals];
    const ids = await Promise.all(terminals.map((terminal) => this.getProcessId(terminal)));
    let ambiguous = false;
    for (const [position, terminal] of terminals.entries()) {
      if (!this.isLive(terminal)) continue;
      const processId = ids[position];
      const index = processId ? processIds.indexOf(processId) : -1;
      if (index >= 0 && index < nearestIndex) {
        nearest = terminal;
        nearestIndex = index;
        ambiguous = false;
      } else if (index >= 0 && index === nearestIndex) {
        ambiguous = true;
      }
    }
    return ambiguous ? undefined : nearest;
  }

  private isLive(terminal: vscode.Terminal): boolean {
    return !this.disposed && vscode.window.terminals.includes(terminal);
  }

  private getProcessIdentity(
    terminal: vscode.Terminal,
    processId: number,
  ): Promise<string | undefined> {
    let identity = this.processIdentities.get(terminal);
    if (!identity) {
      identity = readTerminalProcessIdentity(processId);
      this.processIdentities.set(terminal, identity);
    }
    return identity;
  }

  private async getProcessId(terminal: vscode.Terminal): Promise<number | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const processId = await Promise.race([
        terminal.processId,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), this.options.processIdTimeoutMs ?? 1000);
        }),
      ]);
      return typeof processId === 'number' && Number.isSafeInteger(processId) && processId > 0
        ? processId
        : undefined;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
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
        this.revisions.delete(sessionId);
      });
  }

  private async persistSafely(): Promise<void> {
    try {
      await this.workspaceState.update(this.stateKey, { ...this.mappings });
    } catch (error) {
      this.log?.appendLine(
        `[CodexTerminalFocusRegistry] Failed to persist terminal mappings: ${error}`,
      );
    }
  }
}
