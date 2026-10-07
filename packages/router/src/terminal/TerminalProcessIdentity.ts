import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export async function readTerminalProcessIdentity(processId: number): Promise<string | undefined> {
  if (!Number.isSafeInteger(processId) || processId <= 0) return undefined;
  try {
    if (process.platform === 'linux') {
      const [stat, boot] = await Promise.all([
        fs.readFile(`/proc/${processId}/stat`, 'utf8'),
        fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
      ]);
      // comm may contain spaces and parentheses; starttime is field 22 after the final ')'.
      const start = stat
        .slice(stat.lastIndexOf(')') + 2)
        .trim()
        .split(/\s+/)[19];
      if (/^\d+$/.test(start) && /^[0-9a-f-]+$/.test(boot.trim())) {
        return `${boot.trim()}:${start}`;
      }
    } else if (process.platform === 'win32') {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$ErrorActionPreference = 'Stop'; [System.Diagnostics.Process]::GetProcessById(${processId}).StartTime.ToUniversalTime().Ticks`,
        ],
        { timeout: 3000, maxBuffer: 4096, windowsHide: true },
      );
      const start = stdout.trim();
      if (/^\d+$/.test(start)) return start;
    }
  } catch {
    // Without a start identity, a live Terminal reference is usable but PID-only reload recovery is not.
  }
  return undefined;
}
