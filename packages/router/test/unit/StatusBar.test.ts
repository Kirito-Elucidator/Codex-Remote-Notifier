import { describe, it, expect, vi, beforeEach } from 'vitest';
import { window, StatusBarAlignment } from 'vscode';
import { StatusBar } from '../../src/ui/StatusBar';

describe('StatusBar', () => {
  let statusBar: StatusBar;
  let mockItem: ReturnType<typeof window.createStatusBarItem>;

  beforeEach(() => {
    vi.clearAllMocks();
    statusBar = new StatusBar(3000);
    mockItem = vi.mocked(window.createStatusBarItem).mock.results[0].value;
  });

  it('creates a left-aligned status bar item', () => {
    expect(window.createStatusBarItem).toHaveBeenCalledWith(StatusBarAlignment.Left, 100);
  });

  it('shows the status bar item', () => {
    expect(mockItem.show).toHaveBeenCalled();
  });

  it('displays bell icon with port', () => {
    expect(mockItem.text).toBe('$(bell) Notifier');
  });

  it('sets tooltip with URL', () => {
    expect(mockItem.tooltip).toBe('Remote Notifier active on http://127.0.0.1:3000');
  });

  it('sets command to showSessionInfo', () => {
    expect(mockItem.command).toBe('remoteNotifier.showSessionInfo');
  });

  it('update changes text and tooltip', () => {
    statusBar.update(5000);
    expect(mockItem.text).toBe('$(bell) Notifier');
    expect(mockItem.tooltip).toBe('Remote Notifier active on http://127.0.0.1:5000');
  });

  it('shows the aggregate Codex monitoring mode and bounded counts', () => {
    statusBar.updateMonitoring({
      monitoring: 'compatibility',
      exact: 1,
      compatibility: 2,
      unavailable: 0,
      degraded: 0,
    });

    expect(mockItem.text).toBe('$(bell) Notifier: Compatibility');
    expect(mockItem.tooltip).toBe(
      'Remote Notifier active on http://127.0.0.1:3000\nCodex monitoring: Compatibility (exact 1, compatibility 2, unavailable 0, degraded 0)',
    );
  });

  it.each([
    ['exact', 'Exact'],
    ['unavailable', 'Notifier unavailable'],
    ['degraded', 'Monitoring degraded'],
  ] as const)('renders %s monitoring honestly', (monitoring, label) => {
    statusBar.updateMonitoring({
      monitoring,
      exact: monitoring === 'exact' ? 1 : 0,
      compatibility: 0,
      unavailable: monitoring === 'unavailable' ? 1 : 0,
      degraded: monitoring === 'degraded' ? 1 : 0,
    });

    expect(mockItem.text).toBe(`$(bell) Notifier: ${label}`);
    expect(String(mockItem.tooltip)).toContain(`Codex monitoring: ${label}`);
  });

  it('dispose disposes the underlying item', () => {
    statusBar.dispose();
    expect(mockItem.dispose).toHaveBeenCalled();
  });
});
