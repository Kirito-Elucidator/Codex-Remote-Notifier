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
  private readonly endedInvocations = new Set<string>();
  private readonly protocolAuthority = new Set<string>();
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
      this.protocolAuthority.delete(
        protocolAuthorityKey(change.invocationId, previous.foregroundThreadKey),
      );
    }
    if ('ended' in change) {
      this.invocations.delete(change.invocationId);
      this.rememberEnded(change.invocationId);
      this.log?.appendLine(
        `[CodexAttention] invocation=${shortOpaqueId(change.invocationId)} monitoring=ended reason=${change.reason}`,
      );
      this.onChange(this.summary());
      return;
    }
    this.endedInvocations.delete(change.invocationId);
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
      this.protocolAuthority.add(
        protocolAuthorityKey(change.invocationId, change.foregroundThreadKey),
      );
    }
    this.enforceBound();
    this.log?.appendLine(
      `[CodexAttention] invocation=${shortOpaqueId(change.invocationId)} monitoring=${change.monitoring} reason=${change.reason}`,
    );
    this.onChange(this.summary());
  }

  observeHook(foregroundThreadKey: string, invocationId?: string): void {
    if (invocationId !== undefined && this.endedInvocations.has(invocationId)) return;
    if (this.hasProtocolAuthority(foregroundThreadKey, invocationId)) return;
    const hookId = invocationId ?? hookInvocationId(foregroundThreadKey);
    const previous = this.invocations.get(hookId);
    if (previous?.monitoring === 'compatibility') return;
    this.update({
      invocationId: hookId,
      monitoring: 'compatibility',
      reason: 'hook-observed',
    });
  }

  retireHook(foregroundThreadKey: string, invocationId?: string): void {
    if (this.hasProtocolAuthority(foregroundThreadKey, invocationId)) return;
    const hookId = invocationId ?? hookInvocationId(foregroundThreadKey);
    if (this.invocations.get(hookId)?.monitoring !== 'compatibility') return;
    this.invocations.delete(hookId);
    this.log?.appendLine(
      `[CodexAttention] invocation=${shortOpaqueId(hookId)} monitoring=inactive reason=hook-turn-complete`,
    );
    this.onChange(this.summary());
  }

  hasProtocolAuthority(foregroundThreadKey: string, invocationId?: string): boolean {
    return (
      invocationId !== undefined &&
      this.protocolAuthority.has(protocolAuthorityKey(invocationId, foregroundThreadKey))
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
        this.protocolAuthority.delete(
          protocolAuthorityKey(invocationId, state.foregroundThreadKey),
        );
      }
    }
  }

  private rememberEnded(invocationId: string): void {
    this.endedInvocations.delete(invocationId);
    this.endedInvocations.add(invocationId);
    while (this.endedInvocations.size > MAXIMUM_MONITORED_INVOCATIONS) {
      const oldest = this.endedInvocations.values().next().value as string | undefined;
      if (oldest === undefined) return;
      this.endedInvocations.delete(oldest);
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

function protocolAuthorityKey(invocationId: string, foregroundThreadKey: string): string {
  return JSON.stringify([invocationId, foregroundThreadKey]);
}

function shortOpaqueId(value: string): string {
  return /^[0-9a-f]{8}/i.test(value) ? value.slice(0, 8) : shortHash(value).slice(0, 8);
}
