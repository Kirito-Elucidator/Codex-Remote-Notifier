import * as cp from 'child_process';

import type * as vscode from 'vscode';

import { deriveDisplayableNotificationText } from 'remote-notifier-shared';

import reminderScript from './windows-reminder.ps1';

export interface WindowsReminderOptions {
  title: string;
  message: string;
  iconPath: string;
  silent: boolean;
  launchUri: string;
  urgentWhenFullscreen: boolean;
}

const APP_ID = 'Remote Notifier';
export const FULLSCREEN_NOTIFICATION_STATES = new Set([2, 3, 4]);

export class WindowsReminderPresenter {
  constructor(private readonly log?: vscode.OutputChannel) {}

  async present(options: WindowsReminderOptions): Promise<void> {
    const encodedScript = Buffer.from(reminderScript, 'utf16le').toString('base64');
    const displayable = deriveDisplayableNotificationText(options.title, options.message);
    const env = {
      ...process.env,
      RN_REMINDER_TITLE: displayable.title,
      RN_REMINDER_MESSAGE: displayable.body,
      RN_REMINDER_ICON: options.iconPath,
      RN_REMINDER_SILENT: options.silent ? '1' : '0',
      RN_REMINDER_APP_ID: APP_ID,
      RN_REMINDER_LAUNCH_URI: options.launchUri,
      RN_REMINDER_FULLSCREEN_URGENT: options.urgentWhenFullscreen ? '1' : '0',
    };

    await new Promise<void>((resolve, reject) => {
      cp.execFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-EncodedCommand',
          encodedScript,
        ],
        { env, timeout: 5000, windowsHide: true },
        (error, stdout, stderr) => {
          for (const line of `${stdout}\n${stderr}`.split(/\r?\n/).filter(Boolean)) {
            this.log?.appendLine(`[WindowsReminder] ${line}`);
          }
          return error ? reject(error) : resolve();
        },
      );
    });
  }
}

export function chooseWindowsNotificationScenario(
  notificationState: number,
  windowsBuild: number,
  urgentEnabled: boolean,
): 'reminder' | 'urgent' {
  return urgentEnabled &&
    windowsBuild >= 22546 &&
    FULLSCREEN_NOTIFICATION_STATES.has(notificationState)
    ? 'urgent'
    : 'reminder';
}
