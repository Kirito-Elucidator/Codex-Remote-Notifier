import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import type { CodexProtocolError } from 'remote-notifier-shared';

const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const MAX_INDEX_BYTES = 1024 * 1024;
const MAX_JSONL_LINE_BYTES = 1024 * 1024;
const SQLITE_TIMEOUT_MS = 500;

export interface CodexTranscriptInfo {
  isPlanMode: boolean;
  hasPlanItem: boolean;
  completionObserved: boolean;
  planText?: string;
  lastAssistantMessage?: string;
  terminalError?: CodexProtocolError;
}

export interface CodexPreviewParts {
  sessionTitle?: string;
  answer?: string;
  cwdName?: string;
}

export class CodexMetadataResolver {
  constructor(
    private readonly codexHome = resolveCodexHome(),
    private readonly sqliteQuery = querySqliteTitle,
  ) {}

  async readTranscript(
    transcriptPath: string | undefined,
    turnId: string | undefined,
  ): Promise<CodexTranscriptInfo> {
    const result: CodexTranscriptInfo = {
      isPlanMode: false,
      hasPlanItem: false,
      completionObserved: false,
    };
    if (!transcriptPath || !turnId) return result;

    const data = await readFileTail(transcriptPath, MAX_TRANSCRIPT_BYTES).catch(() => null);
    if (!data) return result;

    for (const line of data.split(/\r?\n/)) {
      if (!line || Buffer.byteLength(line) > MAX_JSONL_LINE_BYTES) continue;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(record) || !isRecord(record.payload)) continue;
      const payload = record.payload;
      if (payload.turn_id !== turnId && payload.turnId !== turnId) continue;

      if (record.type === 'turn_context') {
        const collaborationMode = payload.collaboration_mode ?? payload.collaborationMode;
        if (isRecord(collaborationMode) && collaborationMode.mode === 'plan') {
          result.isPlanMode = true;
        }
        continue;
      }

      if (record.type !== 'event_msg') continue;
      const eventType = String(payload.type ?? '').toLowerCase();
      if (eventType === 'item_completed' && isRecord(payload.item)) {
        const itemType = String(payload.item.type ?? '').toLowerCase();
        if (itemType === 'plan') {
          result.hasPlanItem = true;
          if (typeof payload.item.text === 'string' && payload.item.text.trim()) {
            result.planText = payload.item.text;
          }
        } else if (
          (itemType === 'agent_message' || itemType === 'agentmessage') &&
          typeof payload.item.text === 'string' &&
          payload.item.text.trim()
        ) {
          result.lastAssistantMessage = payload.item.text;
        }
        continue;
      }

      if (eventType === 'task_complete' || eventType === 'turn_complete') {
        result.completionObserved = true;
        const lastMessage = payload.last_agent_message ?? payload.lastAgentMessage;
        if (typeof lastMessage === 'string' && lastMessage.trim()) {
          result.lastAssistantMessage = lastMessage;
        }
        const terminalError = normalizeProtocolError(payload.error);
        if (terminalError) result.terminalError = terminalError;
      }
    }
    return result;
  }

  async resolvePreviewParts(
    sessionId: string | undefined,
    cwd: string | undefined,
    answer: string | undefined,
  ): Promise<CodexPreviewParts> {
    const sessionTitle = sessionId ? await this.readSessionTitle(sessionId) : undefined;
    const cwdName = cwd ? path.basename(path.resolve(cwd)) || cwd : undefined;
    return {
      sessionTitle: cleanVisibleText(sessionTitle),
      answer: cleanVisibleText(answer),
      cwdName: cleanVisibleText(cwdName),
    };
  }

  async readSessionTitle(sessionId: string): Promise<string | undefined> {
    const indexed = await this.readSessionIndexTitle(sessionId);
    if (indexed) return indexed;

    const databasePaths = await this.findStateDatabases();
    if (databasePaths.length === 0) return undefined;
    return this.sqliteQuery(databasePaths, sessionId);
  }

  private async readSessionIndexTitle(sessionId: string): Promise<string | undefined> {
    const indexPath = path.join(this.codexHome, 'session_index.jsonl');
    const data = await readFileTail(indexPath, MAX_INDEX_BYTES).catch(() => null);
    if (!data) return undefined;
    const lines = data.split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index--) {
      const line = lines[index];
      if (!line || Buffer.byteLength(line) > MAX_JSONL_LINE_BYTES) continue;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry.id !== sessionId) continue;
        const title = entry.thread_name ?? entry.threadName ?? entry.name;
        if (typeof title === 'string' && title.trim()) return title;
      } catch {
        continue;
      }
    }
    return undefined;
  }

  private async findStateDatabases(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.codexHome, { withFileTypes: true });
      const candidates = await Promise.all(
        entries
          .filter((entry) => entry.isFile() && /^state_.*\.sqlite$/i.test(entry.name))
          .map(async (entry) => {
            const filePath = path.join(this.codexHome, entry.name);
            const stat = await fs.stat(filePath).catch(() => null);
            return stat ? { filePath, modifiedAt: stat.mtimeMs } : null;
          }),
      );
      return candidates
        .filter((candidate): candidate is { filePath: string; modifiedAt: number } =>
          Boolean(candidate),
        )
        .sort((a, b) => b.modifiedAt - a.modifiedAt)
        .map((candidate) => candidate.filePath);
    } catch {
      return [];
    }
  }
}

export function resolveCodexHome(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = os.homedir(),
): string {
  const configured = environment.CODEX_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(homeDirectory, '.codex');
}

export function cleanVisibleText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const withoutAnsi = value.replace(
    // CSI and OSC escape sequences.
    // eslint-disable-next-line no-control-regex
    /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g,
    '',
  );
  const cleaned = withoutAnsi
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || undefined;
}

export function truncateVisible(value: string | undefined, limit: number): string | undefined {
  const cleaned = cleanVisibleText(value);
  if (!cleaned) return undefined;
  const boundedLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const segments = [...segmenter.segment(cleaned)];
  return segments.length <= boundedLimit
    ? cleaned
    : segments
        .slice(0, boundedLimit)
        .map((segment) => segment.segment)
        .join('')
        .trimEnd();
}

export function normalizeProtocolError(value: unknown): CodexProtocolError | undefined {
  if (!isRecord(value) || typeof value.message !== 'string' || !value.message.trim()) {
    return undefined;
  }
  const info = value.codexErrorInfo ?? value.codex_error_info;
  const normalized = normalizeErrorInfo(info);
  return {
    message: value.message,
    ...(normalized.code ? { code: normalized.code } : {}),
    ...(normalized.httpStatusCode ? { http_status_code: normalized.httpStatusCode } : {}),
  };
}

async function readFileTail(filePath: string, maxBytes: number): Promise<string> {
  const handle = await fs.open(path.resolve(filePath), 'r');
  try {
    const stat = await handle.stat();
    const start = Math.max(0, stat.size - maxBytes);
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    let data = buffer.subarray(0, bytesRead);
    if (start > 0) {
      const newline = data.indexOf(0x0a);
      if (newline < 0) return '';
      data = data.subarray(newline + 1);
    }
    return data.toString('utf-8');
  } finally {
    await handle.close();
  }
}

async function querySqliteTitle(
  databasePaths: string[],
  sessionId: string,
): Promise<string | undefined> {
  const script = [
    'import json, sqlite3, sys',
    'paths = json.loads(sys.argv[1])',
    'session_id = sys.argv[2]',
    'for db_path in paths:',
    '    connection = None',
    '    try:',
    '        connection = sqlite3.connect("file:" + db_path.replace("\\\\", "/") + "?mode=ro", uri=True, timeout=0.1)',
    `        row = connection.execute("SELECT title FROM threads WHERE id = ? AND title <> '' LIMIT 1", (session_id,)).fetchone()`,
    '        if row and isinstance(row[0], str) and row[0].strip():',
    '            print(row[0])',
    '            break',
    '    except Exception:',
    '        pass',
    '    finally:',
    '        if connection is not None:',
    '            connection.close()',
  ].join('\n');

  const candidates =
    process.platform === 'win32'
      ? [
          { command: 'py', args: ['-3', '-c', script] },
          { command: 'python', args: ['-c', script] },
        ]
      : [
          { command: 'python3', args: ['-c', script] },
          { command: 'python', args: ['-c', script] },
        ];

  for (const candidate of candidates) {
    try {
      const output = await execFileText(candidate.command, [
        ...candidate.args,
        JSON.stringify(databasePaths),
        sessionId,
      ]);
      const title = cleanVisibleText(output);
      if (title) return title;
      return undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return undefined;
    }
  }
  return undefined;
}

function execFileText(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: 'utf-8',
        timeout: SQLITE_TIMEOUT_MS,
        maxBuffer: 4096,
        windowsHide: true,
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

function normalizeErrorInfo(value: unknown): {
  code?: CodexProtocolError['code'];
  httpStatusCode?: number;
} {
  if (typeof value === 'string') {
    return { code: normalizeErrorCode(value) };
  }
  if (!isRecord(value)) return {};

  if (typeof value.type === 'string') {
    const code = normalizeErrorCode(value.type);
    const status = normalizeHttpStatusCode(value.httpStatusCode ?? value.http_status_code);
    return { ...(code ? { code } : {}), ...(status ? { httpStatusCode: status } : {}) };
  }

  const entry = Object.entries(value)[0];
  if (!entry) return {};
  const [rawCode, details] = entry;
  const code = normalizeErrorCode(rawCode);
  const status =
    isRecord(details) &&
    normalizeHttpStatusCode(details.httpStatusCode ?? details.http_status_code);
  return { ...(code ? { code } : {}), ...(status ? { httpStatusCode: status } : {}) };
}

function normalizeErrorCode(value: string): CodexProtocolError['code'] | undefined {
  const known: NonNullable<CodexProtocolError['code']>[] = [
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
  ];
  const compact = value
    .trim()
    .replace(/[_\s-]+/g, '')
    .toLowerCase();
  return known.find((candidate) => candidate.toLowerCase() === compact) ?? 'other';
}

function normalizeHttpStatusCode(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 100 && Number(value) <= 599
    ? Number(value)
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
