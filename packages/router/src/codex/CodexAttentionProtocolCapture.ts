import type {
  ConnectionQualificationEvidence,
  SanitizedAttentionObservation,
  SourceScope,
} from 'remote-notifier-shared/attentionExchange';
import {
  ATTENTION_EXCHANGE_LIMITS,
  hasOnlyUnicodeScalars,
  isExactConnectionQualification,
} from 'remote-notifier-shared/attentionExchange';
import { createCodexReturnTarget } from 'remote-notifier-shared/codexReturnTarget';

import { isAuditedCodexProtocolVersion, parseCodexProtocolVersion } from './CodexShimArguments';

const MAXIMUM_PROTOCOL_MESSAGE_BYTES = 16 * 1024 * 1024;

export interface CodexAttentionProtocolCaptureOptions extends SourceScope {
  primary: boolean;
  version: string;
}

type ForegroundRequestKind = ConnectionQualificationEvidence['foregroundRequestKind'];
type ForegroundSource = ConnectionQualificationEvidence['foregroundSource'];

interface AuditedThread {
  id: string;
  sessionId: string;
  source: ForegroundSource;
  parentId: string | null;
}

interface ForegroundThreadCandidate extends AuditedThread {
  requestKeys: ReadonlySet<string>;
}

interface BoundedInitialization {
  clientName: string;
  clientVersion: string;
  experimentalApi: boolean;
  optedOutNotifications: string[];
}

interface BoundForegroundThread {
  id: string;
  requestKey: string;
  requestKind: ForegroundRequestKind;
}

export class CodexAttentionProtocolCapture {
  private readonly activeTurnIds = new Set<string>();
  private boundForegroundThread?: BoundForegroundThread;
  private foregroundThreadCandidate?: ForegroundThreadCandidate;
  private foregroundThreadId?: string;
  private initialization?: BoundedInitialization;
  private initializeRequestId?: string;
  private initializeResponseId?: string;
  private initializeResponseValidated = false;
  private initialized = false;
  private readonly pendingThreadRequests = new Map<string, ForegroundRequestKind>();
  private readonly pendingTurnIds = new Set<string>();
  private qualificationEvidence?: ConnectionQualificationEvidence;
  private qualified = false;
  private authorityClosed = false;
  private serverUserAgent?: string;
  private sourceSequence = 0;

  readonly scope: SourceScope;

  constructor(private readonly options: CodexAttentionProtocolCaptureOptions) {
    this.scope = {
      invocationId: options.invocationId,
      connectionId: options.connectionId,
      authorityEpoch: options.authorityEpoch,
    };
  }

  observeClientText(text: string): SanitizedAttentionObservation[] {
    const message = parseMessage(text);
    if (!this.eligible || message === undefined) return [];
    if (isInitializedNotification(message)) {
      if (!this.initializeResponseValidated || this.initialized) return [];
      this.initialized = true;
      return [...this.qualify(), ...this.emitPendingTurn()];
    }
    if (!validRequestId(message.id)) return [];
    if (message.method === 'initialize') {
      if (this.initializeRequestId !== undefined || this.initialized) return [];
      this.initialization = boundedInitialization(message.params);
      this.initializeRequestId =
        this.initialization === undefined ? undefined : requestIdKey(message.id);
      return [];
    }
    const requestKind = foregroundRequestKind(message.method);
    if (this.initialized && requestKind !== undefined) {
      this.rememberThreadRequest(requestIdKey(message.id), requestKind);
    }
    return [];
  }

  observeServerText(text: string): SanitizedAttentionObservation[] {
    const message = parseMessage(text);
    if (!this.eligible || message === undefined) return [];

    const request = this.captureHumanActionRequest(message);
    if (request !== undefined) return [request];

    const observations: SanitizedAttentionObservation[] = [];
    const responseKey = requestIdKey(message.id);
    const userAgent = isSuccessfulResponse(message)
      ? boundedServerUserAgent(message.result)
      : undefined;
    if (
      !this.initializeResponseValidated &&
      this.initializeRequestId !== undefined &&
      responseKey === this.initializeRequestId &&
      userAgent !== undefined
    ) {
      this.initializeResponseId = responseKey;
      this.initializeResponseValidated = true;
      this.serverUserAgent = userAgent;
      this.bindForegroundCandidate();
      observations.push(...this.qualify());
      observations.push(...this.emitPendingTurn());
      return observations;
    }

    if (responseKey !== undefined && this.pendingThreadRequests.has(responseKey)) {
      const requestKind = this.pendingThreadRequests.get(responseKey);
      this.pendingThreadRequests.delete(responseKey);
      const threadId = isSuccessfulResponse(message) ? responseThreadId(message.result) : undefined;
      if (threadId !== undefined && requestKind !== undefined) {
        this.boundForegroundThread = { id: threadId, requestKey: responseKey, requestKind };
      }
      if (
        this.foregroundThreadCandidate?.requestKeys.has(responseKey) &&
        this.foregroundThreadCandidate.id !== threadId
      ) {
        const requestKeys = new Set(this.foregroundThreadCandidate.requestKeys);
        requestKeys.delete(responseKey);
        this.foregroundThreadCandidate =
          requestKeys.size === 0 ? undefined : { ...this.foregroundThreadCandidate, requestKeys };
      }
      this.bindForegroundCandidate();
      observations.push(...this.qualify());
      observations.push(...this.emitPendingTurn());
      return observations;
    }

    if (message.method === 'thread/started') {
      const params = isRecord(message.params) ? message.params : undefined;
      const thread = params && isRecord(params.thread) ? params.thread : undefined;
      const candidate = thread && auditedThread(thread);
      if (!this.initialized || candidate === undefined) return [];
      const requestKeys = new Set(this.pendingThreadRequests.keys());
      if (this.boundForegroundThread?.id === candidate.id) {
        requestKeys.add(this.boundForegroundThread.requestKey);
      }
      if (requestKeys.size === 0) return [];
      if (candidate.parentId !== null || candidate.source === 'subAgent') return [];
      this.foregroundThreadCandidate = { ...candidate, requestKeys };
      this.bindForegroundCandidate();
      observations.push(...this.qualify());
      observations.push(...this.emitPendingTurn());
      return observations;
    }

    if (message.method === 'turn/started') {
      const params = isRecord(message.params) ? message.params : undefined;
      const turn = params && isRecord(params.turn) ? params.turn : undefined;
      const threadId = params && boundedIdentifier(params.threadId);
      const turnId = turn && boundedIdentifier(turn.id);
      if (!threadId || !turnId || threadId !== this.foregroundThreadId) return [];
      if (!this.qualified) {
        this.pendingTurnIds.add(turnId);
        return [];
      }
      if (this.activeTurnIds.has(turnId)) return [];
      this.activeTurnIds.add(turnId);
      return [this.turnStart(turnId)];
    }

    if (message.method === 'turn/completed') {
      return this.captureSuccess(message);
    }
    return [];
  }

  authorityLost(
    monitoring: 'compatibility' | 'degraded' | 'unavailable',
  ): SanitizedAttentionObservation[] {
    if (!this.qualified || this.authorityClosed) return [];
    this.authorityClosed = true;
    this.qualified = false;
    this.pendingTurnIds.clear();
    return [{ kind: 'authority-change', sourceSequence: this.nextSequence(), monitoring }];
  }

  private captureHumanActionRequest(
    message: Record<string, unknown>,
  ): Extract<SanitizedAttentionObservation, { kind: 'human-action-request' }> | undefined {
    if (!this.qualified) return undefined;
    const requestKind = attentionRequestKind(message.method);
    const requestKey = requestIdKey(message.id);
    const params = isRecord(message.params) ? message.params : undefined;
    const threadId = params && boundedIdentifier(params.threadId);
    const turnId = params && boundedIdentifier(params.turnId);
    if (
      requestKind === undefined ||
      requestKey === undefined ||
      threadId !== this.foregroundThreadId ||
      turnId === undefined ||
      !this.activeTurnIds.has(turnId)
    ) {
      return undefined;
    }
    return {
      kind: 'human-action-request',
      sourceSequence: this.nextSequence(),
      turnKey: turnId,
      requestKey,
      requestKind,
    };
  }

  private captureSuccess(message: Record<string, unknown>): SanitizedAttentionObservation[] {
    if (!this.qualified) return [];
    const params = isRecord(message.params) ? message.params : undefined;
    const turn = params && isRecord(params.turn) ? params.turn : undefined;
    const threadId = params && boundedIdentifier(params.threadId);
    const turnId = turn && boundedIdentifier(turn.id);
    if (
      !threadId ||
      !turnId ||
      threadId !== this.foregroundThreadId ||
      !this.activeTurnIds.has(turnId) ||
      turn?.status !== 'completed'
    ) {
      return [];
    }

    this.activeTurnIds.delete(turnId);
    const preview = successPreview(turn.items);
    return [
      {
        kind: 'terminal-result',
        sourceSequence: this.nextSequence(),
        turnKey: turnId,
        result: 'success',
        occurrenceKey: `${turnId}:success`,
        canonicalTitle: 'Codex completed',
        ...(preview === undefined ? {} : { canonicalBody: preview }),
      },
    ];
  }

  private emitPendingTurn(): SanitizedAttentionObservation[] {
    if (!this.qualified || this.pendingTurnIds.size === 0) return [];
    const observations: SanitizedAttentionObservation[] = [];
    for (const turnId of this.pendingTurnIds) {
      if (this.activeTurnIds.has(turnId)) continue;
      this.activeTurnIds.add(turnId);
      observations.push(this.turnStart(turnId));
    }
    this.pendingTurnIds.clear();
    return observations;
  }

  private bindForegroundCandidate(): void {
    if (this.qualified) return;
    const bound = this.boundForegroundThread;
    const candidate = this.foregroundThreadCandidate;
    const runtimeVersion = parseCodexProtocolVersion(this.options.version);
    if (
      bound === undefined ||
      candidate === undefined ||
      bound.id !== candidate.id ||
      !candidate.requestKeys.has(bound.requestKey) ||
      runtimeVersion === undefined ||
      this.initialization === undefined ||
      this.initializeRequestId === undefined ||
      this.initializeResponseId === undefined ||
      this.serverUserAgent === undefined
    )
      return;
    this.foregroundThreadId = bound.id;
    this.qualificationEvidence = {
      runtimeVersion,
      clientName: this.initialization.clientName,
      clientVersion: this.initialization.clientVersion,
      experimentalApi: this.initialization.experimentalApi,
      optedOutNotifications: this.initialization.optedOutNotifications,
      serverUserAgent: this.serverUserAgent,
      initializationRequestKey: this.initializeRequestId,
      initializationResponseKey: this.initializeResponseId,
      initializationAcknowledged: this.initialized,
      foregroundRequestKind: bound.requestKind,
      foregroundRequestKey: bound.requestKey,
      foregroundResponseKey: bound.requestKey,
      requestedThreadKey: bound.id,
      announcedThreadKey: candidate.id,
      foregroundSessionKey: candidate.sessionId,
      foregroundSource: candidate.source,
      foregroundParentKey: candidate.parentId,
    };
  }

  private get eligible(): boolean {
    return this.options.primary && isAuditedCodexProtocolVersion(this.options.version);
  }

  private nextSequence(): number {
    return ++this.sourceSequence;
  }

  private rememberThreadRequest(
    requestId: string | undefined,
    requestKind: ForegroundRequestKind,
  ): void {
    if (requestId === undefined) return;
    this.pendingThreadRequests.set(requestId, requestKind);
    while (this.pendingThreadRequests.size > 32) {
      const oldest = this.pendingThreadRequests.keys().next().value;
      if (oldest === undefined) break;
      this.pendingThreadRequests.delete(oldest);
    }
  }

  private qualify(): SanitizedAttentionObservation[] {
    if (
      this.authorityClosed ||
      this.qualified ||
      !this.initialized ||
      this.foregroundThreadId === undefined ||
      this.qualificationEvidence === undefined
    )
      return [];
    const evidence = { ...this.qualificationEvidence, initializationAcknowledged: true };
    const qualification: Extract<
      SanitizedAttentionObservation,
      { kind: 'connection-qualification' }
    > = {
      kind: 'connection-qualification',
      sourceSequence: this.sourceSequence + 1,
      initialized: true,
      primary: true,
      capabilities: 'audited',
      foregroundOwnership: 'confirmed',
      evidence,
    };
    if (!isExactConnectionQualification(qualification)) return [];
    this.qualificationEvidence = evidence;
    this.qualified = true;
    this.nextSequence();
    return [qualification];
  }

  private turnStart(turnId: string): SanitizedAttentionObservation {
    const sessionId = this.foregroundThreadId;
    if (sessionId === undefined) throw new Error('foreground thread is not established');
    return {
      kind: 'turn-start',
      sourceSequence: this.nextSequence(),
      turnKey: turnId,
      returnTarget: createCodexReturnTarget({ sessionId }),
    };
  }
}

function boundedIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length > 0 &&
    hasOnlyUnicodeScalars(value) &&
    Buffer.byteLength(value, 'utf8') <= 200
    ? value
    : undefined;
}

function foregroundRequestKind(method: unknown): ForegroundRequestKind | undefined {
  if (method === 'thread/fork') return 'fork';
  if (method === 'thread/resume') return 'resume';
  if (method === 'thread/start') return 'start';
  return undefined;
}

function attentionRequestKind(
  method: unknown,
):
  | Extract<SanitizedAttentionObservation, { kind: 'human-action-request' }>['requestKind']
  | undefined {
  switch (method) {
    case 'item/tool/requestUserInput':
      return 'input';
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return 'approval';
    case 'item/permissions/requestApproval':
      return 'permission';
    case 'mcpServer/elicitation/request':
      return 'elicitation';
    default:
      return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInitializedNotification(message: Record<string, unknown>): boolean {
  if (message.method !== 'initialized') return false;
  const keys = Object.keys(message);
  if (keys.some((key) => key !== 'method' && key !== 'params')) return false;
  return (
    message.params === undefined ||
    message.params === null ||
    (isRecord(message.params) && Object.keys(message.params).length === 0)
  );
}

function isSuccessfulResponse(message: Record<string, unknown>): boolean {
  const keys = Object.keys(message);
  return (
    keys.length === 2 &&
    keys.includes('id') &&
    keys.includes('result') &&
    !Object.prototype.hasOwnProperty.call(message, 'error')
  );
}

function boundedInitialization(value: unknown): BoundedInitialization | undefined {
  if (!isRecord(value) || !isRecord(value.clientInfo) || !isRecord(value.capabilities))
    return undefined;
  const clientName = boundedIdentifier(value.clientInfo.name);
  const clientVersion = boundedIdentifier(value.clientInfo.version);
  const experimentalApi = value.capabilities.experimentalApi;
  if (!clientName || !clientVersion || typeof experimentalApi !== 'boolean') return undefined;
  const parsedClientVersion = parseCodexProtocolVersion(clientVersion);
  if (parsedClientVersion === undefined) return undefined;
  const optedOut = value.capabilities.optOutNotificationMethods;
  if (optedOut !== undefined && optedOut !== null) {
    if (!Array.isArray(optedOut) || optedOut.length > 32) return undefined;
    const boundedOptedOut: string[] = [];
    for (const entry of optedOut) {
      const method = boundedOptOutNotification(entry);
      if (method === undefined) return undefined;
      boundedOptedOut.push(method);
    }
    return {
      clientName,
      clientVersion: parsedClientVersion,
      experimentalApi,
      optedOutNotifications: boundedOptedOut,
    };
  }
  return {
    clientName,
    clientVersion: parsedClientVersion,
    experimentalApi,
    optedOutNotifications: [],
  };
}

function boundedServerUserAgent(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const userAgent = boundedProtocolText(value.userAgent);
  const codexHome = boundedProtocolText(value.codexHome);
  const platformFamily = boundedProtocolText(value.platformFamily);
  const platformOs = boundedProtocolText(value.platformOs);
  if (!userAgent || !codexHome || !platformFamily || !platformOs) return undefined;
  if (!isAbsoluteProtocolPath(codexHome)) return undefined;
  return userAgent;
}

function boundedProtocolText(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length > 0 &&
    hasOnlyUnicodeScalars(value) &&
    Buffer.byteLength(value, 'utf8') <= 4_096
    ? value
    : undefined;
}

function boundedOptOutNotification(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length > 0 &&
    hasOnlyUnicodeScalars(value) &&
    Buffer.byteLength(value, 'utf8') <= 200
    ? value
    : undefined;
}

function isAbsoluteProtocolPath(value: string): boolean {
  return value.startsWith('/') || value.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(value);
}

function auditedThread(thread: Record<string, unknown>): AuditedThread | undefined {
  const id = returnSessionIdentifier(thread.id);
  const sessionId = boundedIdentifier(thread.sessionId);
  const source = foregroundSource(thread.source);
  const parentId = thread.parentThreadId;
  if (!id || !sessionId || source === undefined) return undefined;
  const normalizedParentId =
    parentId === undefined || parentId === null ? null : boundedIdentifier(parentId);
  if (normalizedParentId === undefined) return undefined;
  return { id, sessionId, source, parentId: normalizedParentId };
}

function foregroundSource(value: unknown): ForegroundSource | undefined {
  if (
    typeof value === 'string' &&
    ['appServer', 'cli', 'exec', 'unknown', 'vscode'].includes(value)
  ) {
    return value as ForegroundSource;
  }
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== 1) return undefined;
  if (keys[0] === 'custom' && boundedIdentifier(value.custom) !== undefined) return 'custom';
  if (keys[0] === 'subAgent' && isRecord(value.subAgent)) return 'subAgent';
  return undefined;
}

function parseMessage(text: string): Record<string, unknown> | undefined {
  if (Buffer.byteLength(text, 'utf8') > MAXIMUM_PROTOCOL_MESSAGE_BYTES) return undefined;
  try {
    const message: unknown = JSON.parse(text);
    return isRecord(message) ? message : undefined;
  } catch {
    return undefined;
  }
}

function requestIdKey(value: unknown): string | undefined {
  return validRequestId(value) ? `${typeof value}:${String(value)}` : undefined;
}

function responseThreadId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (isRecord(value.thread)) return returnSessionIdentifier(value.thread.id);
  return undefined;
}

function returnSessionIdentifier(value: unknown): string | undefined {
  const identifier = boundedIdentifier(value);
  if (identifier === undefined) return undefined;
  try {
    createCodexReturnTarget({ sessionId: identifier });
    return identifier;
  } catch {
    return undefined;
  }
}

function successPreview(items: unknown): string | undefined {
  if (!Array.isArray(items)) return undefined;
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (!isRecord(item) || (item.type !== 'agentMessage' && item.type !== 'plan')) continue;
    if (typeof item.text !== 'string' || item.text.trim().length === 0) continue;
    const preview = boundCanonicalUtf8(item.text, ATTENTION_EXCHANGE_LIMITS.canonicalBodyBytes);
    return preview.length > 0 ? preview : undefined;
  }
  return undefined;
}

function boundCanonicalUtf8(value: string, maximumBytes: number): string {
  let bytes = 0;
  let result = '';
  for (const scalar of value) {
    const codePoint = scalar.codePointAt(0);
    if (
      codePoint === undefined ||
      (scalar.length === 1 && codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      continue;
    }
    const scalarBytes = Buffer.byteLength(scalar, 'utf8');
    if (bytes + scalarBytes > maximumBytes) break;
    result += scalar;
    bytes += scalarBytes;
  }
  return result;
}

function validRequestId(value: unknown): value is number | string {
  return (
    (typeof value === 'number' && Number.isSafeInteger(value)) ||
    (typeof value === 'string' &&
      value.length > 0 &&
      hasOnlyUnicodeScalars(value) &&
      Buffer.byteLength(value, 'utf8') <= 200)
  );
}
