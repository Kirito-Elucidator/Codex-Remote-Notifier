import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { TextDecoder } from 'util';

import type * as vscode from 'vscode';

import type { CodexProtocolError } from 'remote-notifier-shared';

import { normalizeProtocolError } from './CodexMetadataResolver';

const READ_CHUNK_BYTES = 64 * 1024;
const MAX_JSONL_LINE_BYTES = 1024 * 1024;
const MAX_MONITORED_FILES = 128;

export interface CodexTranscriptTurn {
  invocationId?: string;
  sessionId: string;
  turnId: string;
  transcriptPath: string;
  cwd?: string;
  processAncestry?: number[];
}

export interface CodexTranscriptTerminalFailure extends CodexTranscriptTurn {
  error: CodexProtocolError;
}

interface TranscriptCompletion {
  turnId: string;
  error?: CodexProtocolError;
}

interface TranscriptFileState {
  filePath: string;
  offset: number;
  decoder: TextDecoder;
  pendingLine: string;
  discardingOversizedLine: boolean;
  turns: Map<string, CodexTranscriptTurn>;
  watcher?: fs.FSWatcher;
  stopWatching?: () => void;
  draining: boolean;
  rescan: boolean;
  closed: boolean;
}

export class CodexTranscriptMonitor implements vscode.Disposable {
  private readonly files = new Map<string, TranscriptFileState>();
  private disposed = false;

  constructor(
    private readonly onTerminalFailure: (failure: CodexTranscriptTerminalFailure) => void,
    private readonly log?: vscode.OutputChannel,
  ) {}

  async watchTurn(turn: CodexTranscriptTurn): Promise<void> {
    if (this.disposed) return;
    const filePath = path.resolve(turn.transcriptPath);
    let state = this.files.get(filePath);
    if (!state) {
      try {
        const stat = await fsPromises.stat(filePath);
        if (!stat.isFile()) return;
        state = {
          filePath,
          offset: stat.size,
          decoder: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }),
          pendingLine: '',
          discardingOversizedLine: false,
          turns: new Map(),
          draining: false,
          rescan: false,
          closed: false,
        };
        this.files.set(filePath, state);
        this.startWatching(state);
        this.trimFiles();
      } catch (error) {
        this.log?.appendLine(
          `[CodexTranscriptMonitor] Could not monitor ${path.basename(filePath)}: ${formatError(error)}`,
        );
        return;
      }
    } else {
      this.files.delete(filePath);
      this.files.set(filePath, state);
    }

    state.turns.set(turn.turnId, {
      ...turn,
      transcriptPath: filePath,
      ...(turn.processAncestry ? { processAncestry: [...turn.processAncestry] } : {}),
    });
    this.scheduleDrain(state);
  }

  unwatchSession(sessionId: string): void {
    for (const state of [...this.files.values()]) {
      for (const [turnId, turn] of state.turns) {
        if (turn.sessionId === sessionId) state.turns.delete(turnId);
      }
      if (state.turns.size === 0) this.closeState(state);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const state of [...this.files.values()]) this.closeState(state);
  }

  private startWatching(state: TranscriptFileState): void {
    try {
      const watcher = fs.watch(state.filePath, { persistent: false }, () =>
        this.scheduleDrain(state),
      );
      state.watcher = watcher;
      state.stopWatching = () => watcher.close();
      watcher.on('error', (error) => {
        this.log?.appendLine(
          `[CodexTranscriptMonitor] Watch failed for ${path.basename(state.filePath)}: ${formatError(error)}`,
        );
        this.closeState(state);
      });
    } catch (error) {
      this.log?.appendLine(
        `[CodexTranscriptMonitor] Native watch unavailable for ${path.basename(state.filePath)}: ${formatError(error)}`,
      );
      const listener = (current: fs.Stats, previous: fs.Stats) => {
        if (current.size !== previous.size || current.mtimeMs !== previous.mtimeMs) {
          this.scheduleDrain(state);
        }
      };
      fs.watchFile(state.filePath, { interval: 250, persistent: false }, listener);
      state.stopWatching = () => fs.unwatchFile(state.filePath, listener);
    }
  }

  private scheduleDrain(state: TranscriptFileState): void {
    if (state.closed || this.disposed) return;
    if (state.draining) {
      state.rescan = true;
      return;
    }
    void this.drain(state);
  }

  private async drain(state: TranscriptFileState): Promise<void> {
    state.draining = true;
    try {
      do {
        state.rescan = false;
        await this.readAvailable(state);
      } while (state.rescan && !state.closed && !this.disposed);
    } catch (error) {
      this.log?.appendLine(
        `[CodexTranscriptMonitor] Failed to read ${path.basename(state.filePath)}: ${formatError(error)}`,
      );
      this.closeState(state);
    } finally {
      state.draining = false;
    }
  }

  private async readAvailable(state: TranscriptFileState): Promise<void> {
    const handle = await fsPromises.open(state.filePath, 'r');
    try {
      const stat = await handle.stat();
      if (stat.size < state.offset) {
        state.offset = 0;
        state.decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
        state.pendingLine = '';
        state.discardingOversizedLine = false;
      }

      const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
      while (state.offset < stat.size && !state.closed && !this.disposed) {
        const length = Math.min(buffer.length, stat.size - state.offset);
        const { bytesRead } = await handle.read(buffer, 0, length, state.offset);
        if (bytesRead === 0) break;
        state.offset += bytesRead;
        this.consumeText(
          state,
          state.decoder.decode(buffer.subarray(0, bytesRead), { stream: true }),
        );
      }
    } finally {
      await handle.close();
    }
  }

  private consumeText(state: TranscriptFileState, text: string): void {
    let start = 0;
    for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', start)) {
      const segment = text.slice(start, index).replace(/\r$/, '');
      start = index + 1;
      if (state.discardingOversizedLine) {
        state.discardingOversizedLine = false;
        state.pendingLine = '';
        continue;
      }

      const line = state.pendingLine + segment;
      state.pendingLine = '';
      if (Buffer.byteLength(line) <= MAX_JSONL_LINE_BYTES) {
        this.consumeLine(state, line);
      }
    }

    const remainder = text.slice(start);
    if (!remainder || state.discardingOversizedLine) return;
    if (
      Buffer.byteLength(state.pendingLine) + Buffer.byteLength(remainder) >
      MAX_JSONL_LINE_BYTES
    ) {
      state.pendingLine = '';
      state.discardingOversizedLine = true;
      return;
    }
    state.pendingLine += remainder;
  }

  private consumeLine(state: TranscriptFileState, line: string): void {
    const completion = parseTranscriptCompletion(line);
    if (!completion) return;
    const turn = state.turns.get(completion.turnId);
    if (!turn) return;
    state.turns.delete(completion.turnId);

    if (completion.error) {
      this.onTerminalFailure({ ...turn, error: completion.error });
    }
    if (state.turns.size === 0) this.closeState(state);
  }

  private closeState(state: TranscriptFileState): void {
    if (state.closed) return;
    state.closed = true;
    state.stopWatching?.();
    state.watcher = undefined;
    state.stopWatching = undefined;
    state.turns.clear();
    this.files.delete(state.filePath);
  }

  private trimFiles(): void {
    while (this.files.size > MAX_MONITORED_FILES) {
      const oldest = this.files.values().next().value;
      if (!oldest) return;
      this.closeState(oldest);
    }
  }
}

export function parseTranscriptCompletion(line: string): TranscriptCompletion | undefined {
  if (!line || Buffer.byteLength(line) > MAX_JSONL_LINE_BYTES) return undefined;
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(record) || record.type !== 'event_msg' || !isRecord(record.payload)) {
    return undefined;
  }

  const payload = record.payload;
  const eventType = String(payload.type ?? '').toLowerCase();
  if (
    eventType !== 'task_complete' &&
    eventType !== 'turn_complete' &&
    eventType !== 'turn_aborted'
  ) {
    return undefined;
  }
  const turnId = readBoundedString(payload.turn_id ?? payload.turnId, 200);
  if (!turnId) return undefined;
  if (eventType === 'turn_aborted') return { turnId };
  const error = normalizeProtocolError(payload.error);
  return { turnId, ...(error ? { error } : {}) };
}

function readBoundedString(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
