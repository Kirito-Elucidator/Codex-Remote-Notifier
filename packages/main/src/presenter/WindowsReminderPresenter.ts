import * as cp from 'child_process';

import reminderScript from './windows-reminder.ps1';

export interface WindowsReminderOptions {
  title: string;
  message: string;
  iconPath: string;
  silent: boolean;
}

const APP_ID = 'Remote Notifier';
const LAUNCH_URI = 'vscode://ddyndo.remote-notifier-codex/notification';

export class WindowsReminderPresenter {
  async present(options: WindowsReminderOptions): Promise<void> {
    const encodedScript = Buffer.from(reminderScript, 'utf16le').toString('base64');
    const env = {
      ...process.env,
      RN_REMINDER_TITLE: options.title,
      RN_REMINDER_MESSAGE: options.message,
      RN_REMINDER_ICON: options.iconPath,
      RN_REMINDER_SILENT: options.silent ? '1' : '0',
      RN_REMINDER_APP_ID: APP_ID,
      RN_REMINDER_LAUNCH_URI: LAUNCH_URI,
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
        (error) => (error ? reject(error) : resolve()),
      );
    });
  }
}
