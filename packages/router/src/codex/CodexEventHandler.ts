import { createHash } from 'crypto';
import * as os from 'os';

import type * as vscode from 'vscode';

import type {
  CodexErrorCode,
  CodexEvent,
  CodexHookEvent,
  CodexProtocolError,
  CodexProtocolEvent,
  CodexProtocolRequestMethod,
  NotificationLevel,
  NotificationPayload,
} from 'remote-notifier-shared';

import { Configuration } from '../config/Configuration';
import { NotificationHandler } from '../handler/NotificationHandler';
import { CODEX_PROTOCOL_REQUEST_METHODS } from './CodexEventValidation';
import {
  cleanVisibleText,
  CodexMetadataResolver,
  CodexTranscriptInfo,
  truncateCanonicalText,
  truncateVisible,
} from './CodexMetadataResolver';
import { compatibilityTitle } from './CodexMonitoringPresentation';
import { CodexTranscriptMonitor, CodexTranscriptTerminalFailure } from './CodexTranscriptMonitor';

const MAX_THREAD_STATES = 128;
const MAX_SEEN_REQUESTS = 2048;
const MAX_COMPLETED_TURNS = 2048;
const MAX_SEEN_ERROR_OCCURRENCES = 4096;
const STOP_PERSISTENCE_DELAYS_MS = [150, 200, 400] as const;
const MAX_ERROR_PREVIEW = 240;
const MAX_ERROR_INSPECTION_LENGTH = 16 * 1024;

interface ThreadState {
  activeTurnId?: string;
  safetyBufferingVisible: boolean;
  cwd?: string;
  sessionTitle?: string;
  instanceId?: string;
}

export interface CodexMonitoringAuthority {
  isExactForeground(foregroundThreadKey: string, invocationId?: string): boolean;
  observeHook(foregroundThreadKey: string, invocationId?: string): void;
}

export class CodexEventHandler implements vscode.Disposable {
  private readonly threads = new Map<string, ThreadState>();
  private readonly authoritativeSessions = new Set<string>();
  private readonly seenRequests = new Map<string, true>();
  private readonly completedTurns = new Map<string, true>();
  private readonly terminalFailureTurns = new Map<string, true>();
  private readonly seenErrorOccurrences = new Map<string, true>();
  private readonly errorNotifiedTurns = new Map<string, true>();
  private readonly transcriptMonitor: CodexTranscriptMonitor;
  private legacyErrorOccurrenceSequence = 0;
  private chain = Promise.resolve();

  constructor(
    private readonly notifications: NotificationHandler,
    private readonly config: Configuration,
    private readonly metadata = new CodexMetadataResolver(),
    private readonly log?: vscode.OutputChannel,
    private readonly monitoring?: CodexMonitoringAuthority,
  ) {
    this.transcriptMonitor = new CodexTranscriptMonitor(
      (failure) => this.enqueueTranscriptFailure(failure),
      log,
    );
  }

  dispose(): void {
    this.transcriptMonitor.dispose();
  }

  handle(event: CodexEvent): Promise<void> {
    const work = this.chain.then(() => this.handleSerial(event));
    this.chain = work.catch((error) => {
      this.log?.appendLine(`[CodexEventHandler] Failed to process event: ${formatError(error)}`);
    });
    return work;
  }

  private async handleSerial(event: CodexEvent): Promise<void> {
    if (event.kind === 'hook') {
      await this.handleHook(event);
      return;
    }
    await this.handleProtocol(event);
  }

  private async handleProtocol(event: CodexProtocolEvent): Promise<void> {
    if (event.thread_id && event.process_ancestry) {
      await this.notifications.trackCodexSession(event.thread_id, event.process_ancestry);
    }

    if (event.thread_id) {
      this.authoritativeSessions.add(event.thread_id);
    }

    switch (event.method) {
      case 'session/started':
        return;
      case 'session/ended':
        this.removeInstance(event.instance_id);
        return;
      case 'thread/started':
        this.onThreadStarted(event);
        return;
      case 'turn/started':
        this.onTurnStarted(event);
        return;
      case 'model/safetyBuffering/updated':
        await this.onSafetyBuffering(event);
        return;
      case 'serverRequest/resolved':
        if (event.thread_id) {
          const state = this.getThreadState(event.thread_id);
          state.instanceId ??= event.instance_id;
        }
        return;
      case 'error':
        this.log?.appendLine(
          `[CodexEventHandler] Protocol error turn=${event.turn_id ?? 'unknown'} retry=${String(event.will_retry)} code=${event.error?.code ?? 'unknown'}`,
        );
        await this.onError(event);
        return;
      case 'turn/completed':
        this.log?.appendLine(
          `[CodexEventHandler] Protocol completion turn=${event.turn_id ?? 'unknown'} status=${event.status ?? 'unknown'} error=${event.error?.code ?? 'none'}`,
        );
        await this.onTurnCompleted(event);
        return;
      default:
        if (CODEX_PROTOCOL_REQUEST_METHODS.has(event.method as CodexProtocolRequestMethod)) {
          await this.onServerRequest(event);
        }
    }
  }

  private async handleHook(event: CodexHookEvent): Promise<void> {
    const sessionId = event.session_id;
    if (sessionId && event.process_ancestry) {
      await this.notifications.trackCodexSession(sessionId, event.process_ancestry);
    }
    if (sessionId) this.monitoring?.observeHook(sessionId, event.invocation_id);
    if (sessionId && event.hook_event_name === 'SessionStart' && !event.protocol_authoritative) {
      // Recover Hook fallback if a previous sidecar could not deliver session/ended.
      this.authoritativeSessions.delete(sessionId);
      this.threads.delete(sessionId);
    }
    if (this.isProtocolAuthoritativeHook(event)) {
      this.log?.appendLine(
        `[CodexEventHandler] Ignored ${event.hook_event_name} hook for protocol session`,
      );
      return;
    }

    const watchTurn = this.watchHookTurn(event);
    if (event.hook_event_name === 'UserPromptSubmit') await watchTurn;
    else void watchTurn;

    if (event.hook_event_name === 'SessionStart' || event.hook_event_name === 'UserPromptSubmit') {
      return;
    }

    if (event.hook_event_name === 'PreToolUse' && event.tool_name === 'request_user_input') {
      await this.presentAttention(event, '[等待回答]', 'waiting-answer');
      return;
    }
    if (event.hook_event_name === 'PermissionRequest') {
      await this.presentAttention(event, '[等待授权]', 'waiting-permission');
      return;
    }
    if (event.hook_event_name !== 'Stop') return;

    const transcript = await this.readPersistedStop(event);
    if (this.isProtocolAuthoritativeHook(event)) {
      this.log?.appendLine('[CodexEventHandler] Ignored Stop hook after protocol qualification');
      return;
    }
    if (transcript.terminalError) {
      await this.presentTerminalError(
        event.session_id,
        event.turn_id,
        event.cwd,
        transcript.terminalError,
        event.process_ancestry,
        true,
        event.invocation_id,
      );
      return;
    }

    const rawAnswer =
      transcript.planText ?? event.last_assistant_message ?? transcript.lastAssistantMessage;
    const planTag =
      typeof event.last_assistant_message === 'string' &&
      /<proposed_plan\s*>/i.test(event.last_assistant_message);
    const title =
      transcript.hasPlanItem || planTag
        ? '[计划完成]'
        : transcript.isPlanMode
          ? '[计划继续]'
          : '[任务完成]';
    const eventKey =
      transcript.hasPlanItem || planTag
        ? 'plan-complete'
        : transcript.isPlanMode
          ? 'plan-continue'
          : 'task-complete';
    const message = await this.buildMessage(event.session_id, event.cwd, stripPlanTags(rawAnswer));
    if (this.isProtocolAuthoritativeHook(event)) return;
    await this.presentCodex({
      title: compatibilityTitle(title),
      message,
      level: 'information',
      sessionId: event.session_id,
      turnId: event.turn_id,
      eventKey,
      processAncestry: event.process_ancestry,
    });
  }

  private onThreadStarted(event: CodexProtocolEvent): void {
    const threadId = event.thread_id;
    if (!threadId) return;
    this.setThreadState(threadId, {
      activeTurnId: undefined,
      safetyBufferingVisible: false,
      cwd: event.cwd,
      sessionTitle: event.session_title,
      instanceId: event.instance_id,
    });
  }

  private onTurnStarted(event: CodexProtocolEvent): void {
    const threadId = event.thread_id;
    if (!threadId || !event.turn_id) return;
    const state = this.getThreadState(threadId);
    state.activeTurnId = event.turn_id;
    state.safetyBufferingVisible = false;
    state.instanceId = event.instance_id;
    if (event.cwd) state.cwd = event.cwd;
  }

  private async onSafetyBuffering(event: CodexProtocolEvent): Promise<void> {
    const state = this.currentTurnState(event);
    if (!state || typeof event.show_buffering_ui !== 'boolean') return;
    if (!event.show_buffering_ui) {
      state.safetyBufferingVisible = false;
      return;
    }
    if (state.safetyBufferingVisible) return;

    await this.presentCodex({
      title: '[等待安全检查]',
      message: await this.buildMessage(event.thread_id, state.cwd),
      level: 'warning',
      sessionId: event.thread_id,
      turnId: event.turn_id,
      eventKey: `safety-buffering:${event.turn_id}`,
      processAncestry: event.process_ancestry,
    });
    state.safetyBufferingVisible = true;
  }

  private async onServerRequest(event: CodexProtocolEvent): Promise<void> {
    const state = event.thread_id
      ? !event.turn_id
        ? this.getThreadState(event.thread_id)
        : this.currentTurnState(event, true)
      : undefined;
    if ((event.thread_id && !state) || event.request_id === undefined) return;
    if (state) state.instanceId ??= event.instance_id;
    const requestIdentity = `${typeof event.request_id}:${String(event.request_id)}`;
    const requestKey = `${event.instance_id}\u0000${requestIdentity}`;
    if (this.seenRequests.has(requestKey)) return;

    const details = requestNotificationDetails(event.method as CodexProtocolRequestMethod);
    await this.presentCodex({
      title: details.title,
      message: await this.buildMessage(event.thread_id, state?.cwd),
      level: 'information',
      sessionId: event.thread_id,
      turnId: event.turn_id,
      eventKey: `request:${event.instance_id}:${requestIdentity}`,
      processAncestry: event.process_ancestry,
    });
    this.remember(this.seenRequests, requestKey, MAX_SEEN_REQUESTS);
  }

  private async onError(event: CodexProtocolEvent): Promise<void> {
    const state = this.currentTurnState(event);
    if (!state || !event.error) return;
    const occurrenceKey = event.occurrence_id
      ? `${event.instance_id}\u0000${event.occurrence_id}`
      : undefined;
    if (occurrenceKey && this.seenErrorOccurrences.has(occurrenceKey)) {
      this.log?.appendLine(
        `[CodexEventHandler] Ignored replayed Codex error occurrence ${event.occurrence_id}`,
      );
      return;
    }
    await this.presentProtocolError(event, state.cwd);
    if (occurrenceKey) {
      this.remember(this.seenErrorOccurrences, occurrenceKey, MAX_SEEN_ERROR_OCCURRENCES);
    }
  }

  private async onTurnCompleted(event: CodexProtocolEvent): Promise<void> {
    const state = this.currentTurnState(event);
    if (!state || !event.thread_id || !event.turn_id || !event.status) return;
    const turnKey = this.turnKey(event.thread_id, event.turn_id);
    if (this.completedTurns.has(turnKey)) return;
    state.safetyBufferingVisible = false;

    if (event.status === 'interrupted') {
      this.remember(this.completedTurns, turnKey, MAX_COMPLETED_TURNS);
      state.activeTurnId = undefined;
      return;
    }
    if (event.status === 'failed') {
      if (this.errorNotifiedTurns.has(turnKey)) {
        this.remember(this.terminalFailureTurns, turnKey, MAX_COMPLETED_TURNS);
        this.remember(this.completedTurns, turnKey, MAX_COMPLETED_TURNS);
        state.activeTurnId = undefined;
        return;
      }
      await this.presentTerminalError(
        event.thread_id,
        event.turn_id,
        state.cwd,
        event.error ?? { message: 'Codex 任务失败，未提供更多错误信息', code: 'other' },
        event.process_ancestry,
      );
      this.remember(this.completedTurns, turnKey, MAX_COMPLETED_TURNS);
      state.activeTurnId = undefined;
      return;
    }
    if (event.status !== 'completed') return;

    await this.presentCodex({
      title: event.plan_complete ? '[计划完成]' : '[任务完成]',
      message: await this.buildMessage(event.thread_id, state.cwd, event.preview),
      level: 'information',
      sessionId: event.thread_id,
      turnId: event.turn_id,
      eventKey: event.plan_complete ? 'plan-complete' : 'task-complete',
      processAncestry: event.process_ancestry,
    });
    this.remember(this.completedTurns, turnKey, MAX_COMPLETED_TURNS);
    state.activeTurnId = undefined;
  }

  private async presentProtocolError(
    event: CodexProtocolEvent,
    cwd: string | undefined,
  ): Promise<void> {
    if (!event.thread_id || !event.turn_id || !event.error) return;
    const turnKey = this.turnKey(event.thread_id, event.turn_id);
    const details = this.errorPresentationDetails(event.error);
    const occurrenceId = event.occurrence_id ?? `legacy-${++this.legacyErrorOccurrenceSequence}`;
    await this.presentCodex({
      title: details.title,
      message: await this.buildMessage(event.thread_id, cwd, details.message, MAX_ERROR_PREVIEW),
      level: 'error',
      sessionId: event.thread_id,
      turnId: event.turn_id,
      eventKey: `protocol-error:${event.instance_id}:${occurrenceId}`,
      processAncestry: event.process_ancestry,
    });
    this.remember(this.errorNotifiedTurns, turnKey, MAX_COMPLETED_TURNS);
  }

  private async presentTerminalError(
    sessionId: string | undefined,
    turnId: string | undefined,
    cwd: string | undefined,
    error: CodexProtocolError,
    processAncestry: number[] | undefined,
    compatibility = false,
    invocationId?: string,
  ): Promise<void> {
    if (!sessionId || !turnId) return;
    const key = this.turnKey(sessionId, turnId);
    if (this.terminalFailureTurns.has(key)) return;
    if (this.errorNotifiedTurns.has(key)) {
      this.remember(this.terminalFailureTurns, key, MAX_COMPLETED_TURNS);
      return;
    }

    const details = this.errorPresentationDetails(error);
    const message = await this.buildMessage(sessionId, cwd, details.message, MAX_ERROR_PREVIEW);
    if (compatibility && this.monitoring?.isExactForeground(sessionId, invocationId)) return;
    await this.presentCodex({
      title: compatibility ? compatibilityTitle(details.title) : details.title,
      message,
      level: 'error',
      sessionId,
      turnId,
      eventKey: `terminal-error:${turnId}`,
      processAncestry,
    });
    this.remember(this.errorNotifiedTurns, key, MAX_COMPLETED_TURNS);
    this.remember(this.terminalFailureTurns, key, MAX_COMPLETED_TURNS);
  }

  private errorPresentationDetails(error: CodexProtocolError): {
    message: string;
    title: string;
  } {
    const upstream = inspectUpstreamError(error.message);
    const status = error.http_status_code ?? upstream.httpStatusCode;
    const classification = classifyCodexError(error.code, status, upstream.classificationText);
    const message = sanitizeUpstreamError(error.message);
    return {
      message,
      title: classification.title,
    };
  }

  private async watchHookTurn(event: CodexHookEvent): Promise<void> {
    if (!event.session_id || !event.turn_id || !event.transcript_path) return;
    await this.transcriptMonitor.watchTurn({
      ...(event.invocation_id ? { invocationId: event.invocation_id } : {}),
      sessionId: event.session_id,
      turnId: event.turn_id,
      transcriptPath: event.transcript_path,
      ...(event.cwd ? { cwd: event.cwd } : {}),
      ...(event.process_ancestry ? { processAncestry: event.process_ancestry } : {}),
    });
  }

  private enqueueTranscriptFailure(failure: CodexTranscriptTerminalFailure): void {
    const work = this.chain.then(() => this.handleTranscriptFailure(failure));
    this.chain = work.catch((error) => {
      this.log?.appendLine(
        `[CodexEventHandler] Failed to process transcript terminal error: ${formatError(error)}`,
      );
    });
  }

  private async handleTranscriptFailure(failure: CodexTranscriptTerminalFailure): Promise<void> {
    this.log?.appendLine(
      `[CodexEventHandler] Transcript terminal error turn=${failure.turnId} code=${failure.error.code ?? 'unknown'}`,
    );
    if (failure.processAncestry) {
      await this.notifications.trackCodexSession(failure.sessionId, failure.processAncestry);
    }
    if (this.monitoring?.isExactForeground(failure.sessionId, failure.invocationId)) return;
    this.monitoring?.observeHook(failure.sessionId, failure.invocationId);
    await this.presentTerminalError(
      failure.sessionId,
      failure.turnId,
      failure.cwd,
      failure.error,
      failure.processAncestry,
      true,
      failure.invocationId,
    );
  }

  private async presentAttention(
    event: CodexHookEvent,
    title: string,
    eventKey: string,
  ): Promise<void> {
    const requestKey = this.hookRequestKey(event);
    if (requestKey && this.seenRequests.has(requestKey)) return;
    const message = await this.buildMessage(event.session_id, event.cwd);
    if (this.isProtocolAuthoritativeHook(event)) return;
    await this.presentCodex({
      title: compatibilityTitle(title),
      message,
      level: 'information',
      sessionId: event.session_id,
      turnId: event.turn_id,
      eventKey: event.request_id ? `${eventKey}:${event.request_id}` : eventKey,
      processAncestry: event.process_ancestry,
    });
    if (requestKey) this.remember(this.seenRequests, requestKey, MAX_SEEN_REQUESTS);
  }

  private isProtocolAuthoritativeHook(event: CodexHookEvent): boolean {
    const sessionId = event.session_id;
    return sessionId !== undefined && this.monitoring !== undefined
      ? this.monitoring.isExactForeground(sessionId, event.invocation_id)
      : Boolean(
          event.protocol_authoritative ||
          (sessionId !== undefined && this.authoritativeSessions.has(sessionId)),
        );
  }

  private async readPersistedStop(event: CodexHookEvent): Promise<CodexTranscriptInfo> {
    let transcript: CodexTranscriptInfo = {
      isPlanMode: false,
      hasPlanItem: false,
      completionObserved: false,
    };
    const delays =
      event.transcript_path && event.turn_id
        ? STOP_PERSISTENCE_DELAYS_MS
        : STOP_PERSISTENCE_DELAYS_MS.slice(0, 1);
    for (const waitMs of delays) {
      await delay(waitMs);
      transcript = await this.metadata.readTranscript(event.transcript_path, event.turn_id);
      if (transcript.completionObserved || transcript.terminalError) break;
    }
    return transcript;
  }

  private async presentCodex(options: {
    title: string;
    message: string;
    level: NotificationLevel;
    sessionId?: string;
    turnId?: string;
    eventKey: string;
    processAncestry?: number[];
  }): Promise<void> {
    const payload: NotificationPayload = {
      title: options.title,
      message: options.message,
      level: options.level,
      display_hint: 'system',
      icon: 'ICON_CODEX',
      source: 'codex',
      ...(options.sessionId ? { session_id: options.sessionId } : {}),
      ...(options.turnId ? { turn_id: options.turnId } : {}),
      event_key: boundEventKey(options.eventKey),
      ...(options.processAncestry ? { process_ancestry: options.processAncestry } : {}),
    };
    const result = await this.notifications.handle(payload);
    if (!result.ok) {
      throw new Error(result.details ?? result.error ?? 'notification delivery failed');
    }
  }

  private async buildMessage(
    sessionId: string | undefined,
    cwd: string | undefined,
    answer?: string,
    answerLimit?: number,
  ): Promise<string> {
    const state = sessionId ? this.threads.get(sessionId) : undefined;
    const parts = await this.metadata.resolvePreviewParts(sessionId, state?.cwd ?? cwd, answer);
    const limit = normalizePreviewLength(this.config.codexPreviewLength);
    const title = truncateCanonicalText(parts.sessionTitle ?? state?.sessionTitle, limit);
    const response = truncateCanonicalText(parts.answer, answerLimit ?? limit);
    const fallback = truncateCanonicalText(parts.cwdName, limit) ?? 'Codex';
    const preview = title ? [title, response].filter(Boolean) : [response ?? fallback];
    return `${os.hostname()} | ${preview.join(' | ')}`;
  }

  private currentTurnState(
    event: CodexProtocolEvent,
    allowMissingActiveTurn = false,
  ): ThreadState | undefined {
    if (!event.thread_id || !event.turn_id) return undefined;
    if (this.completedTurns.has(this.turnKey(event.thread_id, event.turn_id))) {
      this.log?.appendLine(
        `[CodexEventHandler] Ignored completed-turn ${event.method} for turn ${event.turn_id}`,
      );
      return undefined;
    }
    const state = this.getThreadState(event.thread_id);
    state.instanceId ??= event.instance_id;
    if (state.activeTurnId && state.activeTurnId !== event.turn_id) {
      this.log?.appendLine(
        `[CodexEventHandler] Ignored stale ${event.method} for turn ${event.turn_id}`,
      );
      return undefined;
    }
    if (!state.activeTurnId && allowMissingActiveTurn) {
      state.activeTurnId = event.turn_id;
    } else if (!state.activeTurnId && event.method !== 'turn/completed') {
      state.activeTurnId = event.turn_id;
    }
    return state;
  }

  private hookRequestKey(event: CodexHookEvent): string | undefined {
    return event.request_id
      ? `hook\u0000${event.invocation_id ?? ''}\u0000${event.session_id ?? ''}\u0000${event.request_id}`
      : undefined;
  }

  private getThreadState(threadId: string): ThreadState {
    const existing = this.threads.get(threadId);
    if (existing) return existing;
    const state: ThreadState = { safetyBufferingVisible: false };
    this.setThreadState(threadId, state);
    return state;
  }

  private setThreadState(threadId: string, state: ThreadState): void {
    this.threads.delete(threadId);
    this.threads.set(threadId, state);
    while (this.threads.size > MAX_THREAD_STATES) {
      const oldest = this.threads.keys().next().value;
      if (oldest === undefined) break;
      this.threads.delete(oldest);
      this.authoritativeSessions.delete(oldest);
    }
  }

  private removeInstance(instanceId: string): void {
    for (const [threadId, state] of this.threads) {
      if (state.instanceId !== instanceId) continue;
      this.transcriptMonitor.unwatchSession(threadId);
      this.threads.delete(threadId);
      this.authoritativeSessions.delete(threadId);
    }
  }

  private remember(map: Map<string, true>, key: string, maxSize: number): void {
    map.delete(key);
    map.set(key, true);
    while (map.size > maxSize) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) return;
      map.delete(oldest);
    }
  }

  private turnKey(threadId: string, turnId: string): string {
    return `${threadId}\u0000${turnId}`;
  }
}

export function classifyCodexError(
  code: CodexErrorCode | undefined,
  httpStatusCode?: number,
  message?: string,
): {
  title: string;
} {
  if (
    code === 'httpConnectionFailed' ||
    code === 'responseStreamConnectionFailed' ||
    code === 'responseStreamDisconnected' ||
    code === 'responseTooManyFailedAttempts'
  ) {
    if (httpStatusCode === 401 || httpStatusCode === 403) {
      return { title: '[登录失效]' };
    }
    if (httpStatusCode === 413) {
      return { title: '[上下文已满]' };
    }
    if (httpStatusCode === 402 || httpStatusCode === 429) {
      return { title: '[额度不足]' };
    }
    if (httpStatusCode !== undefined && httpStatusCode >= 500) {
      return { title: '[模型服务错误]' };
    }
    if (
      httpStatusCode !== undefined &&
      httpStatusCode >= 400 &&
      httpStatusCode < 500 &&
      httpStatusCode !== 407 &&
      httpStatusCode !== 408 &&
      httpStatusCode !== 425 &&
      httpStatusCode !== 499
    ) {
      return { title: '[请求或配置错误]' };
    }
    return { title: '[网络错误]' };
  }

  if (code === undefined || code === 'other') {
    const inferred = classifyCodexErrorMessage(message);
    if (inferred) return inferred;
    const statusClassification = classifyUnstructuredHttpStatus(httpStatusCode);
    if (statusClassification) return statusClassification;
  }

  switch (code) {
    case 'usageLimitExceeded':
    case 'sessionBudgetExceeded':
      return { title: '[额度不足]' };
    case 'contextWindowExceeded':
      return { title: '[上下文已满]' };
    case 'unauthorized':
      return { title: '[登录失效]' };
    case 'serverOverloaded':
    case 'internalServerError':
      return { title: '[模型服务错误]' };
    case 'sandboxError':
    case 'cyberPolicy':
      return { title: '[沙箱或策略错误]' };
    case 'badRequest':
      return { title: '[请求或配置错误]' };
    case 'threadRollbackFailed':
      return { title: '[会话恢复失败]' };
    case 'activeTurnNotSteerable':
      return { title: '[Codex 状态冲突]' };
    default:
      return { title: '[Codex 错误]' };
  }
}

function classifyCodexErrorMessage(message: string | undefined): { title: string } | undefined {
  const normalized = cleanVisibleText(
    message?.slice(0, MAX_ERROR_INSPECTION_LENGTH),
  )?.toLowerCase();
  if (!normalized) return undefined;
  if (
    /\b(?:usage|rate)\s*limits?(?:ed| exceeded)?\b|insufficient[_ -]?quota|\bquota\b|\bcredits?\b|too many requests|(?:session|billing) budget|billing hard limit|(?:http|status(?: code)?)\s*429\b/.test(
      normalized,
    )
  ) {
    return { title: '[额度不足]' };
  }
  if (
    /context window|maximum context length|context length exceeded|too many (?:input )?tokens|input exceeds (?:the )?(?:model )?context|(?:prompt|input) (?:is )?too long|reduce the length of (?:the )?messages|(?:http|status(?: code)?)\s*413\b/.test(
      normalized,
    )
  ) {
    return { title: '[上下文已满]' };
  }
  if (
    /\bunauthorized\b|\bnot authorized\b|authentication failed|login (?:expired|required)|must be logged in|(?:access |auth )?token (?:has )?expired|(?:invalid|incorrect|missing) api key|\b(?:http|status(?: code)?)\s*40[13]\b|\b403 forbidden\b/.test(
      normalized,
    )
  ) {
    return { title: '[登录失效]' };
  }
  if (
    /(?:the\s+)?['"`]?[a-z0-9._-]+['"`]?\s+model is not supported|model (?:is )?(?:not supported|not found|does not exist)|(?:unsupported|unknown|invalid) model|model_not_found|(?:do not|does not|don't) have access to (?:the )?model|model (?:is )?not available (?:for|on)/.test(
      normalized,
    )
  ) {
    return { title: '[模型不可用]' };
  }
  if (
    /max[_ -]?output[_ -]?tokens|maximum output (?:token|length)|incomplete response.{0,80}(?:max[_ -]?output[_ -]?tokens|length)/.test(
      normalized,
    )
  ) {
    return { title: '[响应长度受限]' };
  }
  if (
    /server (?:is )?overloaded|(?:selected )?model is at capacity|currently experiencing high demand|service unavailable|internal server error|temporarily unavailable|upstream server error|server had an error|bad gateway|gateway timeout|(?:http|status(?: code)?)\s*5\d\d\b/.test(
      normalized,
    )
  ) {
    return { title: '[模型服务错误]' };
  }
  if (
    /stream (?:disconnected|closed|error|terminated)|error sending request(?: for url)?|connection (?:closed|error|failed|lost|reset|refused|terminated|timed out)|failed to connect|network error|transport error|request (?:timed out|timeout)|operation timed out|deadline (?:has )?(?:elapsed|exceeded)|error decoding response body|unexpected (?:eof|end of file)|broken pipe|socket hang up|peer closed|reconnect attempts? exhausted|too many failed attempts|failed to fetch|empty reply|channel closed|disconnect\/reset before headers|\b(?:econnreset|econnrefused|etimedout|enotfound)\b|\bdns (?:error|lookup|resolution)\b|\b(?:ssl|tls) (?:error|handshake|certificate)\b|http\/?2 (?:protocol )?error|name resolution|getaddrinfo|certificate (?:error|verify|verification|expired)|proxy (?:error|authentication|required|connect)|tunnel (?:error|failed)/.test(
      normalized,
    )
  ) {
    return { title: '[网络错误]' };
  }
  if (
    /sandbox error|blocked by (?:security )?policy|cyber policy|content policy|policy violation|rejected (?:by|as a result of) (?:our )?safety system/.test(
      normalized,
    )
  ) {
    return { title: '[沙箱或策略错误]' };
  }
  if (/thread rollback failed|failed to roll back|session restore failed/.test(normalized)) {
    return { title: '[会话恢复失败]' };
  }
  if (/active turn (?:is )?not steerable|turn cannot be steered/.test(normalized)) {
    return { title: '[Codex 状态冲突]' };
  }
  if (
    /invalid[_ -]?request(?:_error)?|\bbad request\b|malformed request|unsupported (?:parameter|option)|invalid (?:parameter|option)|(?:http|status(?: code)?)\s*4(?:00|04|09|22)\b/.test(
      normalized,
    )
  ) {
    return { title: '[请求或配置错误]' };
  }
  return undefined;
}

export function sanitizeUpstreamError(message: string): string {
  const details = inspectUpstreamError(message);
  const cleaned =
    cleanVisibleText(details.message)
      ?.replace(
        /\b((?:authorization|proxy-authorization|x-api-key|api[_ -]?key|access[_ -]?token|token|secret|password|cookie)\s*[:=]\s*)"?(?:Bearer\s+)?[A-Za-z0-9._~+/=-]{6,}"?/gi,
        '$1[已隐藏]',
      )
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [已隐藏]')
      .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gi, '[已隐藏的密钥]')
      .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[已隐藏]@')
      .replace(
        /([?&](?:access[_-]?token|api[_-]?key|auth(?:orization)?|token|key|secret|password|signature)=)[^&#\s"']+/gi,
        '$1[已隐藏]',
      ) ?? '未知错误';
  return truncateVisible(cleaned, MAX_ERROR_PREVIEW) ?? '未知错误';
}

interface InspectedUpstreamError {
  message: string;
  classificationText: string;
  httpStatusCode?: number;
}

function inspectUpstreamError(message: string): InspectedUpstreamError {
  const bounded = message.slice(0, MAX_ERROR_INSPECTION_LENGTH);
  const fallback = cleanVisibleText(bounded) ?? '未知错误';
  const trimmed = bounded.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return { message: fallback, classificationText: fallback };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { message: fallback, classificationText: fallback };
  }
  if (!isRecord(parsed)) return { message: fallback, classificationText: fallback };

  const nested = isRecord(parsed.error) ? parsed.error : undefined;
  const extractedMessage = firstVisibleString([
    nested?.message,
    nested?.detail,
    typeof parsed.error === 'string' ? parsed.error : undefined,
    parsed.message,
    parsed.detail,
  ]);
  const errorType = firstVisibleString([nested?.type, nested?.code, parsed.type, parsed.code]);
  const httpStatusCode = firstHttpStatusCode([
    parsed.status,
    parsed.statusCode,
    parsed.status_code,
    parsed.httpStatusCode,
    parsed.http_status_code,
    nested?.status,
    nested?.statusCode,
    nested?.status_code,
    nested?.httpStatusCode,
    nested?.http_status_code,
  ]);
  const visibleMessage = extractedMessage ?? fallback;
  return {
    message: visibleMessage,
    classificationText: [visibleMessage, errorType].filter(Boolean).join(' '),
    ...(httpStatusCode ? { httpStatusCode } : {}),
  };
}

function classifyUnstructuredHttpStatus(
  httpStatusCode: number | undefined,
): { title: string } | undefined {
  if (httpStatusCode === 401 || httpStatusCode === 403) return { title: '[登录失效]' };
  if (httpStatusCode === 402 || httpStatusCode === 429) return { title: '[额度不足]' };
  if (httpStatusCode === 413) return { title: '[上下文已满]' };
  if (httpStatusCode !== undefined && httpStatusCode >= 500) {
    return { title: '[模型服务错误]' };
  }
  if (
    httpStatusCode === 407 ||
    httpStatusCode === 408 ||
    httpStatusCode === 425 ||
    httpStatusCode === 499
  ) {
    return { title: '[网络错误]' };
  }
  if (httpStatusCode !== undefined && httpStatusCode >= 400 && httpStatusCode < 500) {
    return { title: '[请求或配置错误]' };
  }
  return undefined;
}

function firstVisibleString(values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const cleaned = cleanVisibleText(value);
    if (cleaned) return cleaned;
  }
  return undefined;
}

function firstHttpStatusCode(values: unknown[]): number | undefined {
  for (const value of values) {
    const numeric =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && /^\d{3}$/.test(value.trim())
          ? Number(value)
          : Number.NaN;
    if (Number.isSafeInteger(numeric) && numeric >= 100 && numeric <= 599) return numeric;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requestNotificationDetails(method: CodexProtocolRequestMethod): { title: string } {
  switch (method) {
    case 'item/tool/requestUserInput':
      return { title: '[等待回答]' };
    case 'item/commandExecution/requestApproval':
    case 'execCommandApproval':
      return { title: '[等待命令授权]' };
    case 'item/fileChange/requestApproval':
    case 'applyPatchApproval':
      return { title: '[等待文件授权]' };
    case 'item/permissions/requestApproval':
      return { title: '[等待权限确认]' };
    case 'mcpServer/elicitation/request':
      return { title: '[等待 MCP 回答]' };
  }
}

function stripPlanTags(value: string | undefined): string | undefined {
  return value?.replace(/<\/?proposed_plan\s*>/gi, '');
}

function normalizePreviewLength(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(100, Math.floor(value))) : 16;
}

function boundEventKey(value: string): string {
  if (value.length <= 200) return value;
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 16);
  return `${value.slice(0, 182)}:${digest}`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
