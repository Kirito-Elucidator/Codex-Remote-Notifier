export type NotificationLevel = 'information' | 'warning' | 'error';
export type DisplayHint = 'app' | 'system';

export interface NotificationPayload {
  message: string;
  title?: string;
  level?: NotificationLevel;
  display_hint?: DisplayHint;
  icon?: string;
  sound?: string;
}

export interface SessionInfo {
  port: number;
  token: string;
  pid: number;
  workspaceFolder: string;
  createdAt: string;
}

export interface NotificationResponse {
  ok: boolean;
  id?: string;
  error?: string;
  details?: string;
}
