import * as vscode from 'vscode';

import type { SessionInfo } from 'remote-notifier-shared';

import { readTerminalProcessIdentity } from '../terminal/TerminalProcessIdentity';
import { SessionManager } from './SessionManager';

export class TerminalRoutePublisher implements vscode.Disposable {
  private revision = 0;
  private disposed = false;
  private retry?: NodeJS.Timeout;
  private mode: NonNullable<SessionInfo['codexLauncher']>['mode'] = 'compatibility';
  private subscriptions: vscode.Disposable[];
  private identities = new Map<
    vscode.Terminal,
    { pid: number; value: Promise<string | undefined> }
  >();

  constructor(
    private readonly sessions: SessionManager,
    private readonly port: number,
    private readonly launcher: Pick<
      NonNullable<SessionInfo['codexLauncher']>,
      'sidecarPath' | 'shimDirectory'
    >,
    private readonly log?: vscode.OutputChannel,
  ) {
    this.subscriptions = [
      vscode.window.onDidOpenTerminal(() => this.refresh()),
      vscode.window.onDidCloseTerminal((terminal) => {
        this.identities.delete(terminal);
        this.refresh();
      }),
    ];
    this.refresh();
  }

  setMode(mode: typeof this.mode): void {
    this.mode = mode;
    this.refresh();
  }

  refresh(retries = 3): void {
    if (this.disposed) return;
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
    const revision = ++this.revision;
    const terminals = [...vscode.window.terminals];
    const records: Array<{ terminal: vscode.Terminal; pid: number; identity: string } | undefined> =
      new Array(terminals.length);
    const publish = async (complete = false): Promise<void> => {
      if (this.disposed || revision !== this.revision) return;
      const live = new Set(vscode.window.terminals);
      const owners = records.flatMap((record) =>
        record && live.has(record.terminal) ? [{ pid: record.pid, identity: record.identity }] : [],
      );
      await this.sessions.publishCodexRouting(this.port, owners, {
        ...this.launcher,
        mode: this.mode,
      });
      if (!complete) return;
      this.log?.appendLine(
        `[TerminalRouting] Published ${owners.length} verified terminal owner(s)`,
      );
      if (revision === this.revision && owners.length < live.size && retries > 0) {
        this.retry = setTimeout(() => this.refresh(retries - 1), 500);
        this.retry.unref();
      }
    };
    let index = 0;
    const inspect = async (): Promise<void> => {
      while (index < terminals.length) {
        const position = index++;
        const terminal = terminals[position];
        let timeout: NodeJS.Timeout | undefined;
        const pid = await Promise.race([
          Promise.resolve(terminal.processId).catch(() => undefined),
          new Promise<undefined>((resolve) => {
            timeout = setTimeout(resolve, 1500, undefined);
            timeout.unref();
          }),
        ]);
        if (timeout) clearTimeout(timeout);
        if (!pid) continue;
        const cached = this.identities.get(terminal);
        if (cached?.pid !== pid)
          this.identities.set(terminal, { pid, value: readTerminalProcessIdentity(pid) });
        const identity = await this.identities.get(terminal)?.value;
        if (!identity && this.identities.get(terminal)?.pid === pid)
          this.identities.delete(terminal);
        records[position] = identity ? { terminal, pid, identity } : undefined;
        // One slow restored terminal must not delay routing for every other terminal in the window.
        if (identity) await publish();
      }
    };
    void Promise.all(Array.from({ length: Math.min(4, terminals.length) }, () => inspect()))
      .then(() => publish(true))
      .catch(() =>
        this.log?.appendLine('[TerminalRouting] Could not publish verified terminal owners'),
      );
  }

  dispose(): void {
    this.disposed = true;
    if (this.retry) clearTimeout(this.retry);
    this.revision++;
    this.identities.clear();
    for (const subscription of this.subscriptions) subscription.dispose();
  }
}
