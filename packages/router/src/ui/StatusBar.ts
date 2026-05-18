import * as vscode from 'vscode';

import { COMMAND_SHOW_SESSION_INFO } from 'remote-notifier-shared';

export class StatusBar implements vscode.Disposable {
  private item: vscode.StatusBarItem;

  constructor(port: number) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = COMMAND_SHOW_SESSION_INFO;
    this.update(port);
    this.item.show();
  }

  update(port: number): void {
    this.item.text = `$(bell) Notifier`;
    this.item.tooltip = `Remote Notifier active on http://127.0.0.1:${port}`;
  }

  dispose(): void {
    this.item.dispose();
  }
}
