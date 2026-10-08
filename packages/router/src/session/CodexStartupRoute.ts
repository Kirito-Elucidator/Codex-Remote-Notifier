import * as fs from 'fs/promises';
import * as http from 'http';
import * as path from 'path';

import type { SessionInfo } from 'remote-notifier-shared';

import { readTerminalProcessIdentity } from '../terminal/TerminalProcessIdentity';
import { TmuxTerminalLocator } from '../terminal/TmuxTerminalLocator';

export interface CodexStartupRoute {
  sessionFile: string;
  info: SessionInfo;
}

export interface StartupRouteOptions {
  directories: string[];
  ancestry: number[];
  inheritedSessionFile?: string;
  readIdentity?: (pid: number) => Promise<string | undefined>;
  healthy?: (info: SessionInfo) => Promise<boolean>;
}

export async function resolveTmuxStartupAncestry(
  ancestry: number[],
  locator: Pick<TmuxTerminalLocator, 'find' | 'clients'>,
): Promise<number[]> {
  const target = await locator.find(ancestry);
  if (!target) return ancestry;
  const clients = await locator.clients(target);
  return [...new Set(clients.flatMap((client) => client.ancestry))];
}

export async function resolveCodexStartupRoute(
  options: StartupRouteOptions,
): Promise<CodexStartupRoute | undefined> {
  const ancestors = new Set(options.ancestry.filter((pid) => Number.isSafeInteger(pid) && pid > 1));
  if (ancestors.size === 0) return undefined;
  const files = new Set<string>();
  for (const directory of new Set(options.directories)) {
    for (const name of (await fs.readdir(directory).catch(() => [])).slice(0, 256)) {
      if (name.endsWith('.json')) files.add(path.resolve(directory, name));
    }
  }
  if (options.inheritedSessionFile) files.add(path.resolve(options.inheritedSessionFile));
  const readIdentity = options.readIdentity ?? readTerminalProcessIdentity;
  const identities = new Map<number, Promise<string | undefined>>();
  const candidates: CodexStartupRoute[] = [];
  for (const sessionFile of files) {
    let info: SessionInfo;
    try {
      if ((await fs.stat(sessionFile)).size > 64 * 1024) continue;
      info = JSON.parse(await fs.readFile(sessionFile, 'utf8')) as SessionInfo;
    } catch {
      continue;
    }
    if (!isRoutingRecord(info)) continue;
    for (const owner of info.terminalProcesses ?? []) {
      if (!ancestors.has(owner.pid) || typeof owner.identity !== 'string') continue;
      if (!identities.has(owner.pid)) identities.set(owner.pid, readIdentity(owner.pid));
      if ((await identities.get(owner.pid)) !== owner.identity) continue;
      if (await (options.healthy ?? routerIsHealthy)(info)) candidates.push({ sessionFile, info });
      break;
    }
  }
  // Workspace storage can be shared by two windows; neither a live port nor recency proves ownership.
  return candidates.length === 1 ? candidates[0] : undefined;
}

function isRoutingRecord(info: SessionInfo): boolean {
  return (
    info !== null &&
    typeof info === 'object' &&
    Number.isSafeInteger(info.pid) &&
    info.pid > 1 &&
    Number.isSafeInteger(info.port) &&
    info.port > 0 &&
    info.port <= 65535 &&
    typeof info.token === 'string' &&
    /^[0-9a-f]{64}$/i.test(info.token) &&
    Array.isArray(info.terminalProcesses) &&
    info.terminalProcesses.length <= 128 &&
    info.terminalProcesses.every(
      (owner) =>
        owner !== null &&
        typeof owner === 'object' &&
        Number.isSafeInteger(owner.pid) &&
        owner.pid > 1 &&
        typeof owner.identity === 'string' &&
        owner.identity.length > 0 &&
        owner.identity.length <= 256,
    ) &&
    info.codexLauncher !== undefined &&
    info.codexLauncher !== null &&
    ['protocol', 'compatibility', 'disabled'].includes(info.codexLauncher.mode) &&
    typeof info.codexLauncher.sidecarPath === 'string' &&
    typeof info.codexLauncher.shimDirectory === 'string'
  );
}

async function routerIsHealthy(info: SessionInfo): Promise<boolean> {
  try {
    process.kill(info.pid, 0);
  } catch {
    return false;
  }
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      finish(false);
      request.destroy();
    }, 400);
    const finish = (healthy: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(healthy);
    };
    const request = http.get(
      { hostname: '127.0.0.1', port: info.port, path: '/health' },
      (response) => {
        let body = '';
        response.on('data', (chunk: Buffer) => {
          body += chunk.toString();
          if (body.length > 1024) {
            finish(false);
            request.destroy();
          }
        });
        response.on('end', () => {
          try {
            finish(response.statusCode === 200 && JSON.parse(body).ok === true);
          } catch {
            finish(false);
          }
        });
        response.on('error', () => finish(false));
        response.on('aborted', () => finish(false));
      },
    );
    request.on('error', () => finish(false));
  });
}
