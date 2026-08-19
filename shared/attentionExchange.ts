import { createCodexReturnTarget } from './codexReturnTarget';

export const ATTENTION_EXCHANGE_LIMITS = Object.freeze({
  canonicalBodyBytes: 16_384,
  canonicalTitleBytes: 4_096,
  envelopeBytes: 65_536,
  identifierBytes: 256,
  observations: 4_096,
  opaqueReturnTargetBytes: 4_096,
  presentationRecords: 10_000,
  stableKeyBytes: 512,
});

export type MonitoringMode = 'exact' | 'compatibility' | 'unavailable' | 'degraded';
export type AttentionAppearance = 'information' | 'action' | 'failure';

export interface SourceScope {
  invocationId: string;
  connectionId: string;
  authorityEpoch: string;
}

export interface SequenceRange {
  fromSequence: number;
  throughSequence: number;
}

export interface ConnectionQualificationEvidence {
  runtimeVersion: string;
  clientName: string;
  clientVersion: string;
  experimentalApi: boolean;
  optedOutNotifications: string[];
  serverUserAgent: string;
  initializationRequestKey: string;
  initializationResponseKey: string;
  initializationAcknowledged: boolean;
  foregroundRequestKind: 'fork' | 'resume' | 'start';
  foregroundRequestKey: string;
  foregroundResponseKey: string;
  requestedThreadKey: string;
  announcedThreadKey: string;
  foregroundSessionKey: string;
  foregroundSource: 'appServer' | 'cli' | 'custom' | 'exec' | 'subAgent' | 'unknown' | 'vscode';
  foregroundParentKey: string | null;
}

const REQUIRED_EXACT_NOTIFICATION_METHODS = new Set([
  'thread/started',
  'turn/started',
  'turn/completed',
]);

export type SanitizedAttentionObservation =
  | {
      kind: 'connection-qualification';
      sourceSequence: number;
      initialized: boolean;
      primary: boolean;
      capabilities: 'audited' | 'unsupported' | 'unknown';
      foregroundOwnership: 'confirmed' | 'unconfirmed';
      evidence?: ConnectionQualificationEvidence;
    }
  | {
      kind: 'authority-change';
      sourceSequence: number;
      monitoring: MonitoringMode;
    }
  | {
      kind: 'turn-start';
      sourceSequence: number;
      turnKey: string;
      returnTarget: string;
    }
  | {
      kind: 'human-action-request';
      sourceSequence: number;
      turnKey: string;
      requestKey: string;
      requestKind: 'approval' | 'input' | 'permission' | 'elicitation';
      canonicalTitle?: string;
      canonicalBody?: string;
    }
  | {
      kind: 'request-resolution';
      sourceSequence: number;
      turnKey: string;
      requestKey: string;
    }
  | {
      kind: 'retry-error' | 'terminal-error';
      sourceSequence: number;
      turnKey: string;
      errorKind: string;
      canonicalBody?: string;
    }
  | {
      kind: 'terminal-result';
      sourceSequence: number;
      turnKey: string;
      result: 'success' | 'failure';
      occurrenceKey: string;
      canonicalTitle?: string;
      canonicalBody?: string;
    }
  | {
      kind: 'interruption';
      sourceSequence: number;
      turnKey: string;
    }
  | {
      kind: 'invocation-end' | 'connection-end';
      sourceSequence: number;
      endKey: string;
    }
  | {
      kind: 'reconciliation-deadline';
      sourceSequence: number;
      turnKey: string;
    }
  | {
      kind: 'content-enrichment';
      sourceSequence: number;
      semanticKey: string;
      canonicalTitle?: string;
      canonicalBody?: string;
    };

export function isExactConnectionQualification(
  observation: Extract<SanitizedAttentionObservation, { kind: 'connection-qualification' }>,
): boolean {
  if (
    !observation.initialized ||
    !observation.primary ||
    observation.capabilities !== 'audited' ||
    observation.foregroundOwnership !== 'confirmed' ||
    observation.evidence === undefined
  ) {
    return false;
  }

  try {
    const evidence = parseConnectionQualificationEvidence(
      observation.evidence,
      'connectionQualification.evidence',
    );
    if (
      evidence.clientName !== 'codex-tui' ||
      !evidence.experimentalApi ||
      evidence.optedOutNotifications.some((method) =>
        REQUIRED_EXACT_NOTIFICATION_METHODS.has(method),
      ) ||
      !evidence.initializationAcknowledged ||
      evidence.runtimeVersion !== evidence.clientVersion ||
      !/^0\.(?:145|146|147)\.\d+$/.test(evidence.runtimeVersion) ||
      evidence.initializationRequestKey !== evidence.initializationResponseKey ||
      evidence.foregroundRequestKey !== evidence.foregroundResponseKey ||
      evidence.requestedThreadKey !== evidence.announcedThreadKey
    ) {
      return false;
    }

    const prefix = `codex_cli_rs/${evidence.runtimeVersion}`;
    const suffix = evidence.serverUserAgent.slice(prefix.length);
    if (
      !evidence.serverUserAgent.startsWith(prefix) ||
      (suffix.length > 0 && suffix[0] !== ' ' && suffix[0] !== '\t')
    ) {
      return false;
    }
    createCodexReturnTarget({ sessionId: evidence.requestedThreadKey });
    return true;
  } catch {
    return false;
  }
}

export interface ObservationCheckpoint {
  throughSequence: number;
  monitoring: MonitoringMode;
  observations: SanitizedAttentionObservation[];
}

export type ObservationExchange =
  | {
      kind: 'append';
      deliveryGeneration: string;
      scope: SourceScope;
      fromSequence: number;
      observations: SanitizedAttentionObservation[];
    }
  | {
      kind: 'reconcile';
      deliveryGeneration: string;
      scope: SourceScope;
      retainedRange: SequenceRange;
      checkpoint: ObservationCheckpoint;
      tail: SanitizedAttentionObservation[];
    };

export interface ExchangeReceipt {
  receivedThrough: number;
  appliedThrough?: number;
  replayFrom?: number;
  monitoring: MonitoringMode;
}

export type ObservationExchangeReceipt = ExchangeReceipt;

export interface PresentationRecord {
  key: string;
  revision: number;
  appearance: AttentionAppearance;
  canonicalTitle: string;
  canonicalBody: string;
  returnTarget: string;
}

export type PresentationMutation =
  | { kind: 'create'; record: PresentationRecord }
  | { kind: 'update'; record: PresentationRecord }
  | { kind: 'withdraw'; key: string };

export type PresentationExchange =
  | { kind: 'apply'; transactionId: string; mutations: PresentationMutation[] }
  | { kind: 'reconcile'; transactionId: string; records: PresentationRecord[] };

export type PresentationReceipt =
  | { kind: 'received'; transactionId: string }
  | { kind: 'applied'; transactionId: string }
  | { kind: 'replay'; transactionId: string }
  | {
      kind: 'rejected';
      transactionId: string;
      reason: 'invalid' | 'capacity' | 'conflict' | 'unavailable';
    };

export interface PresentationInteraction {
  kind: 'activate' | 'dismiss';
  key: string;
  revision: number;
}

export interface AttentionPresentationPort {
  exchange(input: PresentationExchange): Promise<PresentationReceipt>;
}

export interface CodexAttentionNormalization {
  exchange(input: ObservationExchange): Promise<ExchangeReceipt>;
}

export class AttentionExchangeValidationError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`Invalid attention exchange at ${path}: ${message}`);
    this.name = 'AttentionExchangeValidationError';
  }
}

const MONITORING_MODES = new Set<MonitoringMode>([
  'compatibility',
  'degraded',
  'exact',
  'unavailable',
]);
const APPEARANCES = new Set<AttentionAppearance>(['action', 'failure', 'information']);

export function parseObservationExchange(value: unknown): ObservationExchange {
  assertEnvelopeSize(value, 'observationExchange');
  const input = expectObject(value, 'observationExchange');
  const kind = expectString(input.kind, 'observationExchange.kind', 32);
  assertExactFields(
    input,
    kind === 'append'
      ? ['kind', 'deliveryGeneration', 'scope', 'fromSequence', 'observations']
      : kind === 'reconcile'
        ? ['kind', 'deliveryGeneration', 'scope', 'retainedRange', 'checkpoint', 'tail']
        : [],
    'observationExchange',
  );
  const deliveryGeneration = expectIdentifier(
    input.deliveryGeneration,
    'observationExchange.deliveryGeneration',
  );
  const scope = parseSourceScope(input.scope, 'observationExchange.scope');

  if (kind === 'append') {
    const fromSequence = expectSequence(input.fromSequence, 'observationExchange.fromSequence');
    const observations = parseObservations(input.observations, 'observationExchange.observations');
    assertContiguous(observations, fromSequence, 'observationExchange.observations');
    return { kind, deliveryGeneration, scope, fromSequence, observations };
  }

  if (kind !== 'reconcile') {
    fail('observationExchange.kind', 'must be append or reconcile');
  }
  const retainedRange = parseSequenceRange(
    input.retainedRange,
    'observationExchange.retainedRange',
  );
  const checkpoint = parseObservationCheckpoint(input.checkpoint, 'observationExchange.checkpoint');
  const tail = parseObservations(input.tail, 'observationExchange.tail');
  if (tail.length > 0) {
    assertContiguous(tail, checkpoint.throughSequence + 1, 'observationExchange.tail');
  }
  if (checkpoint.throughSequence > retainedRange.throughSequence) {
    fail('observationExchange.checkpoint.throughSequence', 'cannot exceed the retained range');
  }
  if (retainedRange.fromSequence > checkpoint.throughSequence + 1) {
    fail('observationExchange.retainedRange', 'must not leave a sequence gap after the checkpoint');
  }
  const reconciledThrough = tail.at(-1)?.sourceSequence ?? checkpoint.throughSequence;
  if (reconciledThrough !== retainedRange.throughSequence) {
    fail('observationExchange.tail', 'must end at retainedRange.throughSequence');
  }
  return { kind, deliveryGeneration, scope, retainedRange, checkpoint, tail };
}

export function parseObservationExchangeReceipt(value: unknown): ObservationExchangeReceipt {
  const input = expectObject(value, 'observationReceipt');
  assertExactFields(
    input,
    ['receivedThrough', 'appliedThrough', 'replayFrom', 'monitoring'],
    'observationReceipt',
    true,
  );
  const receivedThrough = expectCursor(input.receivedThrough, 'observationReceipt.receivedThrough');
  const monitoring = expectMonitoring(input.monitoring, 'observationReceipt.monitoring');
  const appliedThrough = optionalCursor(input.appliedThrough, 'observationReceipt.appliedThrough');
  const replayFrom = optionalSequence(input.replayFrom, 'observationReceipt.replayFrom');
  if (appliedThrough !== undefined && appliedThrough > receivedThrough) {
    fail('observationReceipt.appliedThrough', 'cannot exceed receivedThrough');
  }
  return compact({ receivedThrough, appliedThrough, replayFrom, monitoring });
}

export function parsePresentationExchange(value: unknown): PresentationExchange {
  assertEnvelopeSize(value, 'presentationExchange');
  const input = expectObject(value, 'presentationExchange');
  const kind = expectString(input.kind, 'presentationExchange.kind', 32);
  assertExactFields(
    input,
    kind === 'apply'
      ? ['kind', 'transactionId', 'mutations']
      : kind === 'reconcile'
        ? ['kind', 'transactionId', 'records']
        : [],
    'presentationExchange',
  );
  const transactionId = expectIdentifier(input.transactionId, 'presentationExchange.transactionId');
  if (kind === 'apply') {
    const values = expectArray(input.mutations, 'presentationExchange.mutations');
    expectArrayBound(
      values,
      ATTENTION_EXCHANGE_LIMITS.presentationRecords,
      'presentationExchange.mutations',
    );
    const mutations = values.map((mutation, index) =>
      parsePresentationMutation(mutation, `presentationExchange.mutations[${index}]`),
    );
    return { kind, transactionId, mutations };
  }
  if (kind !== 'reconcile') {
    fail('presentationExchange.kind', 'must be apply or reconcile');
  }
  const values = expectArray(input.records, 'presentationExchange.records');
  expectArrayBound(
    values,
    ATTENTION_EXCHANGE_LIMITS.presentationRecords,
    'presentationExchange.records',
  );
  const records = values.map((record, index) =>
    parsePresentationRecord(record, `presentationExchange.records[${index}]`),
  );
  assertUnique(
    records.map(({ key }) => key),
    'presentationExchange.records',
  );
  return { kind, transactionId, records };
}

export function parsePresentationReceipt(value: unknown): PresentationReceipt {
  const input = expectObject(value, 'presentationReceipt');
  const kind = expectString(input.kind, 'presentationReceipt.kind', 32);
  assertExactFields(
    input,
    kind === 'rejected' ? ['kind', 'transactionId', 'reason'] : ['kind', 'transactionId'],
    'presentationReceipt',
  );
  const transactionId = expectIdentifier(input.transactionId, 'presentationReceipt.transactionId');
  if (kind === 'received' || kind === 'applied' || kind === 'replay') {
    return { kind, transactionId };
  }
  if (kind !== 'rejected') {
    fail('presentationReceipt.kind', 'must be received, applied, replay, or rejected');
  }
  const reason = expectEnum(
    input.reason,
    ['capacity', 'conflict', 'invalid', 'unavailable'] as const,
    'presentationReceipt.reason',
  );
  return { kind, transactionId, reason };
}

export function parsePresentationInteraction(value: unknown): PresentationInteraction {
  const input = expectObject(value, 'presentationInteraction');
  assertExactFields(input, ['kind', 'key', 'revision'], 'presentationInteraction');
  const kind = expectEnum(
    input.kind,
    ['activate', 'dismiss'] as const,
    'presentationInteraction.kind',
  );
  return {
    kind,
    key: expectStableKey(input.key, 'presentationInteraction.key'),
    revision: expectRevision(input.revision, 'presentationInteraction.revision'),
  };
}

export function assertMatchingPresentationReceipt(
  exchange: PresentationExchange,
  receipt: PresentationReceipt,
): void {
  if (receipt.transactionId !== exchange.transactionId) {
    fail('presentationReceipt.transactionId', 'does not match the exchanged transaction');
  }
}

function parseSourceScope(value: unknown, path: string): SourceScope {
  const input = expectObject(value, path);
  assertExactFields(input, ['invocationId', 'connectionId', 'authorityEpoch'], path);
  return {
    invocationId: expectIdentifier(input.invocationId, `${path}.invocationId`),
    connectionId: expectIdentifier(input.connectionId, `${path}.connectionId`),
    authorityEpoch: expectIdentifier(input.authorityEpoch, `${path}.authorityEpoch`),
  };
}

function parseSequenceRange(value: unknown, path: string): SequenceRange {
  const input = expectObject(value, path);
  assertExactFields(input, ['fromSequence', 'throughSequence'], path);
  const fromSequence = expectSequence(input.fromSequence, `${path}.fromSequence`);
  const throughSequence = expectSequence(input.throughSequence, `${path}.throughSequence`);
  if (throughSequence < fromSequence) fail(path, 'must not be inverted');
  return { fromSequence, throughSequence };
}

function parseObservationCheckpoint(value: unknown, path: string): ObservationCheckpoint {
  const input = expectObject(value, path);
  assertExactFields(input, ['throughSequence', 'monitoring', 'observations'], path);
  const throughSequence = expectCursor(input.throughSequence, `${path}.throughSequence`);
  const observations = parseObservations(input.observations, `${path}.observations`);
  for (const [index, observation] of observations.entries()) {
    if (observation.sourceSequence > throughSequence) {
      fail(`${path}.observations[${index}].sourceSequence`, 'cannot exceed throughSequence');
    }
    if (index > 0 && observation.sourceSequence <= observations[index - 1].sourceSequence) {
      fail(`${path}.observations[${index}].sourceSequence`, 'must be strictly increasing');
    }
  }
  return {
    throughSequence,
    monitoring: expectMonitoring(input.monitoring, `${path}.monitoring`),
    observations,
  };
}

function parseObservations(value: unknown, path: string): SanitizedAttentionObservation[] {
  const values = expectArray(value, path);
  expectArrayBound(values, ATTENTION_EXCHANGE_LIMITS.observations, path);
  return values.map((observation, index) => parseObservation(observation, `${path}[${index}]`));
}

function parseObservation(value: unknown, path: string): SanitizedAttentionObservation {
  const input = expectObject(value, path);
  const kind = expectString(input.kind, `${path}.kind`, 64);
  const sourceSequence = expectSequence(input.sourceSequence, `${path}.sourceSequence`);
  switch (kind) {
    case 'connection-qualification':
      assertExactFields(
        input,
        [
          'kind',
          'sourceSequence',
          'initialized',
          'primary',
          'capabilities',
          'foregroundOwnership',
          'evidence',
        ],
        path,
      );
      return compact({
        kind,
        sourceSequence,
        initialized: expectBoolean(input.initialized, `${path}.initialized`),
        primary: expectBoolean(input.primary, `${path}.primary`),
        capabilities: expectEnum(
          input.capabilities,
          ['audited', 'unknown', 'unsupported'] as const,
          `${path}.capabilities`,
        ),
        foregroundOwnership: expectEnum(
          input.foregroundOwnership,
          ['confirmed', 'unconfirmed'] as const,
          `${path}.foregroundOwnership`,
        ),
        evidence:
          input.evidence === undefined
            ? undefined
            : parseConnectionQualificationEvidence(input.evidence, `${path}.evidence`),
      });
    case 'authority-change':
      assertExactFields(input, ['kind', 'sourceSequence', 'monitoring'], path);
      return {
        kind,
        sourceSequence,
        monitoring: expectMonitoring(input.monitoring, `${path}.monitoring`),
      };
    case 'turn-start':
      assertExactFields(input, ['kind', 'sourceSequence', 'turnKey', 'returnTarget'], path);
      return {
        kind,
        sourceSequence,
        turnKey: expectStableKey(input.turnKey, `${path}.turnKey`),
        returnTarget: expectReturnTarget(input.returnTarget, `${path}.returnTarget`),
      };
    case 'human-action-request':
      assertExactFields(
        input,
        [
          'kind',
          'sourceSequence',
          'turnKey',
          'requestKey',
          'requestKind',
          'canonicalTitle',
          'canonicalBody',
        ],
        path,
      );
      return compact({
        kind,
        sourceSequence,
        turnKey: expectStableKey(input.turnKey, `${path}.turnKey`),
        requestKey: expectStableKey(input.requestKey, `${path}.requestKey`),
        requestKind: expectEnum(
          input.requestKind,
          ['approval', 'elicitation', 'input', 'permission'] as const,
          `${path}.requestKind`,
        ),
        canonicalTitle: optionalCanonicalTitle(input.canonicalTitle, `${path}.canonicalTitle`),
        canonicalBody: optionalCanonicalBody(input.canonicalBody, `${path}.canonicalBody`),
      });
    case 'request-resolution':
      assertExactFields(input, ['kind', 'sourceSequence', 'turnKey', 'requestKey'], path);
      return {
        kind,
        sourceSequence,
        turnKey: expectStableKey(input.turnKey, `${path}.turnKey`),
        requestKey: expectStableKey(input.requestKey, `${path}.requestKey`),
      };
    case 'retry-error':
    case 'terminal-error':
      assertExactFields(
        input,
        ['kind', 'sourceSequence', 'turnKey', 'errorKind', 'canonicalBody'],
        path,
      );
      return compact({
        kind,
        sourceSequence,
        turnKey: expectStableKey(input.turnKey, `${path}.turnKey`),
        errorKind: expectIdentifier(input.errorKind, `${path}.errorKind`),
        canonicalBody: optionalCanonicalBody(input.canonicalBody, `${path}.canonicalBody`),
      });
    case 'terminal-result':
      assertExactFields(
        input,
        [
          'kind',
          'sourceSequence',
          'turnKey',
          'result',
          'occurrenceKey',
          'canonicalTitle',
          'canonicalBody',
        ],
        path,
      );
      return compact({
        kind,
        sourceSequence,
        turnKey: expectStableKey(input.turnKey, `${path}.turnKey`),
        result: expectEnum(input.result, ['failure', 'success'] as const, `${path}.result`),
        occurrenceKey: expectStableKey(input.occurrenceKey, `${path}.occurrenceKey`),
        canonicalTitle: optionalCanonicalTitle(input.canonicalTitle, `${path}.canonicalTitle`),
        canonicalBody: optionalCanonicalBody(input.canonicalBody, `${path}.canonicalBody`),
      });
    case 'interruption':
    case 'reconciliation-deadline':
      assertExactFields(input, ['kind', 'sourceSequence', 'turnKey'], path);
      return {
        kind,
        sourceSequence,
        turnKey: expectStableKey(input.turnKey, `${path}.turnKey`),
      };
    case 'invocation-end':
    case 'connection-end':
      assertExactFields(input, ['kind', 'sourceSequence', 'endKey'], path);
      return {
        kind,
        sourceSequence,
        endKey: expectStableKey(input.endKey, `${path}.endKey`),
      };
    case 'content-enrichment':
      assertExactFields(
        input,
        ['kind', 'sourceSequence', 'semanticKey', 'canonicalTitle', 'canonicalBody'],
        path,
      );
      return compact({
        kind,
        sourceSequence,
        semanticKey: expectStableKey(input.semanticKey, `${path}.semanticKey`),
        canonicalTitle: optionalCanonicalTitle(input.canonicalTitle, `${path}.canonicalTitle`),
        canonicalBody: optionalCanonicalBody(input.canonicalBody, `${path}.canonicalBody`),
      });
    default:
      return fail(`${path}.kind`, 'is not a source-neutral observation kind');
  }
}

function parseConnectionQualificationEvidence(
  value: unknown,
  path: string,
): ConnectionQualificationEvidence {
  const input = expectObject(value, path);
  assertExactFields(
    input,
    [
      'runtimeVersion',
      'clientName',
      'clientVersion',
      'experimentalApi',
      'optedOutNotifications',
      'serverUserAgent',
      'initializationRequestKey',
      'initializationResponseKey',
      'initializationAcknowledged',
      'foregroundRequestKind',
      'foregroundRequestKey',
      'foregroundResponseKey',
      'requestedThreadKey',
      'announcedThreadKey',
      'foregroundSessionKey',
      'foregroundSource',
      'foregroundParentKey',
    ],
    path,
  );
  const optedOut = expectArray(input.optedOutNotifications, `${path}.optedOutNotifications`);
  expectArrayBound(optedOut, 32, `${path}.optedOutNotifications`);
  return {
    runtimeVersion: expectIdentifier(input.runtimeVersion, `${path}.runtimeVersion`),
    clientName: expectIdentifier(input.clientName, `${path}.clientName`),
    clientVersion: expectIdentifier(input.clientVersion, `${path}.clientVersion`),
    experimentalApi: expectBoolean(input.experimentalApi, `${path}.experimentalApi`),
    optedOutNotifications: optedOut.map((entry, index) =>
      expectString(entry, `${path}.optedOutNotifications[${index}]`, 200),
    ),
    serverUserAgent: expectString(input.serverUserAgent, `${path}.serverUserAgent`, 4_096),
    initializationRequestKey: expectIdentifier(
      input.initializationRequestKey,
      `${path}.initializationRequestKey`,
    ),
    initializationResponseKey: expectIdentifier(
      input.initializationResponseKey,
      `${path}.initializationResponseKey`,
    ),
    initializationAcknowledged: expectBoolean(
      input.initializationAcknowledged,
      `${path}.initializationAcknowledged`,
    ),
    foregroundRequestKind: expectEnum(
      input.foregroundRequestKind,
      ['fork', 'resume', 'start'] as const,
      `${path}.foregroundRequestKind`,
    ),
    foregroundRequestKey: expectIdentifier(
      input.foregroundRequestKey,
      `${path}.foregroundRequestKey`,
    ),
    foregroundResponseKey: expectIdentifier(
      input.foregroundResponseKey,
      `${path}.foregroundResponseKey`,
    ),
    requestedThreadKey: expectIdentifier(input.requestedThreadKey, `${path}.requestedThreadKey`),
    announcedThreadKey: expectIdentifier(input.announcedThreadKey, `${path}.announcedThreadKey`),
    foregroundSessionKey: expectIdentifier(
      input.foregroundSessionKey,
      `${path}.foregroundSessionKey`,
    ),
    foregroundSource: expectEnum(
      input.foregroundSource,
      ['appServer', 'cli', 'custom', 'exec', 'subAgent', 'unknown', 'vscode'] as const,
      `${path}.foregroundSource`,
    ),
    foregroundParentKey:
      input.foregroundParentKey === null
        ? null
        : expectIdentifier(input.foregroundParentKey, `${path}.foregroundParentKey`),
  };
}

function parsePresentationMutation(value: unknown, path: string): PresentationMutation {
  const input = expectObject(value, path);
  const kind = expectString(input.kind, `${path}.kind`, 32);
  assertExactFields(input, kind === 'withdraw' ? ['kind', 'key'] : ['kind', 'record'], path);
  if (kind === 'create' || kind === 'update') {
    return { kind, record: parsePresentationRecord(input.record, `${path}.record`) };
  }
  if (kind === 'withdraw') {
    return { kind, key: expectStableKey(input.key, `${path}.key`) };
  }
  return fail(`${path}.kind`, 'must be create, update, or withdraw');
}

function parsePresentationRecord(value: unknown, path: string): PresentationRecord {
  const input = expectObject(value, path);
  assertExactFields(
    input,
    ['key', 'revision', 'appearance', 'canonicalTitle', 'canonicalBody', 'returnTarget'],
    path,
  );
  const appearance = expectString(input.appearance, `${path}.appearance`, 32);
  if (!APPEARANCES.has(appearance as AttentionAppearance)) {
    fail(`${path}.appearance`, 'must be information, action, or failure');
  }
  return {
    key: expectStableKey(input.key, `${path}.key`),
    revision: expectRevision(input.revision, `${path}.revision`),
    appearance: appearance as AttentionAppearance,
    canonicalTitle: expectCanonicalText(
      input.canonicalTitle,
      `${path}.canonicalTitle`,
      ATTENTION_EXCHANGE_LIMITS.canonicalTitleBytes,
    ),
    canonicalBody: expectCanonicalText(
      input.canonicalBody,
      `${path}.canonicalBody`,
      ATTENTION_EXCHANGE_LIMITS.canonicalBodyBytes,
    ),
    returnTarget: expectReturnTarget(input.returnTarget, `${path}.returnTarget`),
  };
}

function assertEnvelopeSize(value: unknown, path: string): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return fail(path, 'must be JSON serializable');
  }
  if (serialized === undefined) fail(path, 'must be JSON serializable');
  if (Buffer.byteLength(serialized, 'utf8') > ATTENTION_EXCHANGE_LIMITS.envelopeBytes) {
    fail(path, `exceeds ${ATTENTION_EXCHANGE_LIMITS.envelopeBytes} encoded bytes`);
  }
}

function assertContiguous(
  observations: SanitizedAttentionObservation[],
  fromSequence: number,
  path: string,
): void {
  for (const [index, observation] of observations.entries()) {
    if (observation.sourceSequence !== fromSequence + index) {
      fail(`${path}[${index}].sourceSequence`, 'must form a contiguous sequence');
    }
  }
}

function assertExactFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  allowOptional = false,
): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected !== undefined) fail(`${path}.${unexpected}`, 'is an unexpected field');
  if (!allowOptional && allowed.length === 0) fail(`${path}.kind`, 'is not recognized');
}

function assertUnique(values: string[], path: string): void {
  if (new Set(values).size !== values.length) fail(path, 'contains duplicate stable keys');
}

function expectObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail(path, 'must be an object');
  }
  return value as Record<string, unknown>;
}

function expectArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) return fail(path, 'must be an array');
  return value;
}

function expectArrayBound(value: unknown[], maximum: number, path: string): void {
  if (value.length > maximum) fail(path, `must contain at most ${maximum} entries`);
}

function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') return fail(path, 'must be a boolean');
  return value;
}

function expectString(value: unknown, path: string, maximumBytes: number): string {
  if (typeof value !== 'string' || value.length === 0)
    return fail(path, 'must be a non-empty string');
  if (Buffer.byteLength(value, 'utf8') > maximumBytes) {
    fail(path, `exceeds ${maximumBytes} encoded bytes`);
  }
  if (!hasOnlyUnicodeScalars(value)) fail(path, 'must contain only valid Unicode scalar values');
  return value;
}

function expectIdentifier(value: unknown, path: string): string {
  return expectString(value, path, ATTENTION_EXCHANGE_LIMITS.identifierBytes);
}

function expectStableKey(value: unknown, path: string): string {
  return expectString(value, path, ATTENTION_EXCHANGE_LIMITS.stableKeyBytes);
}

function expectReturnTarget(value: unknown, path: string): string {
  return expectString(value, path, ATTENTION_EXCHANGE_LIMITS.opaqueReturnTargetBytes);
}

function expectCanonicalText(value: unknown, path: string, maximumBytes: number): string {
  if (typeof value !== 'string' || value.length === 0) {
    return fail(path, 'must be a non-empty string');
  }
  if (Buffer.byteLength(value, 'utf8') > maximumBytes) {
    fail(path, `exceeds ${maximumBytes} encoded bytes`);
  }
  return value;
}

function optionalCanonicalTitle(value: unknown, path: string): string | undefined {
  return value === undefined
    ? undefined
    : expectCanonicalText(value, path, ATTENTION_EXCHANGE_LIMITS.canonicalTitleBytes);
}

function optionalCanonicalBody(value: unknown, path: string): string | undefined {
  return value === undefined
    ? undefined
    : expectCanonicalText(value, path, ATTENTION_EXCHANGE_LIMITS.canonicalBodyBytes);
}

function expectSequence(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    return fail(path, 'must be a positive safe integer');
  }
  return value as number;
}

function expectCursor(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return fail(path, 'must be a non-negative safe integer');
  }
  return value as number;
}

function optionalCursor(value: unknown, path: string): number | undefined {
  return value === undefined ? undefined : expectCursor(value, path);
}

function optionalSequence(value: unknown, path: string): number | undefined {
  return value === undefined ? undefined : expectSequence(value, path);
}

function expectRevision(value: unknown, path: string): number {
  return expectSequence(value, path);
}

function expectMonitoring(value: unknown, path: string): MonitoringMode {
  const result = expectString(value, path, 32) as MonitoringMode;
  if (!MONITORING_MODES.has(result)) {
    return fail(path, 'must be exact, compatibility, unavailable, or degraded');
  }
  return result;
}

function expectEnum<const T extends readonly string[]>(
  value: unknown,
  choices: T,
  path: string,
): T[number] {
  const result = expectString(value, path, 64);
  if (!choices.includes(result)) return fail(path, `must be one of ${choices.join(', ')}`);
  return result as T[number];
}

function hasOnlyUnicodeScalars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function fail(path: string, message: string): never {
  throw new AttentionExchangeValidationError(path, message);
}
