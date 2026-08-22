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

import { compatibilityTitle } from './CodexMonitoringPresentation';

const MAXIMUM_INVOCATION_BYTES = 8 * 1024 * 1024;
const MAXIMUM_INVOCATION_OBSERVATIONS = 4_096;
const OUTBOX_RETRY_MAXIMUM_MS = 2_000;
const OUTBOX_RETRY_MINIMUM_MS = 100;
const TERMINAL_RECONCILIATION_MS = 5_000;

export interface CodexAttentionClock {
  setTimeout(callback: () => Promise<void>, milliseconds: number): void;
}

const systemClock: CodexAttentionClock = {
  setTimeout(callback, milliseconds): void {
    const timer = setTimeout(() => void callback().catch(() => {}), milliseconds);
    timer.unref();
  },
};

interface PendingOutcome {
  exchange: PresentationExchange;
  outcomeKey: string;
  sequence: number;
}

type PresentationApplicationResult = 'applied' | 'retry' | 'terminal-rejection';

interface TurnState {
  foregroundThreadKey?: string;
  interruptionIntentObserved?: boolean;
  requests: Map<string, string>;
  resolvedRequests: Set<string>;
  returnTarget: string;
  stagedFailure?: FailureDetail;
}

type ExactTurnState = TurnState & { foregroundThreadKey: string };

interface FailureDetail {
  canonicalBody?: string;
  errorKind: string;
}

type TerminalTurnState =
  | { kind: 'success' | 'interrupted' }
  | {
      kind: 'failure-pending';
      canonicalBody?: string;
      fallbackDetail?: FailureDetail;
      occurrenceKey: string;
      returnTarget: string;
      sourceSequence: number;
    }
  | {
      kind: 'failure';
      generic: boolean;
      record: PresentationRecord;
    };

type PendingFailure = Extract<TerminalTurnState, { kind: 'failure-pending' }>;

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
  scope: SourceScope;
  sidecarLease?: {
    generation: number;
    leaseKey: string;
    sourceSequence: number;
  };
  terminalTurns: Map<string, TerminalTurnState>;
  turns: Map<string, TurnState>;
}

interface UnexpectedEndState {
  reportingScope: SourceScope;
  requestsWithdrawn: boolean;
  retryAttempt: number;
  retryDelayMs: number;
  retryScheduled: boolean;
  sourceSequence: number;
  terminalRejections: Set<string>;
  turns: Array<{ ownerScopeKey: string; turnKey: string }>;
  withdrawalTerminallyRejected: boolean;
}

export type CodexMonitoringReason =
  | 'protocol-qualified'
  | 'protocol-unavailable'
  | 'no-source'
  | 'authoritative-input-gap'
  | 'hook-observed'
  | 'invocation-ended';

export type CodexMonitoringChange =
  | {
      invocationId: string;
      monitoring: MonitoringMode;
      reason: Exclude<CodexMonitoringReason, 'invocation-ended'>;
      foregroundThreadKey?: string;
    }
  | {
      invocationId: string;
      ended: true;
      reason: 'invocation-ended';
    };

export type CodexMonitoringListener = (change: CodexMonitoringChange) => void;

export class CodexAttentionNormalizationRegistry implements CodexAttentionNormalization {
  private readonly actors = new Map<string, InvocationActor>();

  constructor(
    private readonly presentation: AttentionPresentationPort,
    private readonly onMonitoringChange: CodexMonitoringListener = () => {},
    private readonly clock: CodexAttentionClock = systemClock,
  ) {}

  exchange(input: ObservationExchange): Promise<ExchangeReceipt> {
    const exchange = parseObservationExchange(input);
    let actor = this.actors.get(exchange.scope.invocationId);
    if (actor === undefined) {
      actor = new InvocationActor(
        this.presentation,
        exchange.scope.invocationId,
        this.onMonitoringChange,
        this.clock,
      );
      this.actors.set(exchange.scope.invocationId, actor);
    }
    return actor.exchange(exchange);
  }
}

class InvocationActor {
  private exactScopeKey?: string;
  private readonly exactTurnKeys = new Set<string>();
  private invocationEnded = false;
  private mailbox = Promise.resolve();
  private monitoring: MonitoringMode = 'compatibility';
  private recoveryBoundaryRequired = false;
  private recoveryCandidateScopeKey?: string;
  private recoveryReconciledScopeKey?: string;
  private readonly recoveryExcludedTurnKeys = new Set<string>();
  private readonly scopes = new Map<string, ScopeState>();
  private unexpectedEnd?: UnexpectedEndState;

  constructor(
    private readonly presentation: AttentionPresentationPort,
    private readonly invocationId: string,
    private readonly onMonitoringChange: CodexMonitoringListener,
    private readonly clock: CodexAttentionClock,
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
    if (
      this.invocationEnded &&
      observation.kind !== 'connection-end' &&
      observation.kind !== 'invocation-end' &&
      observation.kind !== 'terminal-error' &&
      observation.kind !== 'terminal-result' &&
      observation.kind !== 'interruption' &&
      observation.kind !== 'reconciliation-deadline'
    ) {
      return true;
    }
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
            this.exactTurnKeys.clear();
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
          if (state.turns.size > 0) {
            const withdrawn = await this.withdrawProtocolRequests(scope, state, observation);
            if (!withdrawn) return false;
            this.recoveryBoundaryRequired = true;
            for (const turnKey of state.turns.keys()) this.recoveryExcludedTurnKeys.add(turnKey);
          }
          this.exactScopeKey = undefined;
          state.qualified = false;
          state.closed = true;
          this.recoveryCandidateScopeKey = undefined;
          this.recoveryReconciledScopeKey = undefined;
        }
        this.setMonitoring(observation.monitoring);
        return true;
      }
      case 'connection-end':
      case 'invocation-end':
        return this.applyUnexpectedEnd(scope, state, observation);
      case 'turn-start': {
        if (state.terminalTurns.has(observation.turnKey)) return true;
        if (state.role === 'compatibility') {
          const existingTurn = state.turns.get(observation.turnKey);
          if (
            existingTurn !== undefined &&
            existingTurn.returnTarget !== observation.returnTarget
          ) {
            this.setMonitoring('degraded');
            return true;
          }
          if (existingTurn !== undefined) return true;
          if (!(await this.withdrawOverlappingTurnRequests(scope, state, observation)))
            return false;
          state.turns.set(observation.turnKey, {
            requests: new Map(),
            resolvedRequests: new Set(),
            returnTarget: observation.returnTarget,
          });
          return true;
        }
        const key = scopeKey(scope);
        if (
          state.qualified &&
          this.recoveryBoundaryRequired &&
          this.recoveryCandidateScopeKey === key
        ) {
          if (
            this.recoveryReconciledScopeKey !== key ||
            this.recoveryExcludedTurnKeys.has(observation.turnKey)
          ) {
            this.recoveryExcludedTurnKeys.add(observation.turnKey);
            return true;
          }
          this.exactScopeKey = key;
          this.exactTurnKeys.clear();
          this.recoveryBoundaryRequired = false;
          this.recoveryCandidateScopeKey = undefined;
          this.recoveryReconciledScopeKey = undefined;
          this.recoveryExcludedTurnKeys.clear();
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
        if (!(await this.withdrawOverlappingTurnRequests(scope, state, observation))) return false;
        state.turns.set(observation.turnKey, {
          foregroundThreadKey: state.foregroundThreadKey,
          requests: new Map(),
          resolvedRequests: new Set(),
          returnTarget: observation.returnTarget,
        });
        this.exactTurnKeys.add(observation.turnKey);
        return true;
      }
      case 'human-action-request':
        return this.applyRequest(scope, state, observation);
      case 'request-resolution':
        return this.applyRequestResolution(scope, state, observation);
      case 'retry-error':
        return true;
      case 'sidecar-lease':
        return true;
      case 'terminal-error':
        return this.applyTerminalError(scope, state, observation);
      case 'terminal-result':
        return observation.result === 'success'
          ? this.applySuccess(scope, state, observation)
          : this.applyFailure(scope, state, observation);
      case 'interruption':
        return this.applyInterruption(scope, state, observation);
      case 'interruption-intent': {
        const turn = this.activeExactTurn(scope, state, observation.turnKey);
        if (turn !== undefined) turn.interruptionIntentObserved = true;
        return true;
      }
      case 'reconciliation-deadline':
        return this.applyReconciliationDeadline(scope, state, observation);
      default:
        return true;
    }
  }

  private async applyRequest(
    scope: SourceScope,
    state: ScopeState,
    observation: Extract<SanitizedAttentionObservation, { kind: 'human-action-request' }>,
  ): Promise<boolean> {
    const turn = this.activeExactTurn(scope, state, observation.turnKey);
    if (turn === undefined) return true;
    if (
      turn.requests.has(observation.requestKey) ||
      turn.resolvedRequests.has(observation.requestKey)
    ) {
      return true;
    }

    const recordKey = stableIdentity('request', [
      scope.invocationId,
      scope.connectionId,
      scope.authorityEpoch,
      turn.foregroundThreadKey,
      observation.turnKey,
      observation.requestKey,
    ]);
    const exchange: PresentationExchange = {
      kind: 'apply',
      transactionId: stableIdentity('transaction', [
        scope.invocationId,
        scope.connectionId,
        scope.authorityEpoch,
        observation.turnKey,
        String(observation.sourceSequence),
        'request-create',
      ]),
      mutations: [
        {
          kind: 'create',
          record: {
            key: recordKey,
            revision: 1,
            appearance: 'action',
            canonicalTitle: observation.canonicalTitle ?? requestTitle(observation.requestKind),
            canonicalBody: observation.canonicalBody ?? 'Return to Codex to respond',
            returnTarget: turn.returnTarget,
          },
        },
      ],
    };
    if (!(await this.applyPresentation(exchange))) return false;
    turn.requests.set(observation.requestKey, recordKey);
    return true;
  }

  private async applyRequestResolution(
    scope: SourceScope,
    state: ScopeState,
    observation: Extract<SanitizedAttentionObservation, { kind: 'request-resolution' }>,
  ): Promise<boolean> {
    const turn = this.activeExactTurn(scope, state, observation.turnKey);
    if (turn === undefined) return true;
    if (turn.resolvedRequests.has(observation.requestKey)) return true;

    const recordKey = turn.requests.get(observation.requestKey);
    if (recordKey !== undefined) {
      const exchange: PresentationExchange = {
        kind: 'apply',
        transactionId: stableIdentity('transaction', [
          scope.invocationId,
          scope.connectionId,
          scope.authorityEpoch,
          observation.turnKey,
          String(observation.sourceSequence),
          'request-resolution',
        ]),
        mutations: [{ kind: 'withdraw', key: recordKey }],
      };
      if (!(await this.applyPresentation(exchange))) return false;
      turn.requests.delete(observation.requestKey);
    }
    turn.resolvedRequests.add(observation.requestKey);
    return true;
  }

  private async withdrawProtocolRequests(
    scope: SourceScope,
    state: ScopeState,
    observation: { sourceSequence: number },
  ): Promise<boolean> {
    return this.withdrawRequests(
      scope,
      state.turns.values(),
      observation.sourceSequence,
      'authority-loss',
    );
  }

  private async withdrawRequests(
    scope: SourceScope,
    turns: Iterable<TurnState>,
    sourceSequence: number,
    transactionKind: 'authority-loss' | 'unexpected-end',
  ): Promise<boolean> {
    return (
      (await this.withdrawRequestsResult(scope, turns, sourceSequence, transactionKind)) ===
      'applied'
    );
  }

  private async withdrawRequestsResult(
    scope: SourceScope,
    turns: Iterable<TurnState>,
    sourceSequence: number,
    transactionKind: 'authority-loss' | 'unexpected-end',
  ): Promise<PresentationApplicationResult> {
    const activeTurns = [...turns];
    const keys = activeTurns.flatMap((turn) => [...turn.requests.values()]);
    if (keys.length === 0) return 'applied';
    const exchange: PresentationExchange = {
      kind: 'apply',
      transactionId: stableIdentity('transaction', [
        scope.invocationId,
        scope.connectionId,
        scope.authorityEpoch,
        String(sourceSequence),
        transactionKind,
      ]),
      mutations: keys.map((key) => ({ kind: 'withdraw' as const, key })),
    };
    const application = await this.applyPresentationResult(exchange);
    if (application !== 'applied') return application;
    for (const turn of activeTurns) turn.requests.clear();
    return 'applied';
  }

  private async applyPresentation(exchange: PresentationExchange): Promise<boolean> {
    return (await this.applyPresentationResult(exchange)) === 'applied';
  }

  private async applyPresentationResult(
    exchange: PresentationExchange,
  ): Promise<PresentationApplicationResult> {
    try {
      const presentationReceipt = parsePresentationReceipt(
        await this.presentation.exchange(exchange),
      );
      assertMatchingPresentationReceipt(exchange, presentationReceipt);
      if (presentationReceipt.kind === 'applied' || presentationReceipt.kind === 'replay') {
        return 'applied';
      }
      if (presentationReceipt.kind === 'rejected') {
        this.setMonitoring('degraded');
        return presentationReceipt.reason === 'invalid' || presentationReceipt.reason === 'conflict'
          ? 'terminal-rejection'
          : 'retry';
      }
      return 'retry';
    } catch {
      return 'retry';
    }
  }

  private async applyFailure(
    scope: SourceScope,
    state: ScopeState,
    observation: Extract<SanitizedAttentionObservation, { kind: 'terminal-result' }>,
  ): Promise<boolean> {
    const existing = state.terminalTurns.get(observation.turnKey);
    if (existing !== undefined) {
      if (existing.kind !== 'failure' && existing.kind !== 'failure-pending') {
        this.setMonitoring('degraded');
      }
      return true;
    }
    const turn = this.activeTerminalTurn(scope, state, observation.turnKey);
    if (turn === undefined) return true;
    const detail = turn.stagedFailure;
    if (detail !== undefined && !failurePresentation(detail).generic) {
      return this.createFailure(scope, state, observation, turn, detail);
    }

    const requestKeys = [...turn.requests.values()];
    if (requestKeys.length > 0) {
      const exchange: PresentationExchange = {
        kind: 'apply',
        transactionId: stableIdentity('transaction', [
          scope.invocationId,
          scope.connectionId,
          scope.authorityEpoch,
          observation.turnKey,
          String(observation.sourceSequence),
          'failure-reconciliation',
        ]),
        mutations: requestKeys.map((key) => ({ kind: 'withdraw' as const, key })),
      };
      if (!(await this.applyPresentation(exchange))) return false;
      turn.requests.clear();
    }
    state.terminalTurns.set(observation.turnKey, {
      kind: 'failure-pending',
      ...(observation.canonicalBody === undefined
        ? {}
        : { canonicalBody: observation.canonicalBody }),
      ...(detail === undefined ? {} : { fallbackDetail: detail }),
      occurrenceKey: observation.occurrenceKey,
      returnTarget: turn.returnTarget,
      sourceSequence: observation.sourceSequence,
    });
    state.turns.delete(observation.turnKey);
    this.scheduleFailureDeadline(scope, observation.turnKey);
    return true;
  }

  private async applyUnexpectedEnd(
    scope: SourceScope,
    state: ScopeState,
    observation: Extract<
      SanitizedAttentionObservation,
      { kind: 'connection-end' | 'invocation-end' }
    >,
  ): Promise<boolean> {
    if (this.invocationEnded) {
      state.closed = true;
      return (await this.withdrawUnexpectedEndRequests()) !== 'retry';
    }
    const reportingScopeKey = scopeKey(scope);
    if (this.exactScopeKey !== undefined && this.exactScopeKey !== reportingScopeKey) {
      return true;
    }

    this.invocationEnded = true;
    for (const scopeState of this.scopes.values()) scopeState.closed = true;
    this.recoveryBoundaryRequired = false;
    this.recoveryCandidateScopeKey = undefined;
    this.recoveryReconciledScopeKey = undefined;
    this.recoveryExcludedTurnKeys.clear();
    this.monitoring = 'unavailable';
    this.onMonitoringChange({
      invocationId: this.invocationId,
      ended: true,
      reason: 'invocation-ended',
    });

    const turns = this.selectUnexpectedEndOwners(reportingScopeKey, state);
    if (turns.length === 0) {
      state.qualified = false;
      if (this.exactScopeKey === reportingScopeKey) this.exactScopeKey = undefined;
      return true;
    }

    this.unexpectedEnd = {
      reportingScope: scope,
      requestsWithdrawn: false,
      retryAttempt: 0,
      retryDelayMs: OUTBOX_RETRY_MINIMUM_MS,
      retryScheduled: false,
      sourceSequence: observation.sourceSequence,
      terminalRejections: new Set(),
      turns,
      withdrawalTerminallyRejected: false,
    };
    this.clock.setTimeout(
      () => this.enqueueScheduled(() => this.expireUnexpectedEnd()),
      TERMINAL_RECONCILIATION_MS,
    );
    return (await this.withdrawUnexpectedEndRequests()) !== 'retry';
  }

  private selectUnexpectedEndOwners(
    reportingScopeKey: string,
    reportingState: ScopeState,
  ): Array<{ ownerScopeKey: string; turnKey: string }> {
    const exactScopeKey = this.exactScopeKey;
    const exactState = exactScopeKey === undefined ? undefined : this.scopes.get(exactScopeKey);
    if (exactScopeKey !== undefined) {
      if (exactState === undefined) return [];
      return [...exactState.turns.keys()].map((turnKey) => ({
        ownerScopeKey: exactScopeKey,
        turnKey,
      }));
    }

    const owners = [...reportingState.turns.keys()].map((turnKey) => ({
      ownerScopeKey: reportingScopeKey,
      turnKey,
    }));
    for (const [key, scopeState] of this.scopes) {
      if (key === reportingScopeKey) continue;
      for (const turnKey of scopeState.turns.keys()) {
        owners.push({ ownerScopeKey: key, turnKey });
      }
    }
    return owners;
  }

  private async withdrawUnexpectedEndRequests(): Promise<PresentationApplicationResult> {
    const ending = this.unexpectedEnd;
    if (ending === undefined || ending.requestsWithdrawn) return 'applied';
    if (ending.withdrawalTerminallyRejected) return 'terminal-rejection';
    const application = await this.withdrawRequestsResult(
      ending.reportingScope,
      [...this.scopes.values()].flatMap((scopeState) => [...scopeState.turns.values()]),
      ending.sourceSequence,
      'unexpected-end',
    );
    if (application === 'applied') {
      ending.requestsWithdrawn = true;
      this.resetUnexpectedEndRetry();
    } else if (application === 'terminal-rejection') {
      ending.withdrawalTerminallyRejected = true;
    }
    return application;
  }

  private renewSidecarLease(
    scope: SourceScope,
    state: ScopeState,
    observation: Extract<SanitizedAttentionObservation, { kind: 'sidecar-lease' }>,
  ): void {
    if (state.closed) return;
    const current = state.sidecarLease;
    if (current !== undefined && current.leaseKey !== observation.leaseKey) {
      this.setMonitoring('degraded');
      return;
    }
    const generation = (current?.generation ?? 0) + 1;
    state.sidecarLease = {
      generation,
      leaseKey: observation.leaseKey,
      sourceSequence: observation.sourceSequence,
    };
    this.clock.setTimeout(
      () =>
        this.enqueueScheduled(() =>
          this.expireSidecarLease(scope, observation.leaseKey, generation),
        ),
      observation.expiresAfterMs,
    );
  }

  private async expireSidecarLease(
    scope: SourceScope,
    leaseKey: string,
    generation: number,
  ): Promise<void> {
    const state = this.scopes.get(scopeKey(scope));
    if (
      state === undefined ||
      state.closed ||
      state.sidecarLease?.leaseKey !== leaseKey ||
      state.sidecarLease.generation !== generation
    ) {
      return;
    }
    await this.applyUnexpectedEnd(scope, state, {
      kind: 'connection-end',
      sourceSequence: state.sidecarLease.sourceSequence,
      endKey: 'foreground-end',
      endSource: 'lease-expiry',
      reason: 'sidecar-lease-expired',
    });
  }

  private async expireUnexpectedEnd(): Promise<void> {
    const ending = this.unexpectedEnd;
    if (ending === undefined) return;
    const withdrawal = await this.withdrawUnexpectedEndRequests();
    if (withdrawal === 'retry') {
      this.scheduleUnexpectedEndRetry();
      return;
    }
    if (withdrawal === 'terminal-rejection') return;
    let retryNeeded = false;
    for (const { ownerScopeKey, turnKey } of ending.turns) {
      const scopedTurnKey = JSON.stringify([ownerScopeKey, turnKey]);
      if (ending.terminalRejections.has(scopedTurnKey)) continue;
      const state = this.scopes.get(ownerScopeKey);
      if (state === undefined) continue;
      const turn = state.turns.get(turnKey);
      if (turn === undefined || state.terminalTurns.has(turnKey)) continue;
      if (turn.interruptionIntentObserved) {
        state.terminalTurns.set(turnKey, { kind: 'interrupted' });
        state.turns.delete(turnKey);
        continue;
      }
      const result = await this.createStoppedFailure(
        state.scope,
        state,
        turnKey,
        ending.sourceSequence,
        turn,
      );
      if (result === 'retry') {
        retryNeeded = true;
      } else if (result === 'terminal-rejection') {
        ending.terminalRejections.add(scopedTurnKey);
      } else {
        this.resetUnexpectedEndRetry();
      }
    }
    if (retryNeeded) this.scheduleUnexpectedEndRetry();
  }

  private scheduleUnexpectedEndRetry(): void {
    const ending = this.unexpectedEnd;
    if (ending === undefined || ending.retryScheduled) return;
    const baseDelayMs = ending.retryDelayMs;
    const delayMs = retryDelayWithJitter(baseDelayMs, [
      ending.reportingScope.invocationId,
      ending.reportingScope.connectionId,
      ending.reportingScope.authorityEpoch,
      String(ending.sourceSequence),
      String(ending.retryAttempt),
    ]);
    ending.retryScheduled = true;
    ending.retryAttempt++;
    ending.retryDelayMs = Math.min(OUTBOX_RETRY_MAXIMUM_MS, baseDelayMs * 2);
    this.clock.setTimeout(
      () =>
        this.enqueueScheduled(async () => {
          const current = this.unexpectedEnd;
          if (current === undefined) return;
          current.retryScheduled = false;
          await this.expireUnexpectedEnd();
        }),
      delayMs,
    );
  }

  private resetUnexpectedEndRetry(): void {
    const ending = this.unexpectedEnd;
    if (ending === undefined) return;
    ending.retryAttempt = 0;
    ending.retryDelayMs = OUTBOX_RETRY_MINIMUM_MS;
  }

  private async createStoppedFailure(
    scope: SourceScope,
    state: ScopeState,
    turnKey: string,
    sourceSequence: number,
    turn: TurnState,
  ): Promise<PresentationApplicationResult> {
    const outcomeKey = failureOutcomeKey(scope, state, turnKey, 'unexpected-stop');
    if (state.outcomes.has(outcomeKey)) return 'applied';
    const record: PresentationRecord = {
      key: outcomeKey,
      revision: 1,
      appearance: 'failure',
      canonicalTitle:
        state.role === 'compatibility' ? compatibilityTitle('Codex stopped') : 'Codex stopped',
      canonicalBody: 'Return to Codex to view details',
      returnTarget: turn.returnTarget,
    };
    const exchange: PresentationExchange = {
      kind: 'apply',
      transactionId: stableIdentity('transaction', [
        scope.invocationId,
        scope.connectionId,
        scope.authorityEpoch,
        turnKey,
        String(sourceSequence),
        'unexpected-stop',
      ]),
      mutations: [{ kind: 'create', record }],
    };
    const application = await this.applyPresentationResult(exchange);
    if (application !== 'applied') return application;

    state.outcomes.add(outcomeKey);
    state.terminalTurns.set(turnKey, { kind: 'failure', generic: true, record });
    state.turns.delete(turnKey);
    return 'applied';
  }

  private async withdrawOverlappingTurnRequests(
    scope: SourceScope,
    state: ScopeState,
    observation: Extract<SanitizedAttentionObservation, { kind: 'turn-start' }>,
  ): Promise<boolean> {
    const olderTurns = [...state.turns.entries()].filter(
      ([turnKey]) => turnKey !== observation.turnKey,
    );
    if (olderTurns.length === 0) return true;
    const requestKeys = olderTurns.flatMap(([, turn]) => [...turn.requests.values()]);
    if (requestKeys.length > 0) {
      const exchange: PresentationExchange = {
        kind: 'apply',
        transactionId: stableIdentity('transaction', [
          scope.invocationId,
          scope.connectionId,
          scope.authorityEpoch,
          observation.turnKey,
          String(observation.sourceSequence),
          'new-turn-overlap',
        ]),
        mutations: requestKeys.map((key) => ({ kind: 'withdraw' as const, key })),
      };
      if (!(await this.applyPresentation(exchange))) return false;
    }
    for (const [, turn] of olderTurns) turn.requests.clear();
    if (state.role !== 'compatibility') this.setMonitoring('degraded');
    return true;
  }

  private async createFailure(
    scope: SourceScope,
    state: ScopeState,
    observation: Extract<SanitizedAttentionObservation, { kind: 'terminal-result' }>,
    turn: TurnState,
    detail: FailureDetail | undefined,
  ): Promise<boolean> {
    const outcomeKey = failureOutcomeKey(
      scope,
      state,
      observation.turnKey,
      observation.occurrenceKey,
    );
    if (state.outcomes.has(outcomeKey)) return true;
    const presentation = failurePresentation(detail);
    const record: PresentationRecord = {
      key: outcomeKey,
      revision: 1,
      appearance: 'failure',
      canonicalTitle:
        state.role === 'compatibility'
          ? compatibilityTitle(presentation.title)
          : presentation.title,
      canonicalBody:
        detail?.canonicalBody ?? observation.canonicalBody ?? 'Return to Codex to view details',
      returnTarget: turn.returnTarget,
    };
    const exchange: PresentationExchange = {
      kind: 'apply',
      transactionId: stableIdentity('transaction', [
        scope.invocationId,
        scope.connectionId,
        scope.authorityEpoch,
        observation.turnKey,
        String(observation.sourceSequence),
        'failure',
      ]),
      mutations: [
        ...[...turn.requests.values()].map((key) => ({ kind: 'withdraw' as const, key })),
        { kind: 'create', record },
      ],
    };
    if (!(await this.applyPresentation(exchange))) return false;

    state.outcomes.add(outcomeKey);
    state.terminalTurns.set(observation.turnKey, {
      kind: 'failure',
      generic: presentation.generic,
      record,
    });
    turn.requests.clear();
    state.turns.delete(observation.turnKey);
    return true;
  }

  private async applyTerminalError(
    scope: SourceScope,
    state: ScopeState,
    observation: Extract<SanitizedAttentionObservation, { kind: 'retry-error' | 'terminal-error' }>,
  ): Promise<boolean> {
    const detail: FailureDetail = {
      errorKind: observation.errorKind,
      ...(observation.canonicalBody === undefined
        ? {}
        : { canonicalBody: observation.canonicalBody }),
    };
    const terminal = state.terminalTurns.get(observation.turnKey);
    if (terminal?.kind === 'failure-pending') {
      if (failurePresentation(detail).generic) {
        state.terminalTurns.set(observation.turnKey, {
          ...terminal,
          fallbackDetail: detail,
        });
        return true;
      }
      return this.settlePendingFailure(
        scope,
        state,
        observation.turnKey,
        observation.sourceSequence,
        terminal,
        detail,
      );
    }
    if (terminal?.kind === 'failure') {
      if (!terminal.generic || failurePresentation(detail).generic) return true;
      const presentation = failurePresentation(detail);
      const record: PresentationRecord = {
        ...terminal.record,
        revision: terminal.record.revision + 1,
        canonicalTitle:
          state.role === 'compatibility'
            ? compatibilityTitle(presentation.title)
            : presentation.title,
        canonicalBody: detail.canonicalBody ?? terminal.record.canonicalBody,
      };
      const exchange: PresentationExchange = {
        kind: 'apply',
        transactionId: stableIdentity('transaction', [
          scope.invocationId,
          scope.connectionId,
          scope.authorityEpoch,
          observation.turnKey,
          String(observation.sourceSequence),
          'failure-enrichment',
        ]),
        mutations: [{ kind: 'update', record }],
      };
      if (!(await this.applyPresentation(exchange))) return false;
      state.terminalTurns.set(observation.turnKey, {
        kind: 'failure',
        generic: false,
        record,
      });
      return true;
    }
    if (terminal !== undefined) return true;

    const turn = this.activeTerminalTurn(scope, state, observation.turnKey);
    if (turn !== undefined) turn.stagedFailure = detail;
    return true;
  }

  private async applyReconciliationDeadline(
    scope: SourceScope,
    state: ScopeState,
    observation: Extract<SanitizedAttentionObservation, { kind: 'reconciliation-deadline' }>,
  ): Promise<boolean> {
    const terminal = state.terminalTurns.get(observation.turnKey);
    if (terminal?.kind !== 'failure-pending') return true;
    return this.settlePendingFailure(
      scope,
      state,
      observation.turnKey,
      observation.sourceSequence,
      terminal,
    );
  }

  private scheduleFailureDeadline(scope: SourceScope, turnKey: string): void {
    this.clock.setTimeout(
      () => this.enqueueScheduled(() => this.expireFailureReconciliation(scope, turnKey)),
      TERMINAL_RECONCILIATION_MS,
    );
  }

  private enqueueScheduled(task: () => Promise<void>): Promise<void> {
    const result = this.mailbox.then(task);
    this.mailbox = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async expireFailureReconciliation(scope: SourceScope, turnKey: string): Promise<void> {
    const state = this.scopes.get(scopeKey(scope));
    const terminal = state?.terminalTurns.get(turnKey);
    if (state === undefined || terminal?.kind !== 'failure-pending') return;
    await this.settlePendingFailure(scope, state, turnKey, terminal.sourceSequence, terminal);
  }

  private settlePendingFailure(
    scope: SourceScope,
    state: ScopeState,
    turnKey: string,
    sourceSequence: number,
    terminal: PendingFailure,
    detail: FailureDetail | undefined = terminal.fallbackDetail,
  ): Promise<boolean> {
    const turn: TurnState = {
      requests: new Map(),
      resolvedRequests: new Set(),
      returnTarget: terminal.returnTarget,
    };
    return this.createFailure(
      scope,
      state,
      {
        kind: 'terminal-result',
        sourceSequence,
        turnKey,
        result: 'failure',
        occurrenceKey: terminal.occurrenceKey,
        ...(terminal.canonicalBody === undefined ? {} : { canonicalBody: terminal.canonicalBody }),
      },
      turn,
      detail,
    );
  }

  private async applyInterruption(
    scope: SourceScope,
    state: ScopeState,
    observation: Extract<SanitizedAttentionObservation, { kind: 'interruption' }>,
  ): Promise<boolean> {
    const terminal = state.terminalTurns.get(observation.turnKey);
    if (terminal !== undefined) {
      if (terminal.kind !== 'interrupted') this.setMonitoring('degraded');
      return true;
    }
    const turn = this.activeTerminalTurn(scope, state, observation.turnKey);
    if (turn === undefined) return true;
    const requestKeys = [...turn.requests.values()];
    if (requestKeys.length > 0) {
      const exchange: PresentationExchange = {
        kind: 'apply',
        transactionId: stableIdentity('transaction', [
          scope.invocationId,
          scope.connectionId,
          scope.authorityEpoch,
          observation.turnKey,
          String(observation.sourceSequence),
          'interruption',
        ]),
        mutations: requestKeys.map((key) => ({ kind: 'withdraw' as const, key })),
      };
      if (!(await this.applyPresentation(exchange))) return false;
    }
    state.terminalTurns.set(observation.turnKey, { kind: 'interrupted' });
    turn.requests.clear();
    state.turns.delete(observation.turnKey);
    return true;
  }

  private activeTerminalTurn(
    scope: SourceScope,
    state: ScopeState,
    turnKey: string,
  ): TurnState | undefined {
    const compatibility = state.role === 'compatibility';
    if (compatibility && this.exactScopeKey !== undefined && this.exactTurnKeys.has(turnKey)) {
      return undefined;
    }
    if (!compatibility && (!state.qualified || this.exactScopeKey !== scopeKey(scope))) {
      this.setMonitoring('degraded');
      return undefined;
    }
    const turn = state.turns.get(turnKey);
    if (turn === undefined) {
      this.setMonitoring('degraded');
      return undefined;
    }
    return turn;
  }

  private activeExactTurn(
    scope: SourceScope,
    state: ScopeState,
    turnKey: string,
  ): ExactTurnState | undefined {
    if (state.role === 'compatibility') return undefined;
    if (!state.qualified || this.exactScopeKey !== scopeKey(scope)) {
      this.setMonitoring('degraded');
      return undefined;
    }
    if (state.terminalTurns.has(turnKey)) return undefined;
    const turn = state.turns.get(turnKey);
    if (turn?.foregroundThreadKey === undefined) {
      this.setMonitoring('degraded');
      return undefined;
    }
    return turn as ExactTurnState;
  }

  private async applySuccess(
    scope: SourceScope,
    state: ScopeState,
    observation: Extract<SanitizedAttentionObservation, { kind: 'terminal-result' }>,
  ): Promise<boolean> {
    const existing = state.terminalTurns.get(observation.turnKey);
    if (existing !== undefined) {
      if (existing.kind !== 'success') this.setMonitoring('degraded');
      return true;
    }
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
        mutations: [
          ...[...turn.requests.values()].map((key) => ({ kind: 'withdraw' as const, key })),
          { kind: 'create', record },
        ],
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

    if (!(await this.applyPresentation(pending.exchange))) return false;

    state.outcomes.add(pending.outcomeKey);
    state.terminalTurns.set(observation.turnKey, { kind: 'success' });
    turn?.requests.clear();
    state.turns.delete(observation.turnKey);
    state.pendingOutcome = undefined;
    return true;
  }

  private async process(input: ObservationExchange): Promise<ExchangeReceipt> {
    const key = scopeKey(input.scope);
    let state = this.scopes.get(key);
    if (state === undefined) {
      state = createScopeState(input.scope, input.deliveryGeneration);
      if (this.invocationEnded) state.closed = true;
      this.scopes.set(key, state);
    }

    if (input.kind === 'reconcile') {
      if (state.deliveryGeneration !== input.deliveryGeneration) {
        this.setMonitoring('degraded');
        return receipt(state, this.monitoring, state.receivedThrough + 1);
      }
      if (
        this.recoveryCandidateScopeKey === key &&
        input.checkpoint.monitoring === 'exact' &&
        input.checkpoint.observations.some(
          (observation) =>
            observation.kind === 'connection-qualification' &&
            isExactConnectionQualification(observation) &&
            observation.evidence?.requestedThreadKey === state.foregroundThreadKey,
        )
      ) {
        this.recoveryReconciledScopeKey = key;
        return receipt(state, this.monitoring);
      }
      return receipt(state, this.monitoring, state.receivedThrough + 1);
    }
    const admissionReceipt = this.admitAppend(input, state);
    if (admissionReceipt !== undefined) return admissionReceipt;
    for (const observation of input.observations) {
      if (observation.kind === 'sidecar-lease') {
        this.renewSidecarLease(input.scope, state, observation);
      }
    }
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

function createScopeState(scope: SourceScope, deliveryGeneration: string): ScopeState {
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
    scope,
    terminalTurns: new Map(),
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

function monitoringReason(
  monitoring: MonitoringMode,
): Exclude<CodexMonitoringReason, 'invocation-ended' | 'hook-observed'> {
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

function requestTitle(
  requestKind: Extract<
    SanitizedAttentionObservation,
    { kind: 'human-action-request' }
  >['requestKind'],
): string {
  switch (requestKind) {
    case 'approval':
      return 'Codex is waiting for approval';
    case 'input':
      return 'Codex is waiting for your answer';
    case 'permission':
      return 'Codex is waiting for permission';
    case 'elicitation':
      return 'Codex is waiting for an MCP response';
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

function failureOutcomeKey(
  scope: SourceScope,
  state: ScopeState,
  turnKey: string,
  occurrenceKey: string,
): string {
  return stableIdentity('outcome', [
    scope.invocationId,
    scope.connectionId,
    scope.authorityEpoch,
    state.foregroundThreadKey ?? 'compatibility',
    turnKey,
    occurrenceKey,
  ]);
}

function failurePresentation(detail: FailureDetail | undefined): {
  generic: boolean;
  title: string;
} {
  switch (detail?.errorKind) {
    case 'usageLimitExceeded':
    case 'sessionBudgetExceeded':
      return { generic: false, title: 'Codex usage limit reached' };
    case 'contextWindowExceeded':
      return { generic: false, title: 'Codex context window exceeded' };
    case 'unauthorized':
      return { generic: false, title: 'Codex authentication failed' };
    case 'serverOverloaded':
    case 'internalServerError':
      return { generic: false, title: 'Codex service failed' };
    case 'sandboxError':
    case 'cyberPolicy':
      return { generic: false, title: 'Codex policy check failed' };
    case 'badRequest':
      return { generic: false, title: 'Codex request failed' };
    case 'threadRollbackFailed':
      return { generic: false, title: 'Codex session recovery failed' };
    case 'activeTurnNotSteerable':
      return { generic: false, title: 'Codex state conflict' };
    case 'httpConnectionFailed':
    case 'responseStreamConnectionFailed':
    case 'responseStreamDisconnected':
    case 'responseTooManyFailedAttempts':
      return { generic: false, title: 'Codex connection failed' };
    default:
      return { generic: true, title: 'Codex failed' };
  }
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

function retryDelayWithJitter(baseDelayMs: number, identity: string[]): number {
  const sample = createHash('sha256').update(JSON.stringify(identity), 'utf8').digest()[0];
  const jitterRange = Math.max(1, Math.floor(baseDelayMs / 4));
  return Math.min(OUTBOX_RETRY_MAXIMUM_MS, baseDelayMs + 1 + (sample % jitterRange));
}
