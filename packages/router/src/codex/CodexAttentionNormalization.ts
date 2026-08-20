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

interface PendingOutcome {
  exchange: PresentationExchange;
  outcomeKey: string;
  sequence: number;
}

interface TurnState {
  foregroundThreadKey?: string;
  requests: Map<string, string>;
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
  private recoveryReconciledScopeKey?: string;
  private readonly recoveryExcludedTurnKeys = new Set<string>();
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
      case 'invocation-end': {
        if (this.exactScopeKey === scopeKey(scope)) {
          const withdrawn = await this.withdrawProtocolRequests(scope, state, observation);
          if (!withdrawn) return false;
          this.exactScopeKey = undefined;
        }
        state.qualified = false;
        state.closed = true;
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
          state.turns.set(observation.turnKey, {
            requests: new Map(),
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
        state.turns.set(observation.turnKey, {
          foregroundThreadKey: state.foregroundThreadKey,
          requests: new Map(),
          returnTarget: observation.returnTarget,
        });
        this.exactTurnKeys.add(observation.turnKey);
        return true;
      }
      case 'human-action-request':
        return this.applyRequest(scope, state, observation);
      case 'terminal-result':
        if (observation.result !== 'success') return true;
        return this.applySuccess(scope, state, observation);
      default:
        return true;
    }
  }

  private async applyRequest(
    scope: SourceScope,
    state: ScopeState,
    observation: Extract<SanitizedAttentionObservation, { kind: 'human-action-request' }>,
  ): Promise<boolean> {
    if (state.role === 'compatibility') return true;
    if (!state.qualified || this.exactScopeKey !== scopeKey(scope)) {
      this.setMonitoring('degraded');
      return true;
    }
    const turn = state.turns.get(observation.turnKey);
    if (turn === undefined || turn.foregroundThreadKey === undefined) {
      this.setMonitoring('degraded');
      return true;
    }
    if (turn.requests.has(observation.requestKey)) return true;

    const recordKey = stableIdentity('request', [
      scope.invocationId,
      scope.connectionId,
      scope.authorityEpoch,
      turn.foregroundThreadKey,
      observation.turnKey,
      observation.requestKind,
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

  private async withdrawProtocolRequests(
    scope: SourceScope,
    state: ScopeState,
    observation: { sourceSequence: number },
  ): Promise<boolean> {
    const keys = [...state.turns.values()].flatMap((turn) => [...turn.requests.values()]);
    if (keys.length === 0) return true;
    const exchange: PresentationExchange = {
      kind: 'apply',
      transactionId: stableIdentity('transaction', [
        scope.invocationId,
        scope.connectionId,
        scope.authorityEpoch,
        String(observation.sourceSequence),
        'authority-loss',
      ]),
      mutations: keys.map((key) => ({ kind: 'withdraw' as const, key })),
    };
    if (!(await this.applyPresentation(exchange))) return false;
    for (const turn of state.turns.values()) turn.requests.clear();
    return true;
  }

  private async applyPresentation(exchange: PresentationExchange): Promise<boolean> {
    try {
      const presentationReceipt = parsePresentationReceipt(
        await this.presentation.exchange(exchange),
      );
      assertMatchingPresentationReceipt(exchange, presentationReceipt);
      if (presentationReceipt.kind !== 'applied' && presentationReceipt.kind !== 'replay') {
        if (presentationReceipt.kind === 'rejected') this.setMonitoring('degraded');
        return false;
      }
      return true;
    } catch {
      return false;
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

    if (!(await this.applyPresentation(pending.exchange))) return false;

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
