import * as vscode from 'vscode';

import { NotificationPayload, NotificationPresenter } from 'remote-notifier-shared';

export type SystemNotificationMode = 'auto' | 'always' | 'never';

export class FocusAwarePresenter implements NotificationPresenter {
  constructor(
    private readonly focusedPresenter: NotificationPresenter,
    private readonly unfocusedPresenter: NotificationPresenter,
    private readonly log?: vscode.OutputChannel,
  ) {}

  async present(payload: NotificationPayload): Promise<string | undefined> {
    const mode = vscode.workspace
      .getConfiguration('remoteNotifier')
      .get<SystemNotificationMode>('systemNotifications', 'auto');

    const focused = vscode.window.state.focused;
    this.log?.appendLine(
      `[FocusAware] mode=${mode} focused=${focused} display_hint=${payload.display_hint ?? 'none'}`,
    );

    if (mode === 'never') {
      this.log?.appendLine('[FocusAware] -> VscodePresenter (mode=never)');
      return this.focusedPresenter.present(payload);
    }
    if (mode === 'always') {
      this.log?.appendLine('[FocusAware] -> SystemPresenter (mode=always)');
      return this.unfocusedPresenter.present(payload);
    }

    if (payload.display_hint === 'app') {
      this.log?.appendLine('[FocusAware] -> VscodePresenter (display_hint=app)');
      return this.focusedPresenter.present(payload);
    }
    if (payload.display_hint === 'system') {
      this.log?.appendLine('[FocusAware] -> SystemPresenter (display_hint=system)');
      return this.unfocusedPresenter.present(payload);
    }

    if (focused) {
      this.log?.appendLine('[FocusAware] -> VscodePresenter (focused)');
      return this.focusedPresenter.present(payload);
    }
    this.log?.appendLine('[FocusAware] -> SystemPresenter (unfocused)');
    return this.unfocusedPresenter.present(payload);
  }
}
