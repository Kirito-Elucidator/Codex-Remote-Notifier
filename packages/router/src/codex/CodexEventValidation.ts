import type {
  CodexErrorCode,
  CodexEvent,
  CodexHookEventName,
  CodexProtocolMethod,
  CodexProtocolRequestMethod,
} from 'remote-notifier-shared';

const MAX_ID_LENGTH = 200;
const MAX_PATH_LENGTH = 4096;
const MAX_PREVIEW_LENGTH = 4000;
const MAX_ERROR_LENGTH = 1000;
const MAX_PROCESS_ANCESTRY = 24;

const HOOK_FIELDS = new Set([
  'version',
  'kind',
  'hook_event_name',
  'invocation_id',
  'session_id',
  'turn_id',
  'request_id',
  'cwd',
  'transcript_path',
  'last_assistant_message',
  'tool_name',
  'protocol_authoritative',
  'process_ancestry',
]);

const PROTOCOL_FIELDS = new Set([
  'version',
  'kind',
  'method',
  'instance_id',
  'thread_id',
  'turn_id',
  'request_id',
  'occurrence_id',
  'process_ancestry',
  'cwd',
  'session_title',
  'show_buffering_ui',
  'will_retry',
  'status',
  'error',
  'preview',
  'plan_complete',
]);

const HOOK_EVENT_NAMES = new Set<CodexHookEventName>([
  'SessionStart',
  'UserPromptSubmit',
  'Stop',
  'PreToolUse',
  'PermissionRequest',
]);

export const CODEX_PROTOCOL_REQUEST_METHODS = new Set<CodexProtocolRequestMethod>([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/tool/requestUserInput',
  'item/permissions/requestApproval',
  'mcpServer/elicitation/request',
  'applyPatchApproval',
  'execCommandApproval',
]);

const PROTOCOL_METHODS = new Set<CodexProtocolMethod>([
  'session/started',
  'session/ended',
  'thread/started',
  'turn/started',
  'turn/completed',
  'model/safetyBuffering/updated',
  'serverRequest/resolved',
  'error',
  ...CODEX_PROTOCOL_REQUEST_METHODS,
]);

const ERROR_CODES = new Set<CodexErrorCode>([
  'contextWindowExceeded',
  'sessionBudgetExceeded',
  'usageLimitExceeded',
  'serverOverloaded',
  'cyberPolicy',
  'httpConnectionFailed',
  'responseStreamConnectionFailed',
  'internalServerError',
  'unauthorized',
  'badRequest',
  'threadRollbackFailed',
  'sandboxError',
  'responseStreamDisconnected',
  'responseTooManyFailedAttempts',
  'activeTurnNotSteerable',
  'other',
]);

export type CodexEventParseResult = { ok: true; event: CodexEvent } | { ok: false; error: string };

export function parseCodexEvent(payload: unknown): CodexEventParseResult {
  if (!isRecord(payload)) {
    return failure('request body must be a JSON object');
  }
  if (payload.version !== 1) {
    return failure('version must be 1');
  }

  if (payload.kind === 'hook') {
    return parseHookEvent(payload);
  }
  if (payload.kind === 'protocol') {
    return parseProtocolEvent(payload);
  }
  return failure('kind must be hook or protocol');
}

function parseHookEvent(payload: Record<string, unknown>): CodexEventParseResult {
  const unknownField = findUnknownField(payload, HOOK_FIELDS);
  if (unknownField) return failure(`unsupported hook field: ${unknownField}`);
  if (
    typeof payload.hook_event_name !== 'string' ||
    !HOOK_EVENT_NAMES.has(payload.hook_event_name as CodexHookEventName)
  ) {
    return failure('hook_event_name is not supported');
  }

  const stringError = validateOptionalStrings(payload, [
    ['invocation_id', MAX_ID_LENGTH],
    ['session_id', MAX_ID_LENGTH],
    ['turn_id', MAX_ID_LENGTH],
    ['request_id', MAX_ID_LENGTH],
    ['cwd', MAX_PATH_LENGTH],
    ['transcript_path', MAX_PATH_LENGTH],
    ['last_assistant_message', MAX_PREVIEW_LENGTH],
    ['tool_name', MAX_ID_LENGTH],
  ]);
  if (stringError) return failure(stringError);

  if (
    payload.protocol_authoritative !== undefined &&
    typeof payload.protocol_authoritative !== 'boolean'
  ) {
    return failure('protocol_authoritative must be a boolean');
  }
  const ancestryError = validateProcessAncestry(payload.process_ancestry);
  if (ancestryError) return failure(ancestryError);

  return { ok: true, event: payload as unknown as CodexEvent };
}

function parseProtocolEvent(payload: Record<string, unknown>): CodexEventParseResult {
  const unknownField = findUnknownField(payload, PROTOCOL_FIELDS);
  if (unknownField) return failure(`unsupported protocol field: ${unknownField}`);
  if (
    typeof payload.method !== 'string' ||
    !PROTOCOL_METHODS.has(payload.method as CodexProtocolMethod)
  ) {
    return failure('method is not a monitored Codex protocol event');
  }
  if (!isBoundedString(payload.instance_id, MAX_ID_LENGTH, false)) {
    return failure('instance_id is required and must be a bounded string');
  }

  const stringError = validateOptionalStrings(payload, [
    ['thread_id', MAX_ID_LENGTH],
    ['turn_id', MAX_ID_LENGTH],
    ['occurrence_id', MAX_ID_LENGTH],
    ['cwd', MAX_PATH_LENGTH],
    ['session_title', MAX_PREVIEW_LENGTH],
    ['preview', MAX_PREVIEW_LENGTH],
  ]);
  if (stringError) return failure(stringError);

  if (
    payload.request_id !== undefined &&
    typeof payload.request_id !== 'string' &&
    typeof payload.request_id !== 'number'
  ) {
    return failure('request_id must be a string or number');
  }
  if (
    typeof payload.request_id === 'string' &&
    !isBoundedString(payload.request_id, MAX_ID_LENGTH, false)
  ) {
    return failure('request_id exceeds its maximum length');
  }
  if (typeof payload.request_id === 'number' && !Number.isSafeInteger(payload.request_id)) {
    return failure('numeric request_id must be a safe integer');
  }

  const ancestryError = validateProcessAncestry(payload.process_ancestry);
  if (ancestryError) return failure(ancestryError);

  const method = payload.method as CodexProtocolMethod;
  if (CODEX_PROTOCOL_REQUEST_METHODS.has(method as CodexProtocolRequestMethod)) {
    if (payload.request_id === undefined) return failure('request_id is required for requests');
    if (
      method !== 'mcpServer/elicitation/request' &&
      !isBoundedString(payload.thread_id, MAX_ID_LENGTH, false)
    ) {
      return failure('thread_id is required for requests');
    }
  }

  if (method === 'serverRequest/resolved' && payload.request_id === undefined) {
    return failure('request_id is required for serverRequest/resolved');
  }

  if (
    [
      'thread/started',
      'turn/started',
      'turn/completed',
      'model/safetyBuffering/updated',
      'error',
    ].includes(method) &&
    !isBoundedString(payload.thread_id, MAX_ID_LENGTH, false)
  ) {
    return failure(`thread_id is required for ${method}`);
  }

  if (
    ['turn/started', 'turn/completed', 'model/safetyBuffering/updated', 'error'].includes(method) &&
    !isBoundedString(payload.turn_id, MAX_ID_LENGTH, false)
  ) {
    return failure(`turn_id is required for ${method}`);
  }

  if (
    method === 'model/safetyBuffering/updated' &&
    typeof payload.show_buffering_ui !== 'boolean'
  ) {
    return failure('show_buffering_ui is required for safety buffering updates');
  }
  if (method === 'error' && typeof payload.will_retry !== 'boolean') {
    return failure('will_retry is required for error events');
  }

  if (payload.status !== undefined) {
    if (
      typeof payload.status !== 'string' ||
      !['completed', 'interrupted', 'failed'].includes(payload.status)
    ) {
      return failure('status is invalid');
    }
  }
  if (method === 'turn/completed' && payload.status === undefined) {
    return failure('status is required for turn/completed');
  }

  if (payload.plan_complete !== undefined && typeof payload.plan_complete !== 'boolean') {
    return failure('plan_complete must be a boolean');
  }

  const errorValidation = validateError(payload.error);
  if (errorValidation) return failure(errorValidation);
  return { ok: true, event: payload as unknown as CodexEvent };
}

function validateError(error: unknown): string | null {
  if (error === undefined) return null;
  if (!isRecord(error)) return 'error must be an object';
  const unknownField = findUnknownField(error, new Set(['message', 'code', 'http_status_code']));
  if (unknownField) return `unsupported error field: ${unknownField}`;
  if (!isBoundedString(error.message, MAX_ERROR_LENGTH, false)) {
    return 'error.message is required and must be bounded';
  }
  if (
    error.code !== undefined &&
    (typeof error.code !== 'string' || !ERROR_CODES.has(error.code as CodexErrorCode))
  ) {
    return 'error.code is invalid';
  }
  if (
    error.http_status_code !== undefined &&
    (!Number.isSafeInteger(error.http_status_code) ||
      Number(error.http_status_code) < 100 ||
      Number(error.http_status_code) > 599)
  ) {
    return 'error.http_status_code is invalid';
  }
  return null;
}

function validateOptionalStrings(
  payload: Record<string, unknown>,
  fields: ReadonlyArray<readonly [string, number]>,
): string | null {
  for (const [field, maxLength] of fields) {
    const value = payload[field];
    if (value !== undefined && !isBoundedString(value, maxLength, true)) {
      return `${field} must be a bounded string`;
    }
  }
  return null;
}

function validateProcessAncestry(value: unknown): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return 'process_ancestry must be an array';
  if (value.length > MAX_PROCESS_ANCESTRY) {
    return `process_ancestry exceeds maximum length of ${MAX_PROCESS_ANCESTRY}`;
  }
  if (value.some((processId) => !Number.isSafeInteger(processId) || Number(processId) <= 0)) {
    return 'process_ancestry must contain positive integers';
  }
  return null;
}

function isBoundedString(value: unknown, maxLength: number, allowEmpty: boolean): boolean {
  return typeof value === 'string' && (allowEmpty || value.length > 0) && value.length <= maxLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function findUnknownField(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): string | undefined {
  return Object.keys(value).find((field) => !allowed.has(field));
}

function failure(error: string): CodexEventParseResult {
  return { ok: false, error };
}
