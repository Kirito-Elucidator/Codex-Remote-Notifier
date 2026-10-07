import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockExtensionContext, env, workspace } from 'vscode';

import { resolveWindowRoutingId } from '../../src/session/WindowRoutingIdentity';

describe('window routing identity', () => {
  beforeEach(() => vi.clearAllMocks());

  it('survives extension reload without sharing identity with another window of the same workspace', async () => {
    const context = createMockExtensionContext();
    vi.mocked(env.asExternalUri).mockResolvedValue({
      toString: () => 'vscode://ddyndo.remote-notifier-codex/window?windowId=17',
    } as never);
    const first = await resolveWindowRoutingId(context as never);
    expect(await resolveWindowRoutingId(context as never)).toBe(first);
    vi.mocked(env.asExternalUri).mockResolvedValue({
      toString: () => 'vscode://ddyndo.remote-notifier-codex/window?windowId=18',
    } as never);
    expect(await resolveWindowRoutingId(context as never)).not.toBe(first);
  });

  it('does not reuse an ambiguous identity when the host cannot provide a window-bound URI', async () => {
    const context = createMockExtensionContext();
    vi.mocked(env.asExternalUri).mockRejectedValue(new Error('unavailable'));
    expect(await resolveWindowRoutingId(context as never)).not.toBe(
      await resolveWindowRoutingId(context as never),
    );
  });

  it('keeps the same window route after adding a workspace folder', async () => {
    const context = createMockExtensionContext();
    vi.mocked(env.asExternalUri).mockResolvedValue({
      toString: () => 'vscode://ddyndo.remote-notifier-codex/window?windowId=17',
    } as never);
    const initial = await resolveWindowRoutingId(context as never);
    workspace.workspaceFolders.push({
      uri: { fsPath: '/additional', toString: () => '/additional' },
    });
    try {
      expect(await resolveWindowRoutingId(context as never)).toBe(initial);
    } finally {
      workspace.workspaceFolders.pop();
    }
  });
});
