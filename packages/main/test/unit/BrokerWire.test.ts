import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, Server, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  BrokerJsonChannel,
  parseBrokerClientMessage,
  parseBrokerServerMessage,
} from '../../src/broker/BrokerWire';

describe('BrokerWire', () => {
  const sockets: Socket[] = [];
  const servers: Server[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    sockets.splice(0).forEach((socket) => socket.destroy());
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            if (!server.listening) resolve();
            else server.close(() => resolve());
          }),
      ),
    );
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
    );
  });

  it('retains a fast response until its waiter is registered', async () => {
    const pipeAddress = await createPipeAddress();
    const server = createServer((socket) => {
      sockets.push(socket);
      socket.once('data', () => {
        socket.write(
          `${JSON.stringify({
            kind: 'hello',
            status: 'ready',
            protocolVersion: 1,
            presentationEpoch: 'a'.repeat(32),
          })}\n`,
        );
      });
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(pipeAddress, resolve);
    });
    const socket = new Socket();
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.connect(pipeAddress, resolve);
    });
    const channel = new BrokerJsonChannel(socket, parseBrokerServerMessage);

    await channel.send({
      kind: 'hello',
      protocolVersion: 1,
      credential: 'b'.repeat(64),
    });
    await delay(20);

    await expect(channel.waitFor((message) => message.kind === 'hello', 100)).resolves.toEqual({
      kind: 'hello',
      status: 'ready',
      protocolVersion: 1,
      presentationEpoch: 'a'.repeat(32),
    });
  });

  it('strictly rejects unexpected wire fields and malformed credentials', () => {
    expect(() =>
      parseBrokerClientMessage({
        kind: 'hello',
        protocolVersion: 1,
        credential: 'b'.repeat(64),
        notificationText: 'must not cross the wire',
      }),
    ).toThrow(/field set/i);
    expect(() =>
      parseBrokerClientMessage({ kind: 'hello', protocolVersion: 1, credential: 'not-random' }),
    ).toThrow(/credential/i);
  });

  async function createPipeAddress(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'remote-notifier-wire-test-'));
    directories.push(directory);
    return process.platform === 'win32'
      ? `\\\\.\\pipe\\remote-notifier-wire-${randomUUID()}`
      : join(directory, 'wire.sock');
  }
});

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
