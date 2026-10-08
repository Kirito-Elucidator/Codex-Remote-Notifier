import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { SessionManager } from '../../src/session/SessionManager';
import { createMockExtensionContext } from '../helpers/vscode-mock';
import { SessionInfo } from 'remote-notifier-shared';
import { workspace } from 'vscode';

describe('SessionManager Integration', () => {
  let sessionManager: SessionManager;
  let testDir: string;
  let sessionFilePath: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rn-test-'));
    sessionFilePath = path.join(testDir, 'session.json');
    const context = createMockExtensionContext();
    sessionManager = new SessionManager(context as never, { sessionFilePath });
  });

  afterEach(async () => {
    await sessionManager.dispose();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('generates a 64-character hex token', () => {
    expect(sessionManager.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('generates unique tokens', () => {
    const context2 = createMockExtensionContext();
    const other = new SessionManager(context2 as never, {
      sessionFilePath: path.join(testDir, 'session2.json'),
    });
    expect(sessionManager.token).not.toBe(other.token);
  });

  it('writes session file on initialize', async () => {
    await sessionManager.initialize(4000);
    const content = await fs.readFile(sessionFilePath, 'utf-8');
    const info: SessionInfo = JSON.parse(content);
    expect(info.port).toBe(4000);
    expect(info.token).toBe(sessionManager.token);
    expect(info.pid).toBe(process.pid);
    expect(info.createdAt).toBeDefined();
    expect(info.workspaceFolders).toEqual(['/test/workspace']);
    expect(info.workspaceKey).toMatch(/^[0-9a-f]{32}$/);
  });

  it('does not let a late publication from the old activation replace a reloaded window route', async () => {
    const scoped = path.join(testDir, 'same-window.json');
    const old = new SessionManager(createMockExtensionContext() as never, {
      sessionFilePath: scoped,
      legacySessionFilePath: path.join(testDir, 'old-legacy.json'),
      routingId: 'window',
    });
    const current = new SessionManager(createMockExtensionContext() as never, {
      sessionFilePath: scoped,
      legacySessionFilePath: path.join(testDir, 'new-legacy.json'),
      routingId: 'window',
    });
    await old.initialize(4000);
    await current.initialize(5000);
    await old.publishCodexRouting(4000, [{ pid: 123, identity: 'old-process' }], {
      mode: 'compatibility',
      sidecarPath: '/old/sidecar.js',
      shimDirectory: '/old/shim',
    });
    expect(JSON.parse(await fs.readFile(scoped, 'utf8')).port).toBe(5000);
    await old.dispose();
    await current.dispose();
  });

  it.skipIf(process.platform === 'win32')('sets correct file permissions (0600)', async () => {
    await sessionManager.initialize(4000);
    const stats = await fs.stat(sessionFilePath);
    const mode = stats.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('creates parent directory if not exists', async () => {
    const nestedPath = path.join(testDir, 'sub', 'dir', 'session.json');
    const context = createMockExtensionContext();
    const mgr = new SessionManager(context as never, { sessionFilePath: nestedPath });
    await mgr.initialize(4000);
    const stats = await fs.stat(path.dirname(nestedPath));
    expect(stats.isDirectory()).toBe(true);
    await mgr.dispose();
  });

  it('removes session file on dispose', async () => {
    await sessionManager.initialize(4000);
    await sessionManager.dispose();
    await expect(fs.access(sessionFilePath)).rejects.toThrow();
  });

  it('regenerateToken updates token and file', async () => {
    await sessionManager.initialize(4000);
    const originalToken = sessionManager.token;
    await sessionManager.regenerateToken(4000);
    expect(sessionManager.token).not.toBe(originalToken);
    const content = await fs.readFile(sessionFilePath, 'utf-8');
    const info: SessionInfo = JSON.parse(content);
    expect(info.token).toBe(sessionManager.token);
  });

  it('sets environment variables on initialize', async () => {
    const context = createMockExtensionContext();
    const mgr = new SessionManager(context as never, {
      sessionFilePath: path.join(testDir, 'env-test.json'),
    });
    await mgr.initialize(5000);

    expect(context.environmentVariableCollection.replace).toHaveBeenCalledWith(
      'REMOTE_NOTIFIER_PORT',
      '5000',
    );
    expect(context.environmentVariableCollection.replace).toHaveBeenCalledWith(
      'REMOTE_NOTIFIER_TOKEN',
      mgr.token,
    );
    expect(context.environmentVariableCollection.replace).toHaveBeenCalledWith(
      'REMOTE_NOTIFIER_URL',
      'http://127.0.0.1:5000/notify',
    );
    expect(context.environmentVariableCollection.replace).toHaveBeenCalledWith(
      'REMOTE_NOTIFIER_SESSION_FILE',
      path.join(testDir, 'env-test.json'),
    );
    expect(context.environmentVariableCollection.replace).toHaveBeenCalledWith(
      'REMOTE_NOTIFIER_CODEX_PREVIEW_LENGTH',
      '16',
    );
    await mgr.dispose();
  });

  it('persists the configured Codex preview length', async () => {
    const context = createMockExtensionContext();
    const mgr = new SessionManager(context as never, {
      sessionFilePath: path.join(testDir, 'preview.json'),
      codexPreviewLength: 24,
    });
    await mgr.initialize(5000);

    const info: SessionInfo = JSON.parse(
      await fs.readFile(path.join(testDir, 'preview.json'), 'utf-8'),
    );
    expect(info.codexPreviewLength).toBe(24);
    expect(context.environmentVariableCollection.replace).toHaveBeenCalledWith(
      'REMOTE_NOTIFIER_CODEX_PREVIEW_LENGTH',
      '24',
    );
    await mgr.dispose();
  });

  it('updates and clamps the Codex preview length', async () => {
    const context = createMockExtensionContext();
    const previewPath = path.join(testDir, 'preview-update.json');
    const mgr = new SessionManager(context as never, {
      sessionFilePath: previewPath,
      codexPreviewLength: 16,
    });
    await mgr.initialize(5000);
    await mgr.updateCodexPreviewLength(500, 5000);

    const info: SessionInfo = JSON.parse(await fs.readFile(previewPath, 'utf-8'));
    expect(info.codexPreviewLength).toBe(100);
    expect(context.environmentVariableCollection.replace).toHaveBeenLastCalledWith(
      'REMOTE_NOTIFIER_CODEX_PREVIEW_LENGTH',
      '100',
    );
    await mgr.dispose();
  });

  it('cleans up stale session file with dead PID', async () => {
    // Write a session file with a PID that doesn't exist
    const staleInfo: SessionInfo = {
      port: 9999,
      token: 'stale_token',
      pid: 999999,
      workspaceFolder: '/tmp',
      createdAt: new Date().toISOString(),
    };
    await fs.writeFile(sessionFilePath, JSON.stringify(staleInfo));

    await sessionManager.initialize(4000);

    const content = await fs.readFile(sessionFilePath, 'utf-8');
    const info: SessionInfo = JSON.parse(content);
    expect(info.pid).toBe(process.pid);
    expect(info.token).toBe(sessionManager.token);
  });

  it('preserves session file with live PID (current process)', async () => {
    // Write a session file with current process PID
    const liveInfo: SessionInfo = {
      port: 9999,
      token: 'live_token',
      pid: process.pid,
      workspaceFolder: '/tmp',
      createdAt: new Date().toISOString(),
    };
    await fs.writeFile(sessionFilePath, JSON.stringify(liveInfo));

    // The manager still overwrites it because it's initializing
    await sessionManager.initialize(4000);
    const content = await fs.readFile(sessionFilePath, 'utf-8');
    const info: SessionInfo = JSON.parse(content);
    // File should be overwritten with new data
    expect(info.port).toBe(4000);
  });

  it('writes both scoped and legacy session files when their paths differ', async () => {
    const scopedPath = path.join(testDir, 'sessions', 'workspace.json');
    const legacyPath = path.join(testDir, 'session.json');
    const context = createMockExtensionContext();
    const mgr = new SessionManager(context as never, {
      sessionFilePath: scopedPath,
      legacySessionFilePath: legacyPath,
    });

    await mgr.initialize(5000);

    const scoped: SessionInfo = JSON.parse(await fs.readFile(scopedPath, 'utf-8'));
    const legacy: SessionInfo = JSON.parse(await fs.readFile(legacyPath, 'utf-8'));
    expect(scoped).toEqual(legacy);
    expect(context.environmentVariableCollection.replace).toHaveBeenCalledWith(
      'REMOTE_NOTIFIER_SESSION_FILE',
      scopedPath,
    );
    await mgr.dispose();
  });

  it('does not remove a legacy session file that another window has replaced', async () => {
    const scopedPath = path.join(testDir, 'sessions', 'workspace.json');
    const legacyPath = path.join(testDir, 'session.json');
    const context = createMockExtensionContext();
    const mgr = new SessionManager(context as never, {
      sessionFilePath: scopedPath,
      legacySessionFilePath: legacyPath,
    });
    await mgr.initialize(5000);
    await fs.writeFile(
      legacyPath,
      JSON.stringify({
        port: 6000,
        token: 'another-window',
        pid: process.pid,
        workspaceFolder: '/another/workspace',
        createdAt: new Date().toISOString(),
      } satisfies SessionInfo),
      'utf-8',
    );

    await mgr.dispose();

    await expect(fs.access(scopedPath)).rejects.toThrow();
    const legacy: SessionInfo = JSON.parse(await fs.readFile(legacyPath, 'utf-8'));
    expect(legacy.token).toBe('another-window');
  });

  it('isolates same-workspace windows and refreshes the same file after reload', async () => {
    const context = createMockExtensionContext();
    const first = new SessionManager(context as never, { routingId: 'a'.repeat(32) });
    const second = new SessionManager(context as never, { routingId: 'b'.repeat(32) });
    const reloaded = new SessionManager(context as never, { routingId: 'a'.repeat(32) });
    expect(first.getSessionFilePath()).not.toBe(second.getSessionFilePath());
    expect(reloaded.getSessionFilePath()).toBe(first.getSessionFilePath());
  });

  it('keeps the inherited locator after workspace folders change', () => {
    const context = createMockExtensionContext();
    const options = { routingId: 'a'.repeat(32) };
    const first = new SessionManager(context as never, options);
    workspace.workspaceFolders.push({
      uri: { fsPath: '/additional', toString: () => '/additional' },
    });
    try {
      expect(new SessionManager(context as never, options).getSessionFilePath()).toBe(
        first.getSessionFilePath(),
      );
    } finally {
      workspace.workspaceFolders.pop();
    }
  });

  it('keeps the window locator across shutdown and publishes a complete replacement on reload', async () => {
    const context = createMockExtensionContext();
    const scoped = path.join(testDir, 'window.json');
    const options = {
      routingId: 'a'.repeat(32),
      sessionFilePath: scoped,
      legacySessionFilePath: path.join(testDir, 'legacy.json'),
    };
    const old = new SessionManager(context as never, options);
    await old.initialize(5100);
    await old.dispose();
    expect(JSON.parse(await fs.readFile(scoped, 'utf-8')).port).toBe(5100);
    const reloaded = new SessionManager(context as never, options);
    await reloaded.initialize(5200);
    expect(JSON.parse(await fs.readFile(scoped, 'utf-8'))).toMatchObject({
      port: 5200,
      token: reloaded.token,
    });
    await reloaded.dispose();
  });
});
