import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockExtensionContext, window } from 'vscode';

import { NotificationPresenter } from 'remote-notifier-shared';

import { Configuration } from '../../src/config/Configuration';
import { NotificationHandler } from '../../src/handler/NotificationHandler';
import { NotificationServer } from '../../src/server/NotificationServer';
import { CodexTerminalFocusRegistry } from '../../src/terminal/CodexTerminalFocusRegistry';
import { sendNotification } from '../helpers/http-client';

describe('Codex terminal routing integration', () => {
  const focusCommand = `remoteNotifier.focusCodexSession.${'b'.repeat(32)}`;
  let server: NotificationServer | undefined;
  let registry: CodexTerminalFocusRegistry | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    window.terminals.splice(0);
  });

  afterEach(async () => {
    registry?.dispose();
    await server?.stop();
  });

  it('maps an authenticated hook request to an existing terminal before presenting it', async () => {
    const terminal = {
      name: 'Codex session terminal',
      processId: Promise.resolve(5150),
      show: vi.fn(),
    };
    window.terminals.push(terminal);
    const context = createMockExtensionContext();
    registry = new CodexTerminalFocusRegistry(context.workspaceState as never);
    const presenter: NotificationPresenter = { present: vi.fn().mockResolvedValue(undefined) };
    const config = {
      port: 0,
      maxBodySize: 65536,
      enabled: true,
      notificationLevel: 'information',
      showTimestamp: false,
    } as unknown as Configuration;
    const handler = new NotificationHandler(presenter, config, registry, focusCommand);
    server = new NotificationServer(handler, config);
    const token = 'routing-test-token';
    await server.start(token);

    const response = await sendNotification(server.port, token, {
      message: 'Done',
      source: 'codex',
      session_id: 'session-http',
      turn_id: 'turn-http',
      event_key: 'task-complete',
      process_ancestry: [7000, 6000, 5150, 4000],
    });
    const focusResult = await registry.focus({ session_id: 'session-http' });

    expect(response.status).toBe(200);
    expect(focusResult).toMatchObject({ ok: true, terminal_name: 'Codex session terminal' });
    expect(terminal.show).toHaveBeenCalledWith(false);
    expect(presenter.present).toHaveBeenCalledWith(
      expect.objectContaining({ codex_focus_command: focusCommand }),
    );
    expect(presenter.present).toHaveBeenCalledWith(
      expect.not.objectContaining({ process_ancestry: expect.anything() }),
    );
  });
});
