import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { window } from 'vscode';

import { TerminalRoutePublisher } from '../../src/session/TerminalRoutePublisher';
import { readTerminalProcessIdentity } from '../../src/terminal/TerminalProcessIdentity';

vi.mock('../../src/terminal/TerminalProcessIdentity');

describe('terminal ownership publication', () => {
  let publisher: TerminalRoutePublisher | undefined;
  beforeEach(() => {
    vi.clearAllMocks();
    window.terminals = [];
  });
  afterEach(() => {
    publisher?.dispose();
    window.terminals = [];
  });

  it('publishes a terminal that existed before extension activation', async () => {
    window.terminals = [{ processId: Promise.resolve(123) }] as never;
    vi.mocked(readTerminalProcessIdentity).mockResolvedValue('startup-process');
    const publishCodexRouting = vi.fn(async () => {});
    publisher = new TerminalRoutePublisher({ publishCodexRouting } as never, 4000, {
      sidecarPath: '/extension/sidecar.js',
      shimDirectory: '/storage/shim',
    });
    await vi.waitFor(() =>
      expect(publishCodexRouting).toHaveBeenCalledWith(
        4000,
        [{ pid: 123, identity: 'startup-process' }],
        expect.objectContaining({ mode: 'compatibility' }),
      ),
    );
  });

  it('never republishes ownership of a closed terminal after delayed identity discovery', async () => {
    let resolveIdentity!: (identity: string) => void;
    const terminal = { processId: Promise.resolve(123) };
    window.terminals = [terminal] as never;
    vi.mocked(readTerminalProcessIdentity).mockReturnValue(
      new Promise((resolve) => {
        resolveIdentity = resolve;
      }),
    );
    const publishCodexRouting = vi.fn(async () => {});
    publisher = new TerminalRoutePublisher({ publishCodexRouting } as never, 4000, {
      sidecarPath: '/extension/sidecar.js',
      shimDirectory: '/storage/shim',
    });
    await vi.waitFor(() => expect(readTerminalProcessIdentity).toHaveBeenCalled());
    window.terminals = [];
    vi.mocked(window.onDidCloseTerminal).mock.calls.at(-1)?.[0](terminal as never);
    resolveIdentity('closed-process');
    await vi.waitFor(() => expect(publishCodexRouting).toHaveBeenCalled());
    expect(
      publishCodexRouting.mock.calls.every(
        (call) =>
          (call as unknown[])[1] instanceof Array &&
          ((call as unknown[])[1] as unknown[]).length === 0,
      ),
    ).toBe(true);
  });

  it('retries a transient process identity failure instead of caching unavailable forever', async () => {
    window.terminals = [{ processId: Promise.resolve(123) }] as never;
    vi.mocked(readTerminalProcessIdentity)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue('recovered-process');
    const publishCodexRouting = vi.fn(async () => {});
    publisher = new TerminalRoutePublisher({ publishCodexRouting } as never, 4000, {
      sidecarPath: '/extension/sidecar.js',
      shimDirectory: '/storage/shim',
    });
    await vi.waitFor(
      () =>
        expect(publishCodexRouting).toHaveBeenCalledWith(
          4000,
          [{ pid: 123, identity: 'recovered-process' }],
          expect.objectContaining({ mode: 'compatibility' }),
        ),
      { timeout: 2000 },
    );
  });

  it('publishes a ready terminal without waiting for a slow or rejected terminal', async () => {
    let releaseSlow!: (value: string) => void;
    window.terminals = [
      { processId: Promise.resolve(123) },
      { processId: Promise.resolve(456) },
      { processId: Promise.reject(new Error('Terminal closed')) },
    ] as never;
    vi.mocked(readTerminalProcessIdentity).mockImplementation(async (pid) => {
      if (pid === 123) return 'ready-process';
      return new Promise((resolve) => {
        releaseSlow = resolve;
      });
    });
    const publishCodexRouting = vi.fn(async () => {});
    publisher = new TerminalRoutePublisher({ publishCodexRouting } as never, 4000, {
      sidecarPath: '/extension/sidecar.js',
      shimDirectory: '/storage/shim',
    });
    await vi.waitFor(() =>
      expect(publishCodexRouting).toHaveBeenCalledWith(
        4000,
        [{ pid: 123, identity: 'ready-process' }],
        expect.anything(),
      ),
    );
    publisher.dispose();
    releaseSlow('slow-process');
  });
});
