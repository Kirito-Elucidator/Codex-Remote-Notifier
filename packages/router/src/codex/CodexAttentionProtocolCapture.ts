import type {
  SanitizedAttentionObservation,
  SourceScope,
} from 'remote-notifier-shared/attentionExchange';
import { ATTENTION_EXCHANGE_LIMITS } from 'remote-notifier-shared/attentionExchange';
import { createCodexReturnTarget } from 'remote-notifier-shared/codexReturnTarget';

import { isAuditedCodexProtocolVersion } from './CodexShimArguments';

const MAXIMUM_PROTOCOL_MESSAGE_BYTES = 16 * 1024 * 1024;

export interface CodexAttentionProtocolCaptureOptions extends SourceScope {
  primary: boolean;
  version: string;
}

export class CodexAttentionProtocolCapture {
  private activeTurnId?: string;
  private boundForegroundThreadId?: string;
  private foregroundThreadCandidateId?: string;
  private foregroundThreadId?: string;
  private initializeRequestId?: string;
  private initialized = false;
  private readonly pendingThreadRequests = new Set<string>();
  private pendingTurnId?: string;
  private qualified = false;
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
    if (!this.eligible || message === undefined || !validRequestId(message.id)) return [];
    if (message.method === 'initialize') {
      this.initializeRequestId = requestIdKey(message.id);
      return [];
    }
    if (isForegroundThreadRequest(message.method)) {
      this.rememberThreadRequest(requestIdKey(message.id));
    }
    return [];
  }

  observeServerText(text: string): SanitizedAttentionObservation[] {
    const message = parseMessage(text);
    if (!this.eligible || message === undefined) return [];

    const observations: SanitizedAttentionObservation[] = [];
    if (
      this.initializeRequestId !== undefined &&
      requestIdKey(message.id) === this.initializeRequestId &&
      isRecord(message.result) &&
      message.error === undefined
    ) {
      this.initialized = true;
      observations.push(...this.qualify());
      observations.push(...this.emitPendingTurn());
      return observations;
    }

    const responseId = requestIdKey(message.id);
    if (responseId !== undefined && this.pendingThreadRequests.delete(responseId)) {
      const threadId = responseThreadId(message.result);
      if (threadId !== undefined) this.boundForegroundThreadId = threadId;
      this.bindForegroundCandidate();
      observations.push(...this.qualify());
      observations.push(...this.emitPendingTurn());
      return observations;
    }

    if (message.method === 'thread/started') {
      const params = isRecord(message.params) ? message.params : undefined;
      const thread = params && isRecord(params.thread) ? params.thread : undefined;
      const threadId = thread && boundedIdentifier(thread.id);
      if (!threadId || !isForegroundThread(thread)) return [];
      this.foregroundThreadCandidateId = threadId;
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
        this.pendingTurnId = turnId;
        return [];
      }
      this.activeTurnId = turnId;
      return [this.turnStart(turnId)];
    }

    if (message.method === 'turn/completed') {
      return this.captureSuccess(message);
    }
    return [];
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
      turnId !== this.activeTurnId ||
      turn?.status !== 'completed'
    ) {
      return [];
    }

    this.activeTurnId = undefined;
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
    if (!this.qualified || this.pendingTurnId === undefined) return [];
    const turnId = this.pendingTurnId;
    this.pendingTurnId = undefined;
    this.activeTurnId = turnId;
    return [this.turnStart(turnId)];
  }

  private bindForegroundCandidate(): void {
    if (
      this.boundForegroundThreadId !== undefined &&
      this.boundForegroundThreadId === this.foregroundThreadCandidateId
    ) {
      this.foregroundThreadId = this.boundForegroundThreadId;
    }
  }

  private get eligible(): boolean {
    return this.options.primary && isAuditedCodexProtocolVersion(this.options.version);
  }

  private nextSequence(): number {
    return ++this.sourceSequence;
  }

  private rememberThreadRequest(requestId: string | undefined): void {
    if (requestId === undefined) return;
    this.pendingThreadRequests.add(requestId);
    while (this.pendingThreadRequests.size > 32) {
      const oldest = this.pendingThreadRequests.values().next().value;
      if (oldest === undefined) break;
      this.pendingThreadRequests.delete(oldest);
    }
  }

  private qualify(): SanitizedAttentionObservation[] {
    if (this.qualified || !this.initialized || this.foregroundThreadId === undefined) return [];
    this.qualified = true;
    return [
      {
        kind: 'connection-qualification',
        sourceSequence: this.nextSequence(),
        initialized: true,
        primary: true,
        capabilities: 'audited',
        foregroundOwnership: 'confirmed',
      },
    ];
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
  return typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : undefined;
}

function isForegroundThread(thread: Record<string, unknown>): boolean {
  if (thread.parentThreadId !== undefined && thread.parentThreadId !== null) return false;
  if (thread.parent_thread_id !== undefined && thread.parent_thread_id !== null) return false;
  const source = thread.source;
  if (source === 'subAgent') return false;
  return !(isRecord(source) && (source.subAgent === true || source.sub_agent === true));
}

function isForegroundThreadRequest(method: unknown): boolean {
  return method === 'thread/fork' || method === 'thread/resume' || method === 'thread/start';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  if (isRecord(value.thread)) return boundedIdentifier(value.thread.id);
  return boundedIdentifier(value.threadId) ?? boundedIdentifier(value.thread_id);
}

function successPreview(items: unknown): string | undefined {
  if (!Array.isArray(items)) return undefined;
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (!isRecord(item) || (item.type !== 'agentMessage' && item.type !== 'plan')) continue;
    if (typeof item.text !== 'string' || item.text.trim().length === 0) continue;
    return boundCanonicalUtf8(item.text, ATTENTION_EXCHANGE_LIMITS.canonicalBodyBytes);
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
    (typeof value === 'string' && value.length > 0 && value.length <= 200)
  );
}
