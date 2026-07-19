export type NotificationLevel = 'information' | 'warning' | 'error';
export type DisplayHint = 'app' | 'system';

export interface NotificationPayload {
  message: string;
  title?: string;
  level?: NotificationLevel;
  display_hint?: DisplayHint;
  icon?: string;
  sound?: string;
  source?: string;
  session_id?: string;
  turn_id?: string;
  event_key?: string;
  process_ancestry?: number[];
  codex_focus_command?: string;
}

export type CodexHookEventName =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'Stop'
  | 'PreToolUse'
  | 'PermissionRequest';

export interface CodexHookEvent {
  version: 1;
  kind: 'hook';
  hook_event_name: CodexHookEventName;
  session_id?: string;
  turn_id?: string;
  request_id?: string;
  cwd?: string;
  transcript_path?: string;
  last_assistant_message?: string;
  tool_name?: string;
  protocol_authoritative?: boolean;
  process_ancestry?: number[];
}

export type CodexProtocolRequestMethod =
  | 'item/commandExecution/requestApproval'
  | 'item/fileChange/requestApproval'
  | 'item/tool/requestUserInput'
  | 'item/permissions/requestApproval'
  | 'mcpServer/elicitation/request'
  | 'applyPatchApproval'
  | 'execCommandApproval';

export type CodexProtocolMethod =
  | 'session/started'
  | 'session/ended'
  | 'thread/started'
  | 'turn/started'
  | 'turn/completed'
  | 'model/safetyBuffering/updated'
  | 'serverRequest/resolved'
  | 'error'
  | CodexProtocolRequestMethod;

export type CodexErrorCode =
  | 'contextWindowExceeded'
  | 'sessionBudgetExceeded'
  | 'usageLimitExceeded'
  | 'serverOverloaded'
  | 'cyberPolicy'
  | 'httpConnectionFailed'
  | 'responseStreamConnectionFailed'
  | 'internalServerError'
  | 'unauthorized'
  | 'badRequest'
  | 'threadRollbackFailed'
  | 'sandboxError'
  | 'responseStreamDisconnected'
  | 'responseTooManyFailedAttempts'
  | 'activeTurnNotSteerable'
  | 'other';

export interface CodexProtocolError {
  message: string;
  code?: CodexErrorCode;
  http_status_code?: number;
}

export interface CodexProtocolEvent {
  version: 1;
  kind: 'protocol';
  method: CodexProtocolMethod;
  instance_id: string;
  thread_id?: string;
  turn_id?: string;
  request_id?: string | number;
  occurrence_id?: string;
  process_ancestry?: number[];
  cwd?: string;
  session_title?: string;
  show_buffering_ui?: boolean;
  will_retry?: boolean;
  status?: 'completed' | 'interrupted' | 'failed' | 'inProgress';
  error?: CodexProtocolError;
  preview?: string;
  plan_complete?: boolean;
}

export type CodexEvent = CodexHookEvent | CodexProtocolEvent;

export interface CodexFocusRequest {
  session_id: string;
}

export interface CodexFocusResult {
  ok: boolean;
  reason: 'focused' | 'session-not-mapped' | 'terminal-not-found' | 'invalid-request';
  terminal_name?: string;
}

export interface SessionInfo {
  port: number;
  token: string;
  pid: number;
  workspaceFolder: string;
  workspaceFolders?: string[];
  workspaceKey?: string;
  createdAt: string;
  codexPreviewLength?: number;
}

export interface NotificationResponse {
  ok: boolean;
  id?: string;
  error?: string;
  details?: string;
}
