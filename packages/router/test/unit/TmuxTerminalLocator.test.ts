import { describe, expect, it, vi } from 'vitest';

import { TmuxTerminalLocator } from '../../src/terminal/TmuxTerminalLocator';

const target = { socket: '/tmp/tmux-1000/default', pane: '%7', panePid: 700 };

function fixture() {
  const read = vi.fn(async (file: string) => {
    if (file === '/proc/701/environ') return 'TMUX=/tmp/tmux-1000/default,50,0\0TMUX_PANE=%7\0';
    if (file === '/proc/900/stat') return '900 (tmux client) S 800 0';
    if (file === '/proc/800/stat') return '800 (bash) S 1 0';
    return '';
  });
  const run = vi.fn(async (args: string[]) => {
    if (args.includes('display-message')) return '%7\t700\t$3\t@4\n';
    if (args.includes('list-clients')) return '900\n';
    return '';
  });
  return { run, locator: new TmuxTerminalLocator(read, run) };
}

describe('TmuxTerminalLocator', () => {
  it('bridges the detached server ancestry to the attached client terminal', async () => {
    const { locator } = fixture();
    expect(await locator.find([701, 700, 50])).toEqual(target);
    expect(await locator.clients(target)).toEqual([{ ancestry: [900, 800] }]);
  });

  it('selects both the originating window and pane without creating another session', async () => {
    const { locator, run } = fixture();
    expect(await locator.activate(target)).toBe(true);
    expect(run.mock.calls.slice(-2)).toEqual([
      [['-S', target.socket, 'select-window', '-t', '@4']],
      [['-S', target.socket, 'select-pane', '-t', '%7']],
    ]);
  });

  it('rejects a reused pane id or unrelated inherited pane environment', async () => {
    const { locator, run } = fixture();
    expect(await locator.find([701, 50])).toBeUndefined();
    expect(await locator.activate({ ...target, panePid: 999 })).toBe(false);
    expect(run.mock.calls.every(([args]) => !args.includes('select-pane'))).toBe(true);
  });
});
