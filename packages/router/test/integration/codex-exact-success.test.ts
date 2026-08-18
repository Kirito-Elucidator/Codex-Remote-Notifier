import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  COMMAND_EXCHANGE_PRESENTATION,
  NotificationPresenter,
  PresentationExchange,
} from 'remote-notifier-shared';
import { BrokerRuntimePaths } from '../../../main/src/broker/BrokerProtocol';
import {
  NativePresentationAdapterPort,
  PresentationBrokerServer,
} from '../../../main/src/broker/PresentationBrokerServer';
import { NativePresentationExchange } from '../../../main/src/broker/NativeWindowsAttentionAdapter';
import { PresentationBrokerClient } from '../../../main/src/PresentationBrokerClient';
import { CodexAttentionNormalizationRegistry } from '../../src/codex/CodexAttentionNormalization';
import { CodexAttentionProtocolCapture } from '../../src/codex/CodexAttentionProtocolCapture';
import { CodexEventHandler } from '../../src/codex/CodexEventHandler';
import { Configuration } from '../../src/config/Configuration';
import { NotificationHandler } from '../../src/handler/NotificationHandler';
import { PresentationCommandBridge } from '../../src/presenter/PresentationCommandBridge';
import { NotificationServer } from '../../src/server/NotificationServer';
import { CodexAttentionRouterClient } from '../../src/sidecar/codex-notifier-sidecar';

describe('exact foreground success', () => {
  const brokers: PresentationBrokerServer[] = [];
  const brokerClients: PresentationBrokerClient[] = [];
  const directories: string[] = [];
  const notificationServers: NotificationServer[] = [];
  const routerClients: CodexAttentionRouterClient[] = [];

  afterEach(async () => {
    routerClients.splice(0).forEach((client) => client.stop());
    await Promise.all(notificationServers.splice(0).map((server) => server.stop()));
    brokerClients.splice(0).forEach((client) => client.dispose());
    await Promise.allSettled(brokers.splice(0).map((broker) => broker.stop('test-cleanup')));
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
    );
  });

  it('carries an audited replay through authenticated delivery into one native broker create', async () => {
    const nativeExchanges: NativePresentationExchange[] = [];
    const paths = await runtimePaths(directories);
    const nativeAdapter: NativePresentationAdapterPort = {
      cleanup: async () => undefined,
      exchange: vi.fn(async (input) => {
        nativeExchanges.push(input);
      }),
      onInteraction: () => ({ dispose: () => undefined }),
    };
    const broker = new PresentationBrokerServer({ paths, presentationAdapter: nativeAdapter });
    brokers.push(broker);
    await broker.start();
    const brokerClient = new PresentationBrokerClient({ paths, launch: vi.fn() });
    brokerClients.push(brokerClient);

    const commandBridge = new PresentationCommandBridge(
      async (command: string, input: PresentationExchange) => {
        expect(command).toBe(COMMAND_EXCHANGE_PRESENTATION);
        return brokerClient.exchange(input);
      },
    );
    const normalization = new CodexAttentionNormalizationRegistry(commandBridge);
    const config = {
      enabled: true,
      maxBodySize: 65_536,
      notificationLevel: 'information',
      port: 0,
      showTimestamp: false,
    } as unknown as Configuration;
    const presenter: NotificationPresenter = { present: vi.fn() };
    const legacyHandler = { handle: vi.fn() } as unknown as CodexEventHandler;
    const server = new NotificationServer(
      new NotificationHandler(presenter, config),
      config,
      legacyHandler,
      normalization,
    );
    notificationServers.push(server);
    const token = 'authenticated-router-token';
    await server.start(token);

    const capture = new CodexAttentionProtocolCapture({
      invocationId: '0123456789abcdef0123456789abcdef',
      connectionId: 'primary-connection',
      authorityEpoch: 'authority-1',
      version: 'codex-cli 0.147.0',
      primary: true,
    });
    capture.observeClientText('{"id":1,"method":"initialize","params":{}}');
    capture.observeServerText('{"id":1,"result":{}}');
    capture.observeClientText('{"id":2,"method":"thread/start","params":{}}');
    const observations = [
      ...capture.observeServerText(
        '{"method":"thread/started","params":{"thread":{"id":"thread-1","parentThreadId":null}}}',
      ),
      ...capture.observeServerText('{"id":2,"result":{"thread":{"id":"thread-1"}}}'),
      ...capture.observeServerText(
        '{"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1"}}}',
      ),
      ...capture.observeServerText(
        '{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"completed","items":[{"type":"agentMessage","text":"exact success"}]}}}',
      ),
    ];
    const routerClient = new CodexAttentionRouterClient({
      REMOTE_NOTIFIER_TOKEN: token,
      REMOTE_NOTIFIER_URL: `http://127.0.0.1:${server.port}/notify`,
    });
    routerClients.push(routerClient);
    for (const observation of observations) routerClient.post(capture.scope, observation);

    await routerClient.drain(2_000);

    expect(observations.map(({ kind }) => kind)).toEqual([
      'connection-qualification',
      'turn-start',
      'terminal-result',
    ]);
    expect(nativeExchanges).toEqual([
      {
        kind: 'apply',
        transactionId: expect.any(String),
        mutations: [
          {
            kind: 'create',
            record: expect.objectContaining({
              activationId: expect.stringMatching(/^[0-9a-f]{32}$/),
              canonicalBody: 'exact success',
              canonicalTitle: 'Codex completed',
              revision: 1,
            }),
          },
        ],
      },
    ]);
    expect(nativeAdapter.exchange).toHaveBeenCalledTimes(1);
    expect(presenter.present).not.toHaveBeenCalled();
    expect(legacyHandler.handle).not.toHaveBeenCalled();
  });
});

async function runtimePaths(directories: string[]): Promise<BrokerRuntimePaths> {
  const directory = await mkdtemp(join(tmpdir(), 'remote-notifier-exact-success-'));
  directories.push(directory);
  const id = randomUUID();
  return {
    discoveryFile: join(directory, 'discovery.json'),
    pipeAddress:
      process.platform === 'win32'
        ? `\\\\.\\pipe\\remote-notifier-exact-${id}`
        : join(directory, 'broker.sock'),
  };
}
