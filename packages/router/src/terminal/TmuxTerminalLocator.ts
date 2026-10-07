import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface TmuxTarget {
  socket: string;
  pane: string;
  panePid: number;
}

export interface TmuxClient {
  ancestry: number[];
}

export class TmuxTerminalLocator {
  constructor(
    private readonly readFile = async (file: string) => {
      const handle = await fs.open(file, 'r');
      try {
        const buffer = Buffer.alloc(64 * 1024);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return buffer.subarray(0, bytesRead).toString('utf8');
      } finally {
        await handle.close();
      }
    },
    private readonly run = async (args: string[]) =>
      (
        await execFileAsync('tmux', args, {
          timeout: 700,
          maxBuffer: 64 * 1024,
          windowsHide: true,
        })
      ).stdout,
  ) {}

  async find(ancestry: number[]): Promise<TmuxTarget | undefined> {
    for (const pid of ancestry) {
      const raw = await this.readFile(`/proc/${pid}/environ`).catch(() => '');
      const env = new Map(
        raw.split('\0').map((entry) => {
          const separator = entry.indexOf('=');
          return [entry.slice(0, separator), entry.slice(separator + 1)];
        }),
      );
      const value = env.get('TMUX');
      const pane = env.get('TMUX_PANE');
      const socket = value?.replace(/,\d+,\d+$/, '');
      if (!socket || !path.posix.isAbsolute(socket) || !pane || !/^%\d+$/.test(pane)) continue;
      const target = { socket, pane, panePid: 0 };
      const info = await this.paneInfo(target).catch(() => undefined);
      if (info && ancestry.includes(info.pid)) return { ...target, panePid: info.pid };
    }
    return undefined;
  }

  async clients(target: TmuxTarget): Promise<TmuxClient[]> {
    try {
      const info = await this.paneInfo(target);
      if (!info || info.pid !== target.panePid) return [];
      const output = await this.run([
        '-S',
        target.socket,
        'list-clients',
        '-t',
        info.session,
        '-F',
        '#{client_pid}',
      ]);
      const clients: TmuxClient[] = [];
      for (const line of output.trim().split('\n')) {
        let pid = Number(line);
        const ancestry: number[] = [];
        while (
          Number.isSafeInteger(pid) &&
          pid > 1 &&
          ancestry.length < 24 &&
          !ancestry.includes(pid)
        ) {
          ancestry.push(pid);
          const stat = await this.readFile(`/proc/${pid}/stat`).catch(() => '');
          pid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[1]);
        }
        if (ancestry.length) clients.push({ ancestry });
      }
      return clients;
    } catch {
      return [];
    }
  }

  async activate(target: TmuxTarget): Promise<boolean> {
    try {
      const info = await this.paneInfo(target);
      if (!info || info.pid !== target.panePid) return false;
      await this.run(['-S', target.socket, 'select-window', '-t', info.window]);
      await this.run(['-S', target.socket, 'select-pane', '-t', target.pane]);
      return true;
    } catch {
      return false;
    }
  }

  private async paneInfo(target: TmuxTarget) {
    const output = await this.run([
      '-S',
      target.socket,
      'display-message',
      '-p',
      '-t',
      target.pane,
      '#{pane_id}\t#{pane_pid}\t#{session_id}\t#{window_id}',
    ]);
    const [pane, pid, session, window] = output.trim().split('\t');
    if (
      pane !== target.pane ||
      !/^\$\d+$/.test(session) ||
      !/^@\d+$/.test(window) ||
      !/^\d+$/.test(pid)
    )
      return undefined;
    return { pid: Number(pid), session, window };
  }
}
