import { describe, expect, it, vi } from 'vitest';

import type {
  AttentionPresentationPort,
  ObservationExchange,
  PresentationExchange,
  PresentationReceipt,
} from 'remote-notifier-shared';

import { CodexAttentionNormalizationRegistry } from '../../src/codex/CodexAttentionNormalization';

const scope = {
  invocationId: '0123456789abcdef0123456789abcdef',
  connectionId: 'connection-primary',
  authorityEpoch: 'authority-1',
};

describe('CodexAttentionNormalization.exchange', () => {
  it('keeps a qualified turn start silent and applies one stable success outcome', async () => {
    const exchanged: PresentationExchange[] = [];
    const presentation: AttentionPresentationPort = {
      exchange: vi.fn(async (input): Promise<PresentationReceipt> => {
        exchanged.push(input);
        return { kind: 'applied', transactionId: input.transactionId };
      }),
    };
    const normalization = new CodexAttentionNormalizationRegistry(presentation);
    const start = append([
      {
        kind: 'connection-qualification',
        sourceSequence: 1,
        initialized: true,
        primary: true,
        capabilities: 'audited',
        foregroundOwnership: 'confirmed',
      },
      {
        kind: 'turn-start',
        sourceSequence: 2,
        turnKey: 'turn-1',
        returnTarget: '{"opaque":"local-route"}',
      },
    ]);

    await expect(normalization.exchange(start)).resolves.toEqual({
      receivedThrough: 2,
      appliedThrough: 2,
      monitoring: 'exact',
    });
    expect(exchanged).toEqual([]);

    const success = append(
      [
        {
          kind: 'terminal-result',
          sourceSequence: 3,
          turnKey: 'turn-1',
          result: 'success',
          occurrenceKey: 'turn-1:success',
          canonicalTitle: 'Codex completed',
          canonicalBody: '任务完成 🙂 e\u0301',
        },
      ],
      3,
    );
    const receipt = await normalization.exchange(success);

    expect(receipt).toEqual({
      receivedThrough: 3,
      appliedThrough: 3,
      monitoring: 'exact',
    });
    expect(exchanged).toEqual([
      {
        kind: 'apply',
        transactionId: expect.any(String),
        mutations: [
          {
            kind: 'create',
            record: {
              key: expect.any(String),
              revision: 1,
              appearance: 'information',
              canonicalTitle: 'Codex completed',
              canonicalBody: '任务完成 🙂 e\u0301',
              returnTarget: '{"opaque":"local-route"}',
            },
          },
        ],
      },
    ]);

    await expect(normalization.exchange(success)).resolves.toEqual(receipt);
    expect(presentation.exchange).toHaveBeenCalledTimes(1);
  });

  it('retains a success transaction until the broker reports it applied', async () => {
    const transactionIds: string[] = [];
    let attempt = 0;
    const presentation: AttentionPresentationPort = {
      exchange: vi.fn(async (input): Promise<PresentationReceipt> => {
        transactionIds.push(input.transactionId);
        attempt++;
        return attempt === 1
          ? { kind: 'received', transactionId: input.transactionId }
          : { kind: 'replay', transactionId: input.transactionId };
      }),
    };
    const normalization = new CodexAttentionNormalizationRegistry(presentation);
    const exchange = append([
      {
        kind: 'connection-qualification',
        sourceSequence: 1,
        initialized: true,
        primary: true,
        capabilities: 'audited',
        foregroundOwnership: 'confirmed',
      },
      {
        kind: 'turn-start',
        sourceSequence: 2,
        turnKey: 'turn-1',
        returnTarget: 'opaque-return-target',
      },
      {
        kind: 'terminal-result',
        sourceSequence: 3,
        turnKey: 'turn-1',
        result: 'success',
        occurrenceKey: 'turn-1:success',
      },
    ]);

    await expect(normalization.exchange(exchange)).resolves.toEqual({
      receivedThrough: 3,
      appliedThrough: 2,
      monitoring: 'exact',
    });
    await expect(normalization.exchange(exchange)).resolves.toEqual({
      receivedThrough: 3,
      appliedThrough: 3,
      monitoring: 'exact',
    });
    expect(transactionIds).toHaveLength(2);
    expect(new Set(transactionIds).size).toBe(1);
  });

  it('requests replay instead of admitting a gapped batch', async () => {
    const presentation: AttentionPresentationPort = {
      exchange: vi.fn(),
    };
    const normalization = new CodexAttentionNormalizationRegistry(presentation);

    await expect(
      normalization.exchange(
        append(
          [
            {
              kind: 'turn-start',
              sourceSequence: 2,
              turnKey: 'turn-1',
              returnTarget: 'opaque-return-target',
            },
          ],
          2,
        ),
      ),
    ).resolves.toEqual({
      receivedThrough: 0,
      appliedThrough: 0,
      replayFrom: 1,
      monitoring: 'compatibility',
    });
    expect(presentation.exchange).not.toHaveBeenCalled();
  });
});

function append(
  observations: Extract<ObservationExchange, { kind: 'append' }>['observations'],
  fromSequence = 1,
): ObservationExchange {
  return {
    kind: 'append',
    deliveryGeneration: 'delivery-1',
    scope,
    fromSequence,
    observations,
  };
}
