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
