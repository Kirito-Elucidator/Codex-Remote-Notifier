import * as vscode from 'vscode';

import { COMMAND_SHOW_SESSION_INFO } from 'remote-notifier-shared';

import type { CodexMonitoringSummary } from '../codex/CodexMonitoringStatus';

export class StatusBar implements vscode.Disposable {
  private item: vscode.StatusBarItem;
  private monitoring?: CodexMonitoringSummary;
  private port: number;

  constructor(port: number) {
    this.port = port;
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = COMMAND_SHOW_SESSION_INFO;
    this.update(port);
    this.item.show();
  }

  update(port: number): void {
    this.port = port;
    this.render();
  }

  updateMonitoring(monitoring: CodexMonitoringSummary): void {
    this.monitoring = monitoring;
    this.render();
  }

  dispose(): void {
    this.item.dispose();
  }

  private render(): void {
    const base = `Remote Notifier active on http://127.0.0.1:${this.port}`;
    if (this.monitoring === undefined) {
      this.item.text = '$(bell) Notifier';
      this.item.tooltip = base;
      return;
    }
    const label = monitoringLabel(this.monitoring.monitoring);
    this.item.text = `$(bell) Notifier: ${label}`;
    this.item.tooltip = `${base}\nCodex monitoring: ${label} (exact ${this.monitoring.exact}, compatibility ${this.monitoring.compatibility}, unavailable ${this.monitoring.unavailable}, degraded ${this.monitoring.degraded})`;
  }
}

function monitoringLabel(monitoring: CodexMonitoringSummary['monitoring']): string {
  switch (monitoring) {
    case 'exact':
      return 'Exact';
    case 'compatibility':
      return 'Compatibility';
    case 'unavailable':
      return 'Notifier unavailable';
    case 'degraded':
      return 'Monitoring degraded';
  }
}
