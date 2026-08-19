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
  occurrenceKey: string;
  sequence: number;
}

interface ScopeState {
  admitted: Map<number, SanitizedAttentionObservation>;
  appliedThrough: number;
  deliveryGeneration: string;
  fingerprints: Map<number, string>;
  monitoring: MonitoringMode;
  outcomes: Set<string>;
  pendingOutcome?: PendingOutcome;
  qualified: boolean;
  receivedThrough: number;
  retainedBytes: number;
  turns: Map<string, { returnTarget: string }>;
}

export class CodexAttentionNormalizationRegistry implements CodexAttentionNormalization {
  private readonly actors = new Map<string, InvocationActor>();

  constructor(private readonly presentation: AttentionPresentationPort) {}

  exchange(input: ObservationExchange): Promise<ExchangeReceipt> {
    const exchange = parseObservationExchange(input);
    let actor = this.actors.get(exchange.scope.invocationId);
    if (actor === undefined) {
      actor = new InvocationActor(this.presentation);
      this.actors.set(exchange.scope.invocationId, actor);
    }
    return actor.exchange(exchange);
  }
}

class InvocationActor {
  private mailbox = Promise.resolve();
  private readonly scopes = new Map<string, ScopeState>();

  constructor(private readonly presentation: AttentionPresentationPort) {}

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
      return receipt(state, expectedSequence);
    }
    if (state.deliveryGeneration !== input.deliveryGeneration) {
      state.monitoring = 'degraded';
      return receipt(state, expectedSequence);
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
          state.monitoring = 'degraded';
          return receipt(state);
        }
        continue;
      }
      if (observation.sourceSequence !== nextSequence) {
        return receipt(state, nextSequence);
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
      state.monitoring = 'degraded';
      return receipt(state, expectedSequence);
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
      case 'connection-qualification':
        state.qualified = isExactConnectionQualification(observation);
        state.monitoring = state.qualified ? 'exact' : 'compatibility';
        return true;
      case 'turn-start':
        if (!state.qualified) {
          state.monitoring = 'degraded';
          return true;
        }
        state.turns.set(observation.turnKey, { returnTarget: observation.returnTarget });
        return true;
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
    if (!state.qualified) {
      state.monitoring = 'degraded';
      return true;
    }
    if (state.outcomes.has(observation.occurrenceKey)) return true;

    let pending = state.pendingOutcome;
    if (pending === undefined) {
      const turn = state.turns.get(observation.turnKey);
      if (turn === undefined) {
        state.monitoring = 'degraded';
        return true;
      }
      const record: PresentationRecord = {
        key: stableIdentity('outcome', scope, observation.occurrenceKey),
        revision: 1,
        appearance: 'information',
        canonicalTitle: observation.canonicalTitle ?? 'Codex completed',
        canonicalBody: observation.canonicalBody ?? 'Return to Codex to view details',
        returnTarget: turn.returnTarget,
      };
      const exchange: PresentationExchange = {
        kind: 'apply',
        transactionId: stableIdentity('transaction', scope, String(observation.sourceSequence)),
        mutations: [{ kind: 'create', record }],
      };
      pending = {
        exchange,
        occurrenceKey: observation.occurrenceKey,
        sequence: observation.sourceSequence,
      };
      state.pendingOutcome = pending;
    }
    if (pending.sequence !== observation.sourceSequence) {
      state.monitoring = 'degraded';
      return true;
    }

    try {
      const presentationReceipt = parsePresentationReceipt(
        await this.presentation.exchange(pending.exchange),
      );
      assertMatchingPresentationReceipt(pending.exchange, presentationReceipt);
      if (presentationReceipt.kind !== 'applied' && presentationReceipt.kind !== 'replay') {
        if (presentationReceipt.kind === 'rejected') state.monitoring = 'degraded';
        return false;
      }
    } catch {
      return false;
    }

    state.outcomes.add(pending.occurrenceKey);
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
      return receipt(state, state.receivedThrough + 1);
    }
    const admissionReceipt = this.admitAppend(input, state);
    if (admissionReceipt !== undefined) return admissionReceipt;
    await this.applyAdmitted(input, state);
    return receipt(state);
  }
}

function createScopeState(deliveryGeneration: string): ScopeState {
  return {
    admitted: new Map(),
    appliedThrough: 0,
    deliveryGeneration,
    fingerprints: new Map(),
    monitoring: 'compatibility',
    outcomes: new Set(),
    qualified: false,
    receivedThrough: 0,
    retainedBytes: 0,
    turns: new Map(),
  };
}

function fingerprintValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function receipt(state: ScopeState, replayFrom?: number): ExchangeReceipt {
  return {
    receivedThrough: state.receivedThrough,
    appliedThrough: state.appliedThrough,
    ...(replayFrom === undefined ? {} : { replayFrom }),
    monitoring: state.monitoring,
  };
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
  return `${scope.connectionId}\0${scope.authorityEpoch}`;
}

function stableIdentity(prefix: string, scope: SourceScope, semanticKey: string): string {
  const digest = createHash('sha256')
    .update(
      `${scope.invocationId}\0${scope.connectionId}\0${scope.authorityEpoch}\0${semanticKey}`,
      'utf8',
    )
    .digest('hex');
  return `${prefix}:${digest}`.slice(0, ATTENTION_EXCHANGE_LIMITS.stableKeyBytes);
}
