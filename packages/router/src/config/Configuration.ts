import * as vscode from 'vscode';

import { NotificationLevel } from 'remote-notifier-shared';

export class Configuration {
  private get config() {
    return vscode.workspace.getConfiguration('remoteNotifier');
  }

  get enabled(): boolean {
    return this.config.get('enabled', true);
  }

  get port(): number {
    return this.config.get('port', 0);
  }

  get maxBodySize(): number {
    return this.config.get('maxBodySize', 65536);
  }

  get notificationLevel(): NotificationLevel {
    return this.config.get('notificationLevel', 'information');
  }

  get showTimestamp(): boolean {
    return this.config.get('showTimestamp', false);
  }
}
