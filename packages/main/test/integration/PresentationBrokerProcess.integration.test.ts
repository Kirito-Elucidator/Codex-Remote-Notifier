import { ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { build } from 'esbuild';

import { PresentationExchange } from 'remote-notifier-shared';

import { BrokerRuntimePaths, readBrokerDiscovery } from '../../src/broker/BrokerProtocol';
import { PresentationBrokerClient } from '../../src/PresentationBrokerClient';

describe('presentation broker process boundary', () => {
  const children: ChildProcess[] = [];
  const clients: PresentationBrokerClient[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    clients.splice(0).forEach((client) => client.dispose());
    const spawned = children.splice(0);
    for (const child of spawned) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    await Promise.all(
      spawned.map((child) =>
        Promise.race([waitForExit(child), delay(2_000)]).catch(() => undefined),
      ),
    );
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
    );
  });

  it('runs the headless bundle, wins a process launch race, and resets an incompatible epoch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'remote-notifier-process-test-'));
    directories.push(directory);
    const paths = createRuntimePaths(directory);
    const bundle = join(directory, 'presentation-broker.js');
    await build({
      bundle: true,
      entryPoints: [resolve('packages/main/src/presentationBrokerEntry.ts')],
      format: 'cjs',
      logLevel: 'silent',
      loader: { '.ps1': 'text' },
      outfile: bundle,
      platform: 'node',
      target: 'node18',
    });
    expect(await readFile(bundle, 'utf8')).not.toContain('require("vscode")');

    const first = spawnBroker(bundle, paths, 0);
    const second = spawnBroker(bundle, paths, 0);
    const initialDiscovery = await waitForDiscovery(paths);
    expect([first.pid, second.pid]).toContain(initialDiscovery.processId);
    await expect(
      Promise.race([waitForExit(first), waitForExit(second), rejectAfter(2_000)]),
    ).resolves.toBe(0);

    const initialClient = trackClient(
      new PresentationBrokerClient({ paths, protocolVersion: 0, launch: async () => undefined }),
    );
    const exchange = createExchange('process-epoch');
    await expect(initialClient.exchange(exchange)).resolves.toMatchObject({ kind: 'applied' });
    initialClient.dispose();

    let replacement: ChildProcess | undefined;
    const replacingClient = trackClient(
      new PresentationBrokerClient({
        paths,
        protocolVersion: 1,
        launch: async () => {
          replacement = spawnBroker(bundle, paths, 1);
        },
      }),
    );
    const replacementConnection = await replacingClient.start();
    const replacementDiscovery = await waitForDiscovery(paths);

    expect(replacementConnection.epochReset).toBe(true);
    expect(replacementConnection.presentationEpoch).not.toBe(initialDiscovery.presentationEpoch);
    expect(replacementDiscovery.processId).toBe(replacement?.pid);
    await expect(replacingClient.exchange(exchange)).resolves.toMatchObject({ kind: 'applied' });
  });

  function spawnBroker(
    bundle: string,
    paths: BrokerRuntimePaths,
    protocolVersion: number,
  ): ChildProcess {
    const child = spawn(process.execPath, [bundle], {
      env: {
        ...process.env,
        REMOTE_NOTIFIER_BROKER_DISCOVERY_FILE: paths.discoveryFile,
        REMOTE_NOTIFIER_BROKER_PIPE_ADDRESS: paths.pipeAddress,
        REMOTE_NOTIFIER_BROKER_PROTOCOL_VERSION: String(protocolVersion),
      },
      stdio: 'ignore',
      windowsHide: true,
    });
    children.push(child);
    return child;
  }

  function trackClient(client: PresentationBrokerClient): PresentationBrokerClient {
    clients.push(client);
    return client;
  }
});

function createRuntimePaths(directory: string): BrokerRuntimePaths {
  const id = randomUUID();
  return {
    discoveryFile: join(directory, 'discovery.json'),
    pipeAddress:
      process.platform === 'win32'
        ? `\\\\.\\pipe\\remote-notifier-process-${id}`
        : join(directory, 'broker.sock'),
  };
}

function createExchange(transactionId: string): PresentationExchange {
  return {
    kind: 'apply',
    transactionId,
    mutations: [
      {
        kind: 'withdraw',
        key: `absent-${transactionId}`,
      },
    ],
  };
}

async function waitForDiscovery(paths: BrokerRuntimePaths): Promise<{
  presentationEpoch: string;
  processId: number;
}> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const discovery = await readBrokerDiscovery(paths.discoveryFile).catch(() => undefined);
    if (discovery !== undefined) return discovery;
    await delay(20);
  }
  throw new Error('Timed out waiting for process broker discovery');
}

async function waitForExit(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code));
  });
}

function rejectAfter(milliseconds: number): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Timed out waiting for broker process exit')), milliseconds),
  );
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
