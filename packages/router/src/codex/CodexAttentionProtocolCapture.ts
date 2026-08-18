import type {
  SanitizedAttentionObservation,
  SourceScope,
} from 'remote-notifier-shared/attentionExchange';
import { createCodexReturnTarget } from 'remote-notifier-shared/codexReturnTarget';

import { truncateCanonicalText } from './CodexMetadataResolver';
import { isAuditedCodexProtocolVersion } from './CodexShimArguments';

const MAXIMUM_PROTOCOL_MESSAGE_BYTES = 16 * 1024 * 1024;
const MAXIMUM_PREVIEW_LENGTH = 4_000;

export interface CodexAttentionProtocolCaptureOptions extends SourceScope {
  primary: boolean;
  version: string;
}

export class CodexAttentionProtocolCapture {
  private activeTurnId?: string;
  private foregroundThreadId?: string;
  private initializeRequestId?: string;
  private initialized = false;
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
    if (
      !this.eligible ||
      message === undefined ||
      message.method !== 'initialize' ||
      !validRequestId(message.id)
    ) {
      return [];
    }
    this.initializeRequestId = requestIdKey(message.id);
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

    if (message.method === 'thread/started') {
      const params = isRecord(message.params) ? message.params : undefined;
      const thread = params && isRecord(params.thread) ? params.thread : undefined;
      const threadId = thread && boundedIdentifier(thread.id);
      if (!threadId || !isForegroundThread(thread)) return [];
      this.foregroundThreadId = threadId;
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

  private get eligible(): boolean {
    return this.options.primary && isAuditedCodexProtocolVersion(this.options.version);
  }

  private nextSequence(): number {
    return ++this.sourceSequence;
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
    return {
      kind: 'turn-start',
      sourceSequence: this.nextSequence(),
      turnKey: turnId,
      returnTarget: createCodexReturnTarget({ sessionId: this.options.invocationId }),
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

function successPreview(items: unknown): string | undefined {
  if (!Array.isArray(items)) return undefined;
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (!isRecord(item) || (item.type !== 'agentMessage' && item.type !== 'plan')) continue;
    if (typeof item.text !== 'string' || item.text.trim().length === 0) continue;
    return truncateCanonicalText(item.text, MAXIMUM_PREVIEW_LENGTH);
  }
  return undefined;
}

function validRequestId(value: unknown): value is number | string {
  return (
    (typeof value === 'number' && Number.isSafeInteger(value)) ||
    (typeof value === 'string' && value.length > 0 && value.length <= 200)
  );
}
