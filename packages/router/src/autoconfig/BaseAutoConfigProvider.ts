import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';

import { OutputChannel, window } from 'vscode';

import { SCRIPT_NAME } from '../installer/CodeNotifyScriptInstaller';
import { AutoConfigProvider } from './AutoConfigProvider';

const execFileAsync = promisify(execFile);

export type Platform = 'unix' | 'windows';

export interface ProcessStats {
  added: number;
  updated: number;
  skipped: number;
}

export interface ProcessResult {
  modifiedFiles: Map<string, string>;
  stats: ProcessStats;
}

export abstract class BaseAutoConfigProvider implements AutoConfigProvider {
  abstract readonly id: string;
  abstract readonly label: string;
  abstract readonly description: string;

  constructor(protected readonly log?: OutputChannel) {}

  async configure(): Promise<void> {
    const platform: Platform = process.platform === 'win32' ? 'windows' : 'unix';

    const configFiles = this.getConfigFiles();
    const loaded = new Map<string, string>();

    for (const filePath of configFiles) {
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        loaded.set(filePath, content);
      } catch (err) {
        if (!this.handleMissingFile(filePath, err)) {
          return;
        }
      }
    }

    const useJq = platform === 'unix' && (await this.checkJqAvailable());
    if (useJq === null && platform === 'unix') {
      return;
    }

    const result = await this.processConfigs(loaded, platform, !!useJq);
    if (!result) {
      return;
    }

    if (result.stats.added === 0 && result.stats.updated === 0) {
      window.showInformationMessage(`${this.label} is already configured. No changes made.`);
      return;
    }

    for (const [filePath, content] of result.modifiedFiles) {
      try {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content, 'utf-8');
        this.log?.appendLine(`[${this.id}] Successfully wrote ${filePath}`);
      } catch (err) {
        window.showErrorMessage(`Failed to write configuration to ${filePath}: ${err}`);
        return;
      }
    }

    this.showSuccessMessage(result.stats);
  }

  /**
   * Returns a list of absolute paths to configuration files that should be loaded.
   */
  protected abstract getConfigFiles(): string[];

  /**
   * Processes the loaded configuration files and returns the modified content and stats.
   * If null is returned, the configuration process is aborted.
   */
  protected abstract processConfigs(
    loaded: Map<string, string>,
    platform: Platform,
    useJq: boolean,
  ): Promise<ProcessResult | null>;

  /**
   * Hook for handling missing files. Return true to continue, false to abort.
   */
  protected handleMissingFile(filePath: string, error: unknown): boolean {
    window.showErrorMessage(
      `Could not find ${this.label} settings at ${filePath}. Please ensure it is installed and has been run at least once.`,
    );
    this.log?.appendLine(
      `[${this.id}] Could not find ${this.label} settings at ${filePath}. Error: ${error}`,
    );
    return false;
  }

  protected getCommandPath(platform: Platform): string {
    if (platform === 'windows') {
      return `%LOCALAPPDATA%\\RemoteNotifier\\bin\\${SCRIPT_NAME}.cmd`;
    }
    return `~/.local/bin/${SCRIPT_NAME}`;
  }

  protected async checkJqAvailable(): Promise<boolean | null> {
    try {
      await execFileAsync(process.platform === 'win32' ? 'where' : 'which', ['jq']);
      return true;
    } catch {
      const choice = await window.showWarningMessage(
        'jq is not installed. Some notification hooks can extract more information with jq. Continue without jq?',
        'Use simple notification',
        'Cancel',
      );
      if (choice === 'Use simple notification') {
        return false;
      }
      return null;
    }
  }

  protected showSuccessMessage(stats: ProcessStats): void {
    const parts: string[] = [];
    if (stats.added > 0) parts.push(`${stats.added} added`);
    if (stats.updated > 0) parts.push(`${stats.updated} updated`);
    if (stats.skipped > 0) parts.push(`${stats.skipped} unchanged`);

    window.showInformationMessage(`${this.label} configured successfully (${parts.join(', ')}).`);
  }
}
