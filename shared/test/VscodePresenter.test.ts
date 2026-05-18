import * as vscode from 'vscode';
import { window } from 'vscode';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { VscodePresenter } from '../presenter/VscodePresenter';

describe('VscodePresenter', () => {
  let presenter: VscodePresenter;
  let mockLog: vscode.OutputChannel;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLog = {
      appendLine: vi.fn(),
    } as unknown as vscode.OutputChannel;
    presenter = new VscodePresenter(mockLog);
  });

  it('calls showInformationMessage for information level', async () => {
    await presenter.present({ message: 'hello', level: 'information' });
    expect(window.showInformationMessage).toHaveBeenCalledWith('hello');
  });

  it('calls showWarningMessage for warning level', async () => {
    await presenter.present({ message: 'hello', level: 'warning' });
    expect(window.showWarningMessage).toHaveBeenCalledWith('hello');
  });

  it('calls showErrorMessage for error level', async () => {
    await presenter.present({ message: 'hello', level: 'error' });
    expect(window.showErrorMessage).toHaveBeenCalledWith('hello');
  });

  it('defaults to information when no level', async () => {
    await presenter.present({ message: 'hello' });
    expect(window.showInformationMessage).toHaveBeenCalledWith('hello');
  });

  it('prepends title', async () => {
    await presenter.present({ message: 'done', title: 'Build' });
    expect(window.showInformationMessage).toHaveBeenCalledWith('[Build] done');
  });

  it('logs the message to OutputChannel', async () => {
    await presenter.present({ message: 'hello', level: 'warning', title: 'App' });
    expect(mockLog.appendLine).toHaveBeenCalledWith(
      '[VscodePresenter] Showing warning: [App] hello',
    );
  });

  it('returns immediately without waiting for user interaction', async () => {
    let resolved = false;
    vi.mocked(window.showInformationMessage).mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolved = true;
            resolve(undefined as never);
          }, 100_000);
        }),
    );
    const result = await presenter.present({ message: 'hi' });
    expect(result).toBeUndefined();
    expect(resolved).toBe(false);
  });
});
