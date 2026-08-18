import { COMMAND_FOCUS_CODEX_SESSION_PREFIX } from './constants';

const MAXIMUM_SESSION_ID_LENGTH = 200;
const RETURN_TARGET_VERSION = 1;

export interface CodexReturnTarget {
  sessionId: string;
  originCommand?: string;
}

export function createCodexReturnTarget(target: CodexReturnTarget): string {
  if (!isSessionId(target.sessionId) || !isOriginCommand(target.originCommand)) {
    throw new Error('Invalid Codex return target');
  }
  return JSON.stringify({
    version: RETURN_TARGET_VERSION,
    sessionId: target.sessionId,
    ...(target.originCommand === undefined ? {} : { originCommand: target.originCommand }),
  });
}

export function parseCodexReturnTarget(value: string): CodexReturnTarget | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const input = parsed as Record<string, unknown>;
  const expected =
    input.originCommand === undefined
      ? ['sessionId', 'version']
      : ['originCommand', 'sessionId', 'version'];
  if (
    Object.keys(input).sort().join('\0') !== expected.sort().join('\0') ||
    input.version !== RETURN_TARGET_VERSION ||
    !isSessionId(input.sessionId) ||
    !isOriginCommand(input.originCommand)
  ) {
    return undefined;
  }
  return {
    sessionId: input.sessionId,
    ...(input.originCommand === undefined ? {} : { originCommand: input.originCommand }),
  };
}

function isSessionId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAXIMUM_SESSION_ID_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

function isOriginCommand(value: unknown): value is string | undefined {
  if (value === undefined) return true;
  if (typeof value !== 'string' || !value.startsWith(COMMAND_FOCUS_CODEX_SESSION_PREFIX)) {
    return false;
  }
  return /^[0-9a-f]{32}$/.test(value.slice(COMMAND_FOCUS_CODEX_SESSION_PREFIX.length));
}
