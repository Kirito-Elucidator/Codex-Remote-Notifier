import * as vscode from 'vscode';

import { NotificationPayload, NotificationPresenter } from 'remote-notifier-shared';

const DEFAULT_MAX_NOTIFICATIONS = 5;
const DEFAULT_WINDOW_MS = 15_000;

export class RateLimitedPresenter implements NotificationPresenter {
  private timestamps: number[] = [];
  private suppressedCount = 0;
  private suppressedMessage: vscode.Disposable | null = null;
  private resetTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly inner: NotificationPresenter,
    private readonly maxNotifications = DEFAULT_MAX_NOTIFICATIONS,
    private readonly windowMs = DEFAULT_WINDOW_MS,
  ) {}

  async present(payload: NotificationPayload): Promise<string | undefined> {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);

    if (this.timestamps.length >= this.maxNotifications) {
      this.onSuppressed();
      return undefined;
    }

    this.timestamps.push(now);
    return this.inner.present(payload);
  }

  private onSuppressed(): void {
    this.suppressedCount++;
    this.showSuppressedWarning();
    this.scheduleReset();
  }

  private showSuppressedWarning(): void {
    this.suppressedMessage?.dispose();
    const count = this.suppressedCount;
    const s = count === 1 ? '' : 's';
    this.suppressedMessage = vscode.window.setStatusBarMessage(
      `$(bell-slash) Remote Notifier: ${count} notification${s} suppressed (rate limit)`,
      this.windowMs,
    );
  }

  private scheduleReset(): void {
    if (this.resetTimer) return;
    this.resetTimer = setTimeout(() => {
      this.resetTimer = null;
      this.suppressedCount = 0;
    }, this.windowMs);
  }

  dispose(): void {
    this.suppressedMessage?.dispose();
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }
  }
}
