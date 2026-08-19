import { createHash } from 'crypto';

import type { OutputChannel } from 'vscode';

import type { MonitoringMode } from 'remote-notifier-shared';

import type { CodexMonitoringChange } from './CodexAttentionNormalization';

const MAXIMUM_MONITORED_INVOCATIONS = 128;

export interface CodexMonitoringSummary {
  monitoring: MonitoringMode;
  exact: number;
  compatibility: number;
  unavailable: number;
  degraded: number;
}

interface InvocationMonitoringState {
  foregroundThreadKey?: string;
  monitoring: MonitoringMode;
}

export class CodexMonitoringStatus {
  private readonly exactForeground = new Set<string>();
  private readonly invocations = new Map<string, InvocationMonitoringState>();
  private onChange: (summary: CodexMonitoringSummary) => void;

  constructor(
    private readonly log?: Pick<OutputChannel, 'appendLine'>,
    onChange: (summary: CodexMonitoringSummary) => void = () => {},
  ) {
    this.onChange = onChange;
  }

  setOnChange(onChange: (summary: CodexMonitoringSummary) => void): void {
    this.onChange = onChange;
    onChange(this.summary());
  }

  update(change: CodexMonitoringChange): void {
    const previous = this.invocations.get(change.invocationId);
    if (previous?.foregroundThreadKey !== undefined) {
      this.exactForeground.delete(
        exactForegroundKey(change.invocationId, previous.foregroundThreadKey),
      );
    }
    const state: InvocationMonitoringState = {
      monitoring: change.monitoring,
      ...(change.foregroundThreadKey === undefined
        ? {}
        : { foregroundThreadKey: change.foregroundThreadKey }),
    };
    this.invocations.delete(change.invocationId);
    this.invocations.set(change.invocationId, state);
    if (
      (change.monitoring === 'exact' || change.monitoring === 'degraded') &&
      change.foregroundThreadKey !== undefined
    ) {
      this.invocations.delete(hookInvocationId(change.foregroundThreadKey));
      this.exactForeground.add(exactForegroundKey(change.invocationId, change.foregroundThreadKey));
    }
    this.enforceBound();
    this.log?.appendLine(
      `[CodexAttention] invocation=${shortOpaqueId(change.invocationId)} monitoring=${change.monitoring} reason=${change.reason}`,
    );
    this.onChange(this.summary());
  }

  observeHook(foregroundThreadKey: string, invocationId?: string): void {
    if (this.isExactForeground(foregroundThreadKey, invocationId)) return;
    const hookId = invocationId ?? hookInvocationId(foregroundThreadKey);
    const previous = this.invocations.get(hookId);
    if (previous?.monitoring === 'compatibility') return;
    this.update({
      invocationId: hookId,
      monitoring: 'compatibility',
      reason: 'hook-observed',
    });
  }

  isExactForeground(foregroundThreadKey: string, invocationId?: string): boolean {
    return (
      invocationId !== undefined &&
      this.exactForeground.has(exactForegroundKey(invocationId, foregroundThreadKey))
    );
  }

  summary(): CodexMonitoringSummary {
    const summary = {
      exact: 0,
      compatibility: 0,
      unavailable: 0,
      degraded: 0,
    };
    for (const state of this.invocations.values()) summary[state.monitoring]++;
    return {
      monitoring: aggregateMonitoring(summary),
      ...summary,
    };
  }

  private enforceBound(): void {
    while (this.invocations.size > MAXIMUM_MONITORED_INVOCATIONS) {
      const oldest = this.invocations.entries().next().value as
        | [string, InvocationMonitoringState]
        | undefined;
      if (oldest === undefined) return;
      const [invocationId, state] = oldest;
      this.invocations.delete(invocationId);
      if (state.foregroundThreadKey !== undefined) {
        this.exactForeground.delete(exactForegroundKey(invocationId, state.foregroundThreadKey));
      }
    }
  }
}

function aggregateMonitoring(counts: Omit<CodexMonitoringSummary, 'monitoring'>): MonitoringMode {
  if (counts.degraded > 0) return 'degraded';
  if (counts.unavailable > 0) return 'unavailable';
  if (counts.compatibility > 0) return 'compatibility';
  return counts.exact > 0 ? 'exact' : 'unavailable';
}

function shortHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
}

function hookInvocationId(foregroundThreadKey: string): string {
  return `hook:${shortHash(foregroundThreadKey)}`;
}

function exactForegroundKey(invocationId: string, foregroundThreadKey: string): string {
  return JSON.stringify([invocationId, foregroundThreadKey]);
}

function shortOpaqueId(value: string): string {
  return /^[0-9a-f]{8}/i.test(value) ? value.slice(0, 8) : shortHash(value).slice(0, 8);
}
