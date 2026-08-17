import { describe, expect, it, vi } from 'vitest';
import { commands } from 'vscode';

import {
  COMMAND_EXCHANGE_PRESENTATION,
  COMMAND_SHOW_NOTIFICATION,
  NotificationPresenter,
  PresentationExchange,
} from 'remote-notifier-shared';

import { createPresentationExchangeCommandHandler } from '../../../main/src/PresentationExchangeCommand';
import { CommandPresenter } from '../../src/presenter/CommandPresenter';
import { PresentationCommandBridge } from '../../src/presenter/PresentationCommandBridge';

describe('PresentationCommandBridge', () => {
  const exchange: PresentationExchange = {
    kind: 'apply',
    transactionId: 'synthetic-transaction',
    mutations: [
      {
        kind: 'create',
        record: {
          key: 'synthetic-record',
          revision: 1,
          appearance: 'information',
          canonicalTitle: 'Synthetic title',
          canonicalBody: 'Synthetic body',
          returnTarget: 'opaque:synthetic-target',
        },
      },
    ],
  };

  it('round-trips the endpoint receipt unchanged through the command boundary', async () => {
    const endpoint = {
      exchange: vi.fn().mockResolvedValue({
        kind: 'applied',
        transactionId: exchange.transactionId,
      }),
    };
    const handler = createPresentationExchangeCommandHandler(endpoint);
    const execute = vi.fn(async (command: string, input: unknown) => {
      expect(command).toBe(COMMAND_EXCHANGE_PRESENTATION);
      return handler(JSON.parse(JSON.stringify(input)));
    });

    const bridge = new PresentationCommandBridge(execute);

    await expect(bridge.exchange(exchange)).resolves.toEqual({
      kind: 'applied',
      transactionId: exchange.transactionId,
    });
    expect(endpoint.exchange).toHaveBeenCalledWith(exchange);
  });

  it('coexists with the unchanged generic notification command', async () => {
    const endpoint = {
      exchange: vi.fn().mockResolvedValue({
        kind: 'applied',
        transactionId: exchange.transactionId,
      }),
    };
    const handler = createPresentationExchangeCommandHandler(endpoint);
    vi.mocked(commands.executeCommand).mockImplementation(async (command, input) => {
      if (command === COMMAND_EXCHANGE_PRESENTATION) return handler(input);
      if (command === COMMAND_SHOW_NOTIFICATION) return 'legacy-result';
      throw new Error(`Unexpected command: ${command}`);
    });
    const fallback: NotificationPresenter = { present: vi.fn() };

    await expect(new PresentationCommandBridge().exchange(exchange)).resolves.toMatchObject({
      kind: 'applied',
    });
    await expect(
      new CommandPresenter(fallback).present({ message: 'generic notification' }),
    ).resolves.toBe('legacy-result');
    expect(endpoint.exchange).toHaveBeenCalledOnce();
    expect(fallback.present).not.toHaveBeenCalled();
  });

  it('does not forward an invalid exchange to Main', async () => {
    const execute = vi.fn();
    const bridge = new PresentationCommandBridge(execute);

    await expect(
      bridge.exchange({ ...exchange, transactionId: '' } as PresentationExchange),
    ).rejects.toThrow(/transactionId/i);
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not admit an invalid command payload to the Main endpoint', async () => {
    const endpoint = { exchange: vi.fn() };
    const handler = createPresentationExchangeCommandHandler(endpoint);

    await expect(
      handler({ ...exchange, transactionId: '', protocolMethod: 'turn/completed' }),
    ).rejects.toThrow(/invalid attention exchange/i);
    expect(endpoint.exchange).not.toHaveBeenCalled();
  });

  it('rejects missing, invalid, or mismatched endpoint receipts', async () => {
    await expect(
      new PresentationCommandBridge(vi.fn().mockResolvedValue(undefined)).exchange(exchange),
    ).rejects.toThrow(/receipt/i);
    await expect(
      new PresentationCommandBridge(
        vi.fn().mockResolvedValue({ kind: 'applied', transactionId: 'different' }),
      ).exchange(exchange),
    ).rejects.toThrow(/transaction/i);
  });
});
