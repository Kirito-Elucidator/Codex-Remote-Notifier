import { createHash } from 'crypto';

import {
  assertMatchingPresentationReceipt,
  ATTENTION_EXCHANGE_LIMITS,
  AttentionPresentationPort,
  CodexAttentionNormalization,
  ExchangeReceipt,
  isExactConnectionQualification,
  MonitoringMode,
  ObservationExchange,
  parseObservationExchange,
  parsePresentationReceipt,
  PresentationExchange,
  PresentationRecord,
  SanitizedAttentionObservation,
  SourceScope,
} from 'remote-notifier-shared';

const MAXIMUM_INVOCATION_BYTES = 8 * 1024 * 1024;
const MAXIMUM_INVOCATION_OBSERVATIONS = 4_096;

interface PendingOutcome {
  exchange: PresentationExchange;
  outcomeKey: string;
  sequence: number;
}

interface TurnState {
  foregroundThreadKey?: string;
  returnTarget: string;
}

type ScopeRole = 'compatibility' | 'protocol' | 'unknown';

interface ScopeState {
  admitted: Map<number, SanitizedAttentionObservation>;
  appliedThrough: number;
  closed: boolean;
  deliveryGeneration: string;
  fingerprints: Map<number, string>;
  foregroundThreadKey?: string;
  outcomes: Set<string>;
  pendingOutcome?: PendingOutcome;
  qualified: boolean;
  receivedThrough: number;
  retainedBytes: number;
  role: ScopeRole;
  turns: Map<string, TurnState>;
}

export interface CodexMonitoringChange {
  invocationId: string;
  monitoring: MonitoringMode;
  reason: string;
  foregroundThreadKey?: string;
}

export type CodexMonitoringListener = (change: CodexMonitoringChange) => void;

export class CodexAttentionNormalizationRegistry implements CodexAttentionNormalization {
  private readonly actors = new Map<string, InvocationActor>();

  constructor(
    private readonly presentation: AttentionPresentationPort,
    private readonly onMonitoringChange: CodexMonitoringListener = () => {},
  ) {}

  exchange(input: ObservationExchange): Promise<ExchangeReceipt> {
    const exchange = parseObservationExchange(input);
    let actor = this.actors.get(exchange.scope.invocationId);
    if (actor === undefined) {
      actor = new InvocationActor(
        this.presentation,
        exchange.scope.invocationId,
        this.onMonitoringChange,
      );
      this.actors.set(exchange.scope.invocationId, actor);
    }
    return actor.exchange(exchange);
  }
}

class InvocationActor {
  private exactScopeKey?: string;
  private readonly exactTurnKeys = new Set<string>();
  private mailbox = Promise.resolve();
  private monitoring: MonitoringMode = 'compatibility';
  private recoveryBoundaryRequired = false;
  private recoveryCandidateScopeKey?: string;
  private readonly scopes = new Map<string, ScopeState>();

  constructor(
    private readonly presentation: AttentionPresentationPort,
    private readonly invocationId: string,
    private readonly onMonitoringChange: CodexMonitoringListener,
  ) {}

  exchange(input: ObservationExchange): Promise<ExchangeReceipt> {
    const result = this.mailbox.then(() => this.process(input));
    this.mailbox = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private admitAppend(
    input: Extract<ObservationExchange, { kind: 'append' }>,
    state: ScopeState,
  ): ExchangeReceipt | undefined {
    const expectedSequence = state.receivedThrough + 1;
    if (input.fromSequence > expectedSequence) {
      return receipt(state, this.monitoring, expectedSequence);
    }
    if (state.deliveryGeneration !== input.deliveryGeneration) {
      this.setMonitoring('degraded');
      return receipt(state, this.monitoring, expectedSequence);
    }

    const additions: Array<{
      bytes: number;
      fingerprint: string;
      observation: SanitizedAttentionObservation;
    }> = [];
    let nextSequence = expectedSequence;
    for (const observation of input.observations) {
      const fingerprint = fingerprintValue(observation);
      if (observation.sourceSequence < nextSequence) {
        if (state.fingerprints.get(observation.sourceSequence) !== fingerprint) {
          this.setMonitoring('degraded');
          return receipt(state, this.monitoring);
        }
        continue;
      }
      if (observation.sourceSequence !== nextSequence) {
        return receipt(state, this.monitoring, nextSequence);
      }
      additions.push({
        bytes: Buffer.byteLength(JSON.stringify(observation), 'utf8'),
        fingerprint,
        observation,
      });
      nextSequence++;
    }

    const additionBytes = additions.reduce((total, addition) => total + addition.bytes, 0);
    if (
      retainedObservationCount(this.scopes) + additions.length > MAXIMUM_INVOCATION_OBSERVATIONS ||
      retainedObservationBytes(this.scopes) + additionBytes > MAXIMUM_INVOCATION_BYTES
    ) {
      this.setMonitoring('degraded');
      return receipt(state, this.monitoring, expectedSequence);
    }

    for (const addition of additions) {
      const sequence = addition.observation.sourceSequence;
      state.admitted.set(sequence, addition.observation);
      state.fingerprints.set(sequence, addition.fingerprint);
      state.receivedThrough = sequence;
      state.retainedBytes += addition.bytes;
    }
    return undefined;
  }

  private async applyAdmitted(input: ObservationExchange, state: ScopeState): Promise<void> {
    while (state.appliedThrough < state.receivedThrough) {
      const sequence = state.appliedThrough + 1;
      const observation = state.admitted.get(sequence);
      if (observation === undefined) return;
      const applied = await this.applyObservation(input.scope, state, observation);
      if (!applied) return;
      state.appliedThrough = sequence;
    }
  }

  private async applyObservation(
    scope: SourceScope,
    state: ScopeState,
    observation: SanitizedAttentionObservation,
  ): Promise<boolean> {
    switch (observation.kind) {
      case 'connection-qualification': {
        state.role = 'protocol';
        state.qualified = isExactConnectionQualification(observation);
        if (state.qualified) {
          const foregroundThreadKey = observation.evidence?.requestedThreadKey;
          if (
            foregroundThreadKey === undefined ||
            (state.foregroundThreadKey !== undefined &&
              state.foregroundThreadKey !== foregroundThreadKey)
          ) {
            state.qualified = false;
            this.setMonitoring('degraded');
            return true;
          }
          state.foregroundThreadKey = foregroundThreadKey;
          const key = scopeKey(scope);
          if (this.exactScopeKey !== undefined && this.exactScopeKey !== key) {
            state.qualified = false;
            this.setMonitoring('degraded');
          } else if (state.closed) {
            state.qualified = false;
            if (this.exactScopeKey === undefined) this.setMonitoring('compatibility');
          } else if (this.recoveryBoundaryRequired) {
            this.recoveryCandidateScopeKey = key;
          } else {
            this.exactScopeKey = key;
            this.setMonitoring('exact');
          }
        } else if (isMalformedAuditedQualification(observation)) {
          this.setMonitoring('degraded');
        } else if (this.exactScopeKey === scopeKey(scope)) {
          this.exactScopeKey = undefined;
          this.setMonitoring('compatibility');
        } else if (this.exactScopeKey === undefined) {
          this.setMonitoring('compatibility');
        }
        return true;
      }
      case 'authority-change': {
        if (observation.monitoring === 'exact') {
          if (!state.qualified || this.exactScopeKey !== scopeKey(scope)) {
            this.setMonitoring('degraded');
          }
          return true;
        }
        if (state.role === 'unknown' && observation.monitoring === 'compatibility') {
          state.role = 'compatibility';
          if (this.exactScopeKey === undefined) this.setMonitoring('compatibility');
          return true;
        }
        if (this.exactScopeKey === scopeKey(scope)) {
          if (state.turns.size > 0) this.recoveryBoundaryRequired = true;
          this.exactScopeKey = undefined;
          state.qualified = false;
          state.closed = true;
        }
        this.setMonitoring(observation.monitoring);
        return true;
      }
      case 'turn-start': {
        if (state.role === 'compatibility') {
          const existingTurn = state.turns.get(observation.turnKey);
          if (
            existingTurn !== undefined &&
            existingTurn.returnTarget !== observation.returnTarget
          ) {
            this.setMonitoring('degraded');
            return true;
          }
          state.turns.set(observation.turnKey, { returnTarget: observation.returnTarget });
          return true;
        }
        const key = scopeKey(scope);
        if (
          state.qualified &&
          this.recoveryBoundaryRequired &&
          this.recoveryCandidateScopeKey === key
        ) {
          if (this.exactTurnKeys.has(observation.turnKey)) return true;
          this.exactScopeKey = key;
          this.recoveryBoundaryRequired = false;
          this.recoveryCandidateScopeKey = undefined;
          this.setMonitoring('exact');
        }
        if (
          !state.qualified ||
          state.foregroundThreadKey === undefined ||
          this.exactScopeKey !== key
        ) {
          this.setMonitoring('degraded');
          return true;
        }
        const existingTurn = state.turns.get(observation.turnKey);
        if (existingTurn !== undefined) {
          if (existingTurn.returnTarget !== observation.returnTarget) {
            this.setMonitoring('degraded');
          }
          return true;
        }
        state.turns.set(observation.turnKey, {
          foregroundThreadKey: state.foregroundThreadKey,
          returnTarget: observation.returnTarget,
        });
        this.exactTurnKeys.add(observation.turnKey);
        return true;
      }
      case 'terminal-result':
        if (observation.result !== 'success') return true;
        return this.applySuccess(scope, state, observation);
      default:
        return true;
    }
  }

  private async applySuccess(
    scope: SourceScope,
    state: ScopeState,
    observation: Extract<SanitizedAttentionObservation, { kind: 'terminal-result' }>,
  ): Promise<boolean> {
    const compatibility = state.role === 'compatibility';
    if (
      compatibility &&
      this.exactScopeKey !== undefined &&
      this.exactTurnKeys.has(observation.turnKey)
    )
      return true;
    if (!compatibility && (!state.qualified || this.exactScopeKey !== scopeKey(scope))) {
      this.setMonitoring('degraded');
      return true;
    }
    const turn = state.turns.get(observation.turnKey);
    const foregroundThreadKey = turn?.foregroundThreadKey ?? state.foregroundThreadKey;
    if (!compatibility && foregroundThreadKey === undefined) {
      this.setMonitoring('degraded');
      return true;
    }
    const outcomeKey = stableIdentity('outcome', [
      scope.invocationId,
      scope.connectionId,
      scope.authorityEpoch,
      foregroundThreadKey ?? 'compatibility',
      observation.turnKey,
      observation.occurrenceKey,
    ]);
    if (state.outcomes.has(outcomeKey)) return true;

    let pending = state.pendingOutcome;
    if (pending === undefined) {
      if (turn === undefined) {
        this.setMonitoring('degraded');
        return true;
      }
      const record: PresentationRecord = {
        key: outcomeKey,
        revision: 1,
        appearance: 'information',
        canonicalTitle: compatibility
          ? compatibilityTitle(observation.canonicalTitle ?? 'Codex completed')
          : (observation.canonicalTitle ?? 'Codex completed'),
        canonicalBody: observation.canonicalBody ?? 'Return to Codex to view details',
        returnTarget: turn.returnTarget,
      };
      const exchange: PresentationExchange = {
        kind: 'apply',
        transactionId: stableIdentity('transaction', [
          scope.invocationId,
          scope.connectionId,
          scope.authorityEpoch,
          foregroundThreadKey ?? 'compatibility',
          observation.turnKey,
          String(observation.sourceSequence),
        ]),
        mutations: [{ kind: 'create', record }],
      };
      pending = {
        exchange,
        outcomeKey,
        sequence: observation.sourceSequence,
      };
      state.pendingOutcome = pending;
    }
    if (pending.sequence !== observation.sourceSequence) {
      this.setMonitoring('degraded');
      return true;
    }

    try {
      const presentationReceipt = parsePresentationReceipt(
        await this.presentation.exchange(pending.exchange),
      );
      assertMatchingPresentationReceipt(pending.exchange, presentationReceipt);
      if (presentationReceipt.kind !== 'applied' && presentationReceipt.kind !== 'replay') {
        if (presentationReceipt.kind === 'rejected') this.setMonitoring('degraded');
        return false;
      }
    } catch {
      return false;
    }

    state.outcomes.add(pending.outcomeKey);
    state.turns.delete(observation.turnKey);
    state.pendingOutcome = undefined;
    return true;
  }

  private async process(input: ObservationExchange): Promise<ExchangeReceipt> {
    const key = scopeKey(input.scope);
    let state = this.scopes.get(key);
    if (state === undefined) {
      state = createScopeState(input.deliveryGeneration);
      this.scopes.set(key, state);
    }

    if (input.kind === 'reconcile') {
      return receipt(state, this.monitoring, state.receivedThrough + 1);
    }
    const admissionReceipt = this.admitAppend(input, state);
    if (admissionReceipt !== undefined) return admissionReceipt;
    await this.applyAdmitted(input, state);
    return receipt(state, this.monitoring);
  }

  private setMonitoring(monitoring: MonitoringMode): void {
    if (this.monitoring === monitoring) return;
    this.monitoring = monitoring;
    const exactState =
      this.exactScopeKey === undefined ? undefined : this.scopes.get(this.exactScopeKey);
    this.onMonitoringChange({
      invocationId: this.invocationId,
      monitoring,
      reason: monitoringReason(monitoring),
      ...(exactState?.foregroundThreadKey === undefined
        ? {}
        : { foregroundThreadKey: exactState.foregroundThreadKey }),
    });
  }
}

function createScopeState(deliveryGeneration: string): ScopeState {
  return {
    admitted: new Map(),
    appliedThrough: 0,
    closed: false,
    deliveryGeneration,
    fingerprints: new Map(),
    outcomes: new Set(),
    qualified: false,
    receivedThrough: 0,
    retainedBytes: 0,
    role: 'unknown',
    turns: new Map(),
  };
}

function fingerprintValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function receipt(
  state: ScopeState,
  monitoring: MonitoringMode,
  replayFrom?: number,
): ExchangeReceipt {
  return {
    receivedThrough: state.receivedThrough,
    appliedThrough: state.appliedThrough,
    ...(replayFrom === undefined ? {} : { replayFrom }),
    monitoring,
  };
}

function compatibilityTitle(title: string): string {
  return title.startsWith('[Compatibility]') ? title : `[Compatibility] ${title}`;
}

function monitoringReason(monitoring: MonitoringMode): string {
  switch (monitoring) {
    case 'exact':
      return 'protocol-qualified';
    case 'compatibility':
      return 'protocol-unavailable';
    case 'unavailable':
      return 'no-source';
    case 'degraded':
      return 'authoritative-input-gap';
  }
}

function isMalformedAuditedQualification(
  observation: Extract<SanitizedAttentionObservation, { kind: 'connection-qualification' }>,
): boolean {
  return (
    observation.initialized &&
    observation.primary &&
    observation.capabilities === 'audited' &&
    observation.foregroundOwnership === 'confirmed' &&
    observation.evidence !== undefined &&
    /^0\.(?:145|146|147)\.\d+$/.test(observation.evidence.runtimeVersion)
  );
}

function retainedObservationBytes(scopes: Map<string, ScopeState>): number {
  let total = 0;
  for (const state of scopes.values()) total += state.retainedBytes;
  return total;
}

function retainedObservationCount(scopes: Map<string, ScopeState>): number {
  let total = 0;
  for (const state of scopes.values()) total += state.admitted.size;
  return total;
}

function scopeKey(scope: SourceScope): string {
  return JSON.stringify([scope.connectionId, scope.authorityEpoch]);
}

function stableIdentity(prefix: string, identity: string[]): string {
  const digest = createHash('sha256').update(JSON.stringify(identity), 'utf8').digest('hex');
  return `${prefix}:${digest}`.slice(0, ATTENTION_EXCHANGE_LIMITS.stableKeyBytes);
}
