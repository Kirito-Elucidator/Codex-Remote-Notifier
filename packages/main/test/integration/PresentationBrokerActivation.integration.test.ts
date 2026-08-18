import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCodexReturnTarget, PresentationExchange } from 'remote-notifier-shared';

import { BrokerRuntimePaths } from '../../src/broker/BrokerProtocol';
import {
  NativePresentationExchange,
  NativePresentationRecord,
} from '../../src/broker/NativeWindowsAttentionAdapter';
import {
  NativePresentationAdapterPort,
  PresentationBrokerServer,
} from '../../src/broker/PresentationBrokerServer';
import { PresentationBrokerClient } from '../../src/PresentationBrokerClient';

describe('native presentation broker activation', () => {
  const clients: PresentationBrokerClient[] = [];
  const servers: PresentationBrokerServer[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    clients.splice(0).forEach((client) => client.dispose());
    await Promise.allSettled(servers.splice(0).map((server) => server.stop('test-cleanup')));
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
    );
  });

  it('turns source-neutral create, enrichment, and withdrawal into one native item', async () => {
    const paths = await runtimePaths();
    const adapter = createAdapter();
    const server = trackServer(
      new PresentationBrokerServer({ paths, presentationAdapter: adapter }),
    );
    const client = trackClient(
      new PresentationBrokerClient({ paths, launch: async () => void (await server.start()) }),
    );
    const initial = createRecord('unicode-record', 1, 'local_unicode');

    await expect(client.exchange(create('create-unicode', initial))).resolves.toMatchObject({
      kind: 'applied',
    });
    await expect(client.exchange(create('create-unicode', initial))).resolves.toMatchObject({
      kind: 'replay',
    });
    await client.exchange(
      update('update-unicode', {
        ...initial,
        revision: 2,
        canonicalTitle: '\u4e2d\u6587 & <XML> \u{1f642}',
        canonicalBody: 'Remote e\u0301 enrichment',
      }),
    );
    await client.exchange(withdraw('withdraw-unicode', initial.key));

    const exchanges = vi.mocked(adapter.exchange).mock.calls.map(([exchange]) => exchange);
    expect(exchanges).toHaveLength(3);
    const created = mutationRecord(exchanges[0]);
    const enriched = mutationRecord(exchanges[1]);
    expect(created.activationId).toMatch(/^[0-9a-f]{32}$/);
    expect(enriched.activationId).toBe(created.activationId);
    expect(enriched.canonicalTitle).toBe('\u4e2d\u6587 & <XML> \u{1f642}');
    expect(JSON.stringify(exchanges)).not.toContain('local_unicode');
    expect(exchanges[2]).toMatchObject({
      mutations: [{ kind: 'withdraw', key: initial.key }],
    });
  });

  it('acknowledges exactly one record before broadcasting four local and remote targets', async () => {
    const paths = await runtimePaths();
    const events: string[] = [];
    const adapter = createAdapter(events);
    const server = trackServer(
      new PresentationBrokerServer({
        paths,
        navigationTimeoutMs: 100,
        presentationAdapter: adapter,
      }),
    );
    await server.start();
    const targetClients = [
      createClaimingClient(paths, 'local-1', events),
      createClaimingClient(paths, 'local-2', events),
      createClaimingClient(paths, 'remote-1', events),
      createClaimingClient(paths, 'remote-2', events),
    ];
    targetClients.forEach(trackClient);
    await Promise.all(targetClients.map((client) => client.start()));
    const sender = trackClient(new PresentationBrokerClient({ paths, launch: vi.fn() }));

    for (const target of ['local-1', 'remote-1', 'remote-2']) {
      await sender.exchange(create(`create-${target}`, createRecord(target, 1, target)));
      const activation = activationFor(adapter, target);
      await expect(sender.redeemActivation(server.presentationEpoch, activation)).resolves.toBe(
        'focused',
      );
      await expect(sender.redeemActivation(server.presentationEpoch, activation)).resolves.toBe(
        'failed',
      );
    }

    await sender.exchange(create('create-local-2', createRecord('local-2', 1, 'local-2')));
    const reloadActivation = activationFor(adapter, 'local-2');
    targetClients[1].dispose();
    const reloaded = trackClient(createClaimingClient(paths, 'local-2', events, 'reloaded'));
    await reloaded.start();
    await expect(sender.redeemActivation(server.presentationEpoch, reloadActivation)).resolves.toBe(
      'focused',
    );
    expect(events).toContain('claim:reloaded:local-2');

    await sender.exchange(create('create-no-claim', createRecord('no-claim', 1, 'missing')));
    const failedActivation = activationFor(adapter, 'no-claim');
    events.length = 0;
    await expect(sender.redeemActivation(server.presentationEpoch, failedActivation)).resolves.toBe(
      'failed',
    );
    expect(events[0]).toBe('withdraw:no-claim');
    expect(events.some((event) => event.startsWith('claim:'))).toBe(true);

    await sender.exchange(create('create-ended', createRecord('ended', 1, 'local-1')));
    const endedActivation = activationFor(adapter, 'ended');
    const endedEpoch = server.presentationEpoch;
    clients.splice(0).forEach((client) => client.dispose());
    await server.stop('controlled');

    const replacement = trackServer(
      new PresentationBrokerServer({ paths, presentationAdapter: createAdapter() }),
    );
    await replacement.start();
    const replacementClient = trackClient(new PresentationBrokerClient({ paths, launch: vi.fn() }));
    await expect(replacementClient.redeemActivation(endedEpoch, endedActivation)).resolves.toBe(
      'failed',
    );
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
    const directory = await mkdtemp(join(tmpdir(), 'remote-notifier-activation-test-'));
    directories.push(directory);
    const id = randomUUID();
    return {
      discoveryFile: join(directory, 'discovery.json'),
      pipeAddress:
        process.platform === 'win32'
          ? `\\\\.\\pipe\\remote-notifier-activation-${id}`
          : join(directory, 'broker.sock'),
    };
  }
});

function createAdapter(events: string[] = []): NativePresentationAdapterPort {
  return {
    cleanup: vi.fn().mockResolvedValue(undefined),
    exchange: vi.fn(async (exchange: NativePresentationExchange) => {
      if (exchange.kind !== 'apply') return;
      for (const mutation of exchange.mutations) {
        if (mutation.kind === 'withdraw') events.push(`withdraw:${mutation.key}`);
      }
    }),
  };
}

function createClaimingClient(
  paths: BrokerRuntimePaths,
  claimedSession: string,
  events: string[],
  name = claimedSession,
): PresentationBrokerClient {
  return new PresentationBrokerClient({
    paths,
    launch: vi.fn(),
    claimReturnTarget: async (encoded) => {
      const sessionId = JSON.parse(encoded).sessionId as string;
      events.push(`claim:${name}:${sessionId}`);
      return sessionId === claimedSession;
    },
  });
}

function create(
  transactionId: string,
  record: ReturnType<typeof createRecord>,
): PresentationExchange {
  return { kind: 'apply', transactionId, mutations: [{ kind: 'create', record }] };
}

function update(
  transactionId: string,
  record: ReturnType<typeof createRecord>,
): PresentationExchange {
  return { kind: 'apply', transactionId, mutations: [{ kind: 'update', record }] };
}

function withdraw(transactionId: string, key: string): PresentationExchange {
  return { kind: 'apply', transactionId, mutations: [{ kind: 'withdraw', key }] };
}

function createRecord(key: string, revision: number, sessionId: string) {
  return {
    key,
    revision,
    appearance: 'action' as const,
    canonicalTitle: `Title ${key}`,
    canonicalBody: `Body ${key}`,
    returnTarget: createCodexReturnTarget({ sessionId }),
  };
}

function mutationRecord(exchange: NativePresentationExchange): NativePresentationRecord {
  if (exchange.kind !== 'apply') throw new Error('Expected an apply exchange');
  const mutation = exchange.mutations[0];
  if (mutation.kind === 'withdraw') throw new Error('Expected a record mutation');
  return mutation.record;
}

function activationFor(adapter: NativePresentationAdapterPort, key: string): string {
  const calls = vi.mocked(adapter.exchange).mock.calls;
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const exchange = calls[index][0];
    if (exchange.kind !== 'apply') continue;
    for (const mutation of exchange.mutations) {
      if (mutation.kind !== 'withdraw' && mutation.record.key === key) {
        return mutation.record.activationId;
      }
    }
  }
  throw new Error(`No activation for ${key}`);
}
