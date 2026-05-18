import * as vscode from 'vscode';

import {
  COMMAND_SHOW_NOTIFICATION,
  NotificationPayload,
  NotificationPresenter,
} from 'remote-notifier-shared';

export class CommandPresenter implements NotificationPresenter {
  constructor(
    private readonly fallback: NotificationPresenter,
    private readonly log?: vscode.OutputChannel,
  ) {}

  async present(payload: NotificationPayload): Promise<string | undefined> {
    this.log?.appendLine(`[CommandPresenter] Dispatching to presenter: ${JSON.stringify(payload)}`);

    try {
      const result = await vscode.commands.executeCommand<string | undefined>(
        COMMAND_SHOW_NOTIFICATION,
        payload,
      );
      this.log?.appendLine(`[CommandPresenter] Presenter command succeeded (result: ${result})`);
      return result;
    } catch (err) {
      this.log?.appendLine(
        `[CommandPresenter] Presenter command FAILED: ${err}. Using fallback VscodePresenter.`,
      );
      return this.fallback.present(payload);
    }
  }
}
