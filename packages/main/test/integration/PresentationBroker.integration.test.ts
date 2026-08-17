import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Socket } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { PresentationExchange } from 'remote-notifier-shared';

import { BrokerRuntimePaths, PresentationBrokerDiscovery } from '../../src/broker/BrokerProtocol';
import { PresentationBrokerServer } from '../../src/broker/PresentationBrokerServer';
import { PresentationBrokerClient } from '../../src/PresentationBrokerClient';

describe('Windows presentation broker', () => {
  const servers: PresentationBrokerServer[] = [];
  const clients: PresentationBrokerClient[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    clients.splice(0).forEach((client) => client.dispose());
    await Promise.allSettled(servers.splice(0).map((server) => server.stop('test-cleanup')));
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
    );
  });

  it('converges concurrent launches on one authenticated broker and reuses it', async () => {
    const paths = await runtimePaths();
    const first = trackServer(new PresentationBrokerServer({ paths }));
    const second = trackServer(new PresentationBrokerServer({ paths }));

    const outcomes = await Promise.all([first.start(), second.start()]);
    expect(outcomes.sort()).toEqual(['existing', 'started']);

    const discovery = await readDiscovery(paths);
    expect(Object.keys(discovery).sort()).toEqual([
      'credential',
      'pipeAddress',
      'presentationEpoch',
      'processId',
      'protocolVersion',
    ]);
    expect(JSON.stringify(discovery)).not.toContain('notification');
    expect(JSON.stringify(discovery)).not.toContain('opaque:');

    const one = trackClient(new PresentationBrokerClient({ paths, launch: vi.fn() }));
    const two = trackClient(new PresentationBrokerClient({ paths, launch: vi.fn() }));
    const [oneConnection, twoConnection] = await Promise.all([one.start(), two.start()]);

    expect(oneConnection.presentationEpoch).toBe(discovery.presentationEpoch);
    expect(twoConnection.presentationEpoch).toBe(discovery.presentationEpoch);
    expect(oneConnection.epochReset).toBe(false);
    expect(twoConnection.epochReset).toBe(false);
  });

  it('rejects failed authentication explicitly without replacing the live broker', async () => {
    const paths = await runtimePaths();
    const server = trackServer(new PresentationBrokerServer({ paths }));
    await server.start();
    const discovery = await readDiscovery(paths);
    await writeFile(
      paths.discoveryFile,
      JSON.stringify({ ...discovery, credential: 'f'.repeat(64) }),
      'utf8',
    );
    const launch = vi.fn();
    const client = trackClient(new PresentationBrokerClient({ paths, launch }));

    await expect(client.start()).rejects.toMatchObject({ code: 'authentication-failed' });
    expect(launch).not.toHaveBeenCalled();
    expect(server.presentationEpoch).toBe(discovery.presentationEpoch);
  });

  it('rejects stale discovery, launches a fresh broker, and reports the recovery', async () => {
    const paths = await runtimePaths();
    await writeFile(
      paths.discoveryFile,
      JSON.stringify({
        protocolVersion: 1,
        processId: 123,
        presentationEpoch: 'a'.repeat(32),
        pipeAddress: paths.pipeAddress,
        credential: 'b'.repeat(64),
      } satisfies PresentationBrokerDiscovery),
      'utf8',
    );
    const statuses: string[] = [];
    const server = trackServer(new PresentationBrokerServer({ paths }));
    const client = trackClient(
      new PresentationBrokerClient({
        paths,
        launch: async () => {
          await server.start();
        },
        onStatus: (event) => statuses.push(event.code),
      }),
    );

    await expect(client.start()).resolves.toMatchObject({ epochReset: true });
    expect(statuses).toContain('stale-discovery');
    expect((await readDiscovery(paths)).presentationEpoch).not.toBe('a'.repeat(32));
  });

  it('retains applied transactions across client reloads without retry ownership in Main', async () => {
    const paths = await runtimePaths();
    const server = trackServer(new PresentationBrokerServer({ paths, idleTimeoutMs: 1_000 }));
    const launch = async () => {
      await server.start();
    };
    const first = trackClient(new PresentationBrokerClient({ paths, launch }));
    const exchange = createExchange('survives-reload');

    await expect(first.exchange(exchange)).resolves.toEqual({
      kind: 'applied',
      transactionId: exchange.transactionId,
    });
    first.dispose();

    const reloaded = trackClient(new PresentationBrokerClient({ paths, launch: vi.fn() }));
    await expect(reloaded.exchange(exchange)).resolves.toEqual({
      kind: 'replay',
      transactionId: exchange.transactionId,
    });
    expect(server.presentationEpoch).toBe((await readDiscovery(paths)).presentationEpoch);
  });

  it('exits after the empty no-client grace period but survives while its ledger is nonempty', async () => {
    const emptyPaths = await runtimePaths();
    const empty = trackServer(
      new PresentationBrokerServer({ paths: emptyPaths, idleTimeoutMs: 30 }),
    );
    await empty.start();
    await expect(empty.closed).resolves.toBe('idle');

    const occupiedPaths = await runtimePaths();
    const occupied = trackServer(
      new PresentationBrokerServer({ paths: occupiedPaths, idleTimeoutMs: 30 }),
    );
    const client = trackClient(
      new PresentationBrokerClient({
        paths: occupiedPaths,
        launch: async () => {
          await occupied.start();
        },
      }),
    );
    await client.exchange(createExchange('retained-record'));
    client.dispose();
    await delay(80);

    expect(occupied.isRunning).toBe(true);
  });

  it('does not let an unauthenticated socket control the empty-broker lifetime', async () => {
    const paths = await runtimePaths();
    const server = trackServer(
      new PresentationBrokerServer({
        paths,
        handshakeTimeoutMs: 1_000,
        idleTimeoutMs: 30,
      }),
    );
    await server.start();
    const unauthenticated = new Socket();
    await new Promise<void>((resolve, reject) => {
      unauthenticated.once('error', reject);
      unauthenticated.connect(paths.pipeAddress, resolve);
    });
    const socketClosed = new Promise<void>((resolve) => {
      unauthenticated.once('close', () => resolve());
    });

    await expect(server.closed).resolves.toBe('idle');
    await socketClosed;
    expect(unauthenticated.destroyed).toBe(true);
  });

  it('rejects exchanges that arrive after controlled-stop draining begins', async () => {
    const paths = await runtimePaths();
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let reportCleanupStarted!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => {
      reportCleanupStarted = resolve;
    });
    const cleanup = vi.fn(async () => {
      reportCleanupStarted();
      await cleanupGate;
    });
    const server = trackServer(new PresentationBrokerServer({ paths, cleanupEpochItems: cleanup }));
    const client = trackClient(
      new PresentationBrokerClient({
        paths,
        launch: async () => {
          await server.start();
        },
      }),
    );
    await client.start();

    const stop = server.stop('controlled');
    await cleanupStarted;
    await expect(client.exchange(createExchange('after-stop'))).resolves.toEqual({
      kind: 'rejected',
      transactionId: 'after-stop',
      reason: 'unavailable',
    });
    releaseCleanup();
    await stop;
    expect(cleanup).toHaveBeenCalledWith([]);
  });

  it('drains and cleans up an incompatible epoch before reporting an empty reset', async () => {
    const paths = await runtimePaths();
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const incompatible = trackServer(
      new PresentationBrokerServer({ paths, protocolVersion: 0, cleanupEpochItems: cleanup }),
    );
    await incompatible.start();
    const oldEpoch = incompatible.presentationEpoch;
    const oldClient = trackClient(
      new PresentationBrokerClient({ paths, protocolVersion: 0, launch: vi.fn() }),
    );
    const exchange = createExchange('old-epoch-transaction');
    await oldClient.exchange(exchange);
    oldClient.dispose();

    const replacement = trackServer(new PresentationBrokerServer({ paths, protocolVersion: 1 }));
    const statuses: string[] = [];
    const client = trackClient(
      new PresentationBrokerClient({
        paths,
        protocolVersion: 1,
        launch: async () => {
          await replacement.start();
        },
        onStatus: (event) => statuses.push(event.code),
      }),
    );

    const connection = await client.start();
    expect(connection.epochReset).toBe(true);
    expect(connection.presentationEpoch).not.toBe(oldEpoch);
    expect(statuses).toContain('incompatible-epoch-reset');
    expect(cleanup).toHaveBeenCalledWith([
      expect.objectContaining({ key: 'record-old-epoch-transaction' }),
    ]);
    await expect(client.exchange(exchange)).resolves.toMatchObject({ kind: 'applied' });
  });

  function trackClient(client: PresentationBrokerClient): PresentationBrokerClient {
    clients.push(client);
    return client;
  }

  function trackServer(server: PresentationBrokerServer): PresentationBrokerServer {
    servers.push(server);
    return server;
  }

  async function runtimePaths(): Promise<BrokerRuntimePaths> {
    const directory = await mkdtemp(join(tmpdir(), 'remote-notifier-broker-test-'));
    directories.push(directory);
    const id = randomUUID();
    return {
      discoveryFile: join(directory, 'discovery.json'),
      pipeAddress:
        process.platform === 'win32'
          ? `\\\\.\\pipe\\remote-notifier-test-${id}`
          : join(directory, 'broker.sock'),
    };
  }
});

function createExchange(transactionId: string): PresentationExchange {
  return {
    kind: 'apply',
    transactionId,
    mutations: [
      {
        kind: 'create',
        record: {
          key: `record-${transactionId}`,
          revision: 1,
          appearance: 'information',
          canonicalTitle: 'Broker integration',
          canonicalBody: 'Applied exactly once',
          returnTarget: `opaque:${transactionId}`,
        },
      },
    ],
  };
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readDiscovery(paths: BrokerRuntimePaths): Promise<PresentationBrokerDiscovery> {
  return JSON.parse(await readFile(paths.discoveryFile, 'utf8')) as PresentationBrokerDiscovery;
}
