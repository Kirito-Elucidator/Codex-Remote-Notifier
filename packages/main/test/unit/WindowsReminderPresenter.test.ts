import * as cp from 'child_process';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  chooseWindowsNotificationScenario,
  FULLSCREEN_NOTIFICATION_STATES,
  WindowsReminderPresenter,
} from '../../src/presenter/WindowsReminderPresenter';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

describe('chooseWindowsNotificationScenario', () => {
  it.each([2, 3, 4])('uses urgent for blocked notification state %i', (state) => {
    expect(chooseWindowsNotificationScenario(state, 22621, true)).toBe('urgent');
  });

  it.each([1, 5, 6, 7])('keeps reminder for non-fullscreen state %i', (state) => {
    expect(chooseWindowsNotificationScenario(state, 22621, true)).toBe('reminder');
  });

  it('falls back on unsupported Windows builds or when disabled', () => {
    expect(chooseWindowsNotificationScenario(3, 22000, true)).toBe('reminder');
    expect(chooseWindowsNotificationScenario(3, 22621, false)).toBe('reminder');
    expect([...FULLSCREEN_NOTIFICATION_STATES]).toEqual([2, 3, 4]);
  });
});

describe('WindowsReminderPresenter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(cp.execFile).mockImplementation((...args: any[]) => {
      args[3](null, '', '');
      return {} as any;
    });
  });

  it('passes the urgent preference through a hidden PowerShell process', async () => {
    const presenter = new WindowsReminderPresenter();

    await presenter.present({
      title: '<Done>',
      message: 'A&B',
      iconPath: 'C:\\icon.png',
      silent: false,
      launchUri: 'vscode://remote-notifier/session',
      urgentWhenFullscreen: true,
    });

    expect(cp.execFile).toHaveBeenCalledWith(
      'powershell.exe',
      expect.arrayContaining(['-NoProfile', '-NonInteractive', '-EncodedCommand']),
      expect.objectContaining({
        windowsHide: true,
        timeout: 5000,
        env: expect.objectContaining({
          RN_REMINDER_TITLE: '<Done>',
          RN_REMINDER_MESSAGE: 'A&B',
          RN_REMINDER_FULLSCREEN_URGENT: '1',
        }),
      }),
      expect.any(Function),
    );
  });

  it('embeds QUNS detection, build fallback, and XML escaping in the script', async () => {
    const presenter = new WindowsReminderPresenter();
    await presenter.present({
      title: 'Done',
      message: 'Ready',
      iconPath: 'C:\\icon.png',
      silent: true,
      launchUri: 'vscode://remote-notifier/session',
      urgentWhenFullscreen: false,
    });

    const args = vi.mocked(cp.execFile).mock.calls[0][1] as string[];
    const encoded = args[args.indexOf('-EncodedCommand') + 1];
    const script = Buffer.from(encoded, 'base64').toString('utf16le');
    expect(script).toContain('SHQueryUserNotificationState');
    expect(script).toContain('public static class NativeMethods');
    expect(script).toContain("$scenario = 'urgent'");
    expect(script).toContain('22546');
    expect(script).toContain('SecurityElement]::Escape');
  });

  it('records PowerShell diagnostics and propagates launch failures', async () => {
    const log = { appendLine: vi.fn() };
    vi.mocked(cp.execFile).mockImplementationOnce((...args: any[]) => {
      args[3](new Error('failed'), 'important notifications unavailable', 'stderr detail');
      return {} as any;
    });
    const presenter = new WindowsReminderPresenter(log as never);

    await expect(
      presenter.present({
        title: 'Done',
        message: 'Ready',
        iconPath: 'C:\\icon.png',
        silent: true,
        launchUri: 'vscode://remote-notifier/session',
        urgentWhenFullscreen: true,
      }),
    ).rejects.toThrow('failed');
    expect(log.appendLine).toHaveBeenCalledWith(
      '[WindowsReminder] important notifications unavailable',
    );
    expect(log.appendLine).toHaveBeenCalledWith('[WindowsReminder] stderr detail');
  });
});
