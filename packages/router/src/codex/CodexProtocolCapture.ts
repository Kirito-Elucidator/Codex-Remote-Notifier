import type {
  CodexProtocolError,
  CodexProtocolEvent,
  CodexProtocolRequestMethod,
} from 'remote-notifier-shared';

import { CODEX_PROTOCOL_REQUEST_METHODS } from './CodexEventValidation';
import { normalizeProtocolError, truncateCanonicalText } from './CodexMetadataResolver';

const MAX_PROTOCOL_LINE_LENGTH = 128 * 1024 * 1024;
const MAX_CAPTURE_JSON_LENGTH = 16 * 1024 * 1024;
const MAX_PREVIEW_LENGTH = 4000;
const MAX_ERROR_LENGTH = 1000;
const MAX_PENDING_REQUESTS = 2048;

interface RequestContext {
  threadId?: string;
  turnId?: string;
}

export class JsonLineFramer {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  private pending = '';

  push(chunk: Buffer | string): string[] {
    try {
      this.pending +=
        typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    } catch (error) {
      throw new Error('Codex app-server emitted malformed UTF-8', { cause: error });
    }
    if (this.pending.length > MAX_PROTOCOL_LINE_LENGTH) {
      throw new Error('Codex app-server emitted an oversized JSONL frame');
    }

    const lines: string[] = [];
    let newline: number;
    while ((newline = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, newline).replace(/\r$/, '');
      this.pending = this.pending.slice(newline + 1);
      if (line) lines.push(line);
    }
    return lines;
  }

  end(): string[] {
    try {
      this.pending += this.decoder.decode();
    } catch (error) {
      throw new Error('Codex app-server ended with malformed UTF-8', { cause: error });
    }
    if (!this.pending) return [];
    const line = this.pending.replace(/\r$/, '');
    this.pending = '';
    return line ? [line] : [];
  }
}

export class CodexProtocolCapture {
  private readonly pendingRequests = new Map<string, RequestContext>();
  private readonly descendantThreadIds = new Set<string>();
  private activeThreadId?: string;
  private activeTurnId?: string;
  private errorOccurrenceSequence = 0;

  constructor(
    private readonly instanceId: string,
    private readonly processAncestry: number[],
  ) {}

  get threadEstablished(): boolean {
    return this.activeThreadId !== undefined;
  }

  observeServerText(text: string): CodexProtocolEvent[] {
    const message = parseJsonObject(text);
    return message ? this.observeServerMessage(message) : [];
  }

  observeClientText(text: string): CodexProtocolEvent[] {
    const message = parseJsonObject(text);
    return message ? this.observeClientMessage(message) : [];
  }

  observeServerMessage(message: Record<string, unknown>): CodexProtocolEvent[] {
    const method = typeof message.method === 'string' ? message.method : undefined;
    const params = isRecord(message.params) ? message.params : {};
    if (!method) return [];

    if (CODEX_PROTOCOL_REQUEST_METHODS.has(method as CodexProtocolRequestMethod)) {
      const requestId = validRequestId(message.id);
      const requestMethod = method as CodexProtocolRequestMethod;
      const threadId =
        readString(params.threadId) ?? readString(params.conversationId) ?? this.activeThreadId;
      if (
        requestId === undefined ||
        (threadId !== undefined && this.descendantThreadIds.has(threadId)) ||
        (!threadId && requestMethod !== 'mcpServer/elicitation/request')
      ) {
        return [];
      }
      const turnId = readString(params.turnId) ?? this.activeTurnId;
      this.rememberRequest(requestKey(requestId), {
        ...(threadId ? { threadId } : {}),
        ...(turnId ? { turnId } : {}),
      });
      return [
        this.event(requestMethod, {
          ...(threadId ? { thread_id: threadId } : {}),
          ...(turnId ? { turn_id: turnId } : {}),
          request_id: requestId,
        }),
      ];
    }

    switch (method) {
      case 'thread/started': {
        if (!isRecord(params.thread)) return [];
        const threadId = readString(params.thread.id);
        if (!threadId) return [];
        if (isDescendantThread(params.thread)) {
          this.descendantThreadIds.add(threadId);
          if (this.activeThreadId === threadId) {
            this.activeThreadId = undefined;
            this.activeTurnId = undefined;
          }
          return [];
        }
        const cwd = boundedText(params.thread.cwd, MAX_PREVIEW_LENGTH);
        const sessionTitle = boundedText(params.thread.name, MAX_PREVIEW_LENGTH);
        this.activeThreadId = threadId;
        this.activeTurnId = undefined;
        return [
          this.event('thread/started', {
            thread_id: threadId,
            ...(cwd ? { cwd } : {}),
            ...(sessionTitle ? { session_title: sessionTitle } : {}),
          }),
        ];
      }
      case 'turn/started': {
        if (!isRecord(params.turn)) return [];
        const threadId = readString(params.threadId);
        const turnId = readString(params.turn.id);
        if (!threadId || !turnId || this.descendantThreadIds.has(threadId)) return [];
        this.activeThreadId = threadId;
        this.activeTurnId = turnId;
        return [this.event('turn/started', { thread_id: threadId, turn_id: turnId })];
      }
      case 'model/safetyBuffering/updated': {
        const threadId = readString(params.threadId);
        const turnId = readString(params.turnId);
        if (
          !threadId ||
          !turnId ||
          this.descendantThreadIds.has(threadId) ||
          typeof params.showBufferingUi !== 'boolean'
        )
          return [];
        return [
          this.event('model/safetyBuffering/updated', {
            thread_id: threadId,
            turn_id: turnId,
            show_buffering_ui: params.showBufferingUi,
          }),
        ];
      }
      case 'serverRequest/resolved': {
        const requestId = validRequestId(params.requestId);
        if (requestId === undefined) return [];
        const pending = this.pendingRequests.get(requestKey(requestId));
        this.pendingRequests.delete(requestKey(requestId));
        return [
          this.event('serverRequest/resolved', {
            ...(pending?.threadId ? { thread_id: pending.threadId } : {}),
            ...(pending?.turnId ? { turn_id: pending.turnId } : {}),
            request_id: requestId,
          }),
        ];
      }
      case 'error':
        return this.captureError(params);
      case 'turn/completed':
        return this.captureTurnCompleted(params);
      default:
        return [];
    }
  }

  observeClientMessage(message: Record<string, unknown>): CodexProtocolEvent[] {
    if (typeof message.method === 'string') return [];
    const requestId = validRequestId(message.id);
    if (requestId === undefined) return [];
    const key = requestKey(requestId);
    const pending = this.pendingRequests.get(key);
    if (!pending) return [];
    this.pendingRequests.delete(key);
    return [
      this.event('serverRequest/resolved', {
        ...(pending.threadId ? { thread_id: pending.threadId } : {}),
        ...(pending.turnId ? { turn_id: pending.turnId } : {}),
        request_id: requestId,
      }),
    ];
  }

  lifecycle(method: 'session/started' | 'session/ended'): CodexProtocolEvent {
    return this.event(method, {});
  }

  private captureError(params: Record<string, unknown>): CodexProtocolEvent[] {
    const threadId = readString(params.threadId);
    const turnId = readString(params.turnId);
    const error = normalizeProtocolError(params.error);
    if (
      !threadId ||
      !turnId ||
      this.descendantThreadIds.has(threadId) ||
      !error ||
      typeof params.willRetry !== 'boolean'
    )
      return [];
    return [
      this.event('error', {
        thread_id: threadId,
        turn_id: turnId,
        occurrence_id: `error-${++this.errorOccurrenceSequence}`,
        will_retry: params.willRetry,
        error: boundError(error),
      }),
    ];
  }

  private captureTurnCompleted(params: Record<string, unknown>): CodexProtocolEvent[] {
    if (!isRecord(params.turn)) return [];
    const threadId = readString(params.threadId);
    const turnId = readString(params.turn.id);
    const status = readTurnStatus(params.turn.status);
    if (!threadId || !turnId || !status || this.descendantThreadIds.has(threadId)) return [];

    const items = Array.isArray(params.turn.items) ? params.turn.items : [];
    let preview: string | undefined;
    let planComplete = false;
    for (let index = items.length - 1; index >= 0; index--) {
      const item = items[index];
      if (!isRecord(item)) continue;
      if (item.type === 'plan' && typeof item.text === 'string' && item.text.trim()) {
        planComplete = true;
        preview = boundedText(item.text, MAX_PREVIEW_LENGTH);
        break;
      }
      if (
        !preview &&
        item.type === 'agentMessage' &&
        typeof item.text === 'string' &&
        item.text.trim()
      ) {
        preview = boundedText(item.text, MAX_PREVIEW_LENGTH);
      }
    }

    const error = normalizeProtocolError(params.turn.error);
    if (this.activeThreadId === threadId && this.activeTurnId === turnId) {
      this.activeTurnId = undefined;
    }
    return [
      this.event('turn/completed', {
        thread_id: threadId,
        turn_id: turnId,
        status,
        ...(error ? { error: boundError(error) } : {}),
        ...(preview ? { preview } : {}),
        ...(planComplete ? { plan_complete: true } : {}),
      }),
    ];
  }

  private event(
    method: CodexProtocolEvent['method'],
    fields: Omit<CodexProtocolEvent, 'version' | 'kind' | 'method' | 'instance_id'>,
  ): CodexProtocolEvent {
    return {
      version: 1,
      kind: 'protocol',
      method,
      instance_id: this.instanceId,
      ...fields,
      ...(this.processAncestry.length > 0 ? { process_ancestry: [...this.processAncestry] } : {}),
    };
  }

  private rememberRequest(key: string, context: RequestContext): void {
    this.pendingRequests.delete(key);
    this.pendingRequests.set(key, context);
    while (this.pendingRequests.size > MAX_PENDING_REQUESTS) {
      const oldest = this.pendingRequests.keys().next().value;
      if (oldest === undefined) return;
      this.pendingRequests.delete(oldest);
    }
  }
}

function boundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  return truncateCanonicalText(value, maxLength);
}

function boundError(error: CodexProtocolError): CodexProtocolError {
  return {
    message: boundedText(error.message, MAX_ERROR_LENGTH) ?? 'Unknown Codex error',
    ...(error.code ? { code: error.code } : {}),
    ...(error.http_status_code ? { http_status_code: error.http_status_code } : {}),
  };
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  if (value.length > MAX_CAPTURE_JSON_LENGTH) return undefined;
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function validRequestId(value: unknown): string | number | undefined {
  if (typeof value === 'string' && value.length > 0 && value.length <= 200) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  return undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : undefined;
}

function readTurnStatus(value: unknown): CodexProtocolEvent['status'] | undefined {
  return typeof value === 'string' && ['completed', 'interrupted', 'failed'].includes(value)
    ? (value as CodexProtocolEvent['status'])
    : undefined;
}

function requestKey(value: string | number): string {
  return `${typeof value}:${String(value)}`;
}

function isDescendantThread(thread: Record<string, unknown>): boolean {
  if (thread.parentThreadId !== undefined && thread.parentThreadId !== null) return true;
  return (
    thread.source === 'subAgent' ||
    (isRecord(thread.source) && Object.prototype.hasOwnProperty.call(thread.source, 'subAgent'))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
