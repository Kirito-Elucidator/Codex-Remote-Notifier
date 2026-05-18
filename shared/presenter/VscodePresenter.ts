import * as vscode from 'vscode';
import { NotificationPayload, NotificationLevel } from '../types';
import { NotificationPresenter } from '../NotificationPresenter';

export class VscodePresenter implements NotificationPresenter {
  constructor(private readonly log?: vscode.OutputChannel) {}

  async present(payload: NotificationPayload): Promise<string | undefined> {
    const level: NotificationLevel = payload.level ?? 'information';
    const message = payload.title ? `[${payload.title}] ${payload.message}` : payload.message;

    this.log?.appendLine(`[VscodePresenter] Showing ${level}: ${message}`);

    switch (level) {
      case 'warning':
        vscode.window.showWarningMessage(message);
        break;
      case 'error':
        vscode.window.showErrorMessage(message);
        break;
      default:
        vscode.window.showInformationMessage(message);
        break;
    }

    return undefined;
  }
}
