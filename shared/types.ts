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

export interface NotificationPresenter {
  present(payload: NotificationPayload): Promise<string | undefined>;
}

export interface NotificationResponse {
  ok: boolean;
  id?: string;
  error?: string;
  details?: string;
}

export const COMMAND_ENSURE_ROUTER_STARTED = 'remoteNotifier.ensureRouterStarted';
export const COMMAND_SHOW_NOTIFICATION = 'remoteNotifier.showNotification';
export const COMMAND_SHOW_SESSION_INFO = 'remoteNotifier.showSessionInfo';
export const COMMAND_REGENERATE_TOKEN = 'remoteNotifier.regenerateToken';
export const COMMAND_COPY_NOTIFY_COMMAND = 'remoteNotifier.copyNotifyCommand';

export const SESSION_DIR = '.remote-notifier';
export const SESSION_FILE = 'session.json';

export const COMMAND_INSTALL_SCRIPT = 'remoteNotifier.installScript';

export const COMMAND_AUTO_CONFIGURE = 'remoteNotifier.autoConfigure';
export const COMMAND_TEST_VSCODE = 'remoteNotifier.testVscodeNotification';
export const COMMAND_TEST_SYSTEM = 'remoteNotifier.testSystemNotification';

export const ENV_PORT = 'REMOTE_NOTIFIER_PORT';
export const ENV_TOKEN = 'REMOTE_NOTIFIER_TOKEN';
export const ENV_URL = 'REMOTE_NOTIFIER_URL';
