import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  resolveCodexStartupRoute,
  resolveTmuxStartupAncestry,
} from '../../src/session/CodexStartupRoute';

describe('Codex startup terminal routing', () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  async function directory(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'notifier-startup-route-'));
    directories.push(dir);
    return dir;
  }

  function record(pid: number, identity: string, port = 12345) {
    return {
      port,
      token: 'a'.repeat(64),
      pid: 800,
      createdAt: new Date().toISOString(),
      terminalProcesses: [{ pid, identity }],
      codexLauncher: {
        mode: 'compatibility',
        sidecarPath: '/extension/dist/codex-notifier-sidecar.js',
        shimDirectory: '/storage/codex-shim',
      },
    };
  }

  it('uses attached tmux clients instead of the detached server ancestor for startup routing', async () => {
    expect(
      await resolveTmuxStartupAncestry([701, 700, 50], {
        find: async () => ({ socket: '/tmp/tmux/default', pane: '%7', panePid: 700 }),
        clients: async () => [{ ancestry: [900, 800] }, { ancestry: [901, 801] }],
      }),
    ).toEqual([900, 800, 901, 801]);
  });

  it('does not route a detached tmux pane to the terminal that originally started its server', async () => {
    expect(
      await resolveTmuxStartupAncestry([701, 700, 50], {
        find: async () => ({ socket: '/tmp/tmux/default', pane: '%7', panePid: 700 }),
        clients: async () => [],
      }),
    ).toEqual([]);
  });

  it('retains direct ancestry when inherited tmux metadata does not identify the current pane', async () => {
    const clients = vi.fn();
    expect(
      await resolveTmuxStartupAncestry([111], { find: async () => undefined, clients }),
    ).toEqual([111]);
    expect(clients).not.toHaveBeenCalled();
  });

  it('recovers the owning window when a newly created startup terminal inherited an expired workspace route', async () => {
    const dir = await directory();
    const wrong = path.join(dir, 'persisted-workspace.json');
    const current = path.join(dir, 'current-window.json');
    await fs.writeFile(wrong, JSON.stringify(record(222, 'other-terminal', 9999)));
    await fs.writeFile(current, JSON.stringify(record(111, 'startup-terminal')));

    const route = await resolveCodexStartupRoute({
      directories: [dir],
      inheritedSessionFile: wrong,
      ancestry: [333, 111, 444],
      readIdentity: vi.fn(async (pid) => (pid === 111 ? 'startup-terminal' : undefined)),
      healthy: vi.fn(async () => true),
    });

    expect(route?.sessionFile).toBe(current);
    expect(route?.info.port).toBe(12345);
  });

  it('does not accept an alive inherited route owned by another window opening the same workspace', async () => {
    const dir = await directory();
    const wrong = path.join(dir, 'other-window.json');
    await fs.writeFile(wrong, JSON.stringify(record(222, 'other-terminal')));

    await expect(
      resolveCodexStartupRoute({
        directories: [dir],
        inheritedSessionFile: wrong,
        ancestry: [111],
        readIdentity: async () => 'startup-terminal',
        healthy: async () => true,
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects reused terminal PIDs and unavailable routers', async () => {
    const dir = await directory();
    await fs.writeFile(path.join(dir, 'reused.json'), JSON.stringify(record(111, 'old-process')));
    await fs.writeFile(
      path.join(dir, 'stopped.json'),
      JSON.stringify(record(111, 'new-process', 9999)),
    );

    await expect(
      resolveCodexStartupRoute({
        directories: [dir],
        ancestry: [111],
        readIdentity: async () => 'new-process',
        healthy: async (info) => info.port !== 9999,
      }),
    ).resolves.toBeUndefined();
  });

  it('fails closed when multiple windows claim the same live terminal', async () => {
    const dir = await directory();
    for (const name of ['a', 'b'])
      await fs.writeFile(path.join(dir, `${name}.json`), JSON.stringify(record(111, 'process')));

    await expect(
      resolveCodexStartupRoute({
        directories: [dir],
        ancestry: [111],
        readIdentity: async () => 'process',
        healthy: async () => true,
      }),
    ).resolves.toBeUndefined();
  });
});
