import { describe, expect, it, vi } from 'vitest';

import type {
  AttentionPresentationPort,
  ConnectionQualificationEvidence,
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
        evidence: qualificationEvidence({ optedOutNotifications: ['model/rerouted'] }),
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
        evidence: qualificationEvidence(),
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

  it('independently rejects a turn that lacks exact connection qualification', async () => {
    const presentation: AttentionPresentationPort = {
      exchange: vi.fn(),
    };
    const normalization = new CodexAttentionNormalizationRegistry(presentation);

    await expect(
      normalization.exchange(
        append([
          {
            kind: 'turn-start',
            sourceSequence: 1,
            turnKey: 'unbound-turn',
            returnTarget: 'opaque-return-target',
          },
          {
            kind: 'terminal-result',
            sourceSequence: 2,
            turnKey: 'unbound-turn',
            result: 'success',
            occurrenceKey: 'unbound-turn:success',
          },
        ]),
      ),
    ).resolves.toEqual({
      receivedThrough: 2,
      appliedThrough: 2,
      monitoring: 'degraded',
    });
    expect(presentation.exchange).not.toHaveBeenCalled();
  });

  it('independently rejects inconsistent qualification evidence from the source adapter', async () => {
    const presentation: AttentionPresentationPort = { exchange: vi.fn() };
    const normalization = new CodexAttentionNormalizationRegistry(presentation);

    await expect(
      normalization.exchange(
        append([
          {
            kind: 'connection-qualification',
            sourceSequence: 1,
            initialized: true,
            primary: true,
            capabilities: 'audited',
            foregroundOwnership: 'confirmed',
            evidence: qualificationEvidence({ foregroundResponseKey: 'number:99' }),
          },
          {
            kind: 'turn-start',
            sourceSequence: 2,
            turnKey: 'turn-forged',
            returnTarget: 'opaque-return-target',
          },
          {
            kind: 'terminal-result',
            sourceSequence: 3,
            turnKey: 'turn-forged',
            result: 'success',
            occurrenceKey: 'turn-forged:success',
          },
        ]),
      ),
    ).resolves.toEqual({ receivedThrough: 3, appliedThrough: 3, monitoring: 'degraded' });
    expect(presentation.exchange).not.toHaveBeenCalled();
  });

  it('rejects descendant qualification before it can establish normalization state', async () => {
    const presentation: AttentionPresentationPort = { exchange: vi.fn() };
    const normalization = new CodexAttentionNormalizationRegistry(presentation);

    await expect(
      normalization.exchange(
        append([
          {
            kind: 'connection-qualification',
            sourceSequence: 1,
            initialized: true,
            primary: true,
            capabilities: 'audited',
            foregroundOwnership: 'confirmed',
            evidence: qualificationEvidence({
              foregroundSource: 'subAgent',
              foregroundParentKey: 'parent-thread',
            }),
          },
          {
            kind: 'turn-start',
            sourceSequence: 2,
            turnKey: 'turn-1',
            returnTarget: 'descendant-route',
          },
          {
            kind: 'terminal-result',
            sourceSequence: 3,
            turnKey: 'turn-1',
            result: 'success',
            occurrenceKey: 'turn-1:success',
          },
        ]),
      ),
    ).resolves.toEqual({ receivedThrough: 3, appliedThrough: 3, monitoring: 'degraded' });
    expect(presentation.exchange).not.toHaveBeenCalled();
  });

  it('isolates repeated identities and return routes across concurrent invocations', async () => {
    let releaseSlow: (() => void) | undefined;
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const exchanged: PresentationExchange[] = [];
    const presentation: AttentionPresentationPort = {
      exchange: vi.fn(async (input): Promise<PresentationReceipt> => {
        exchanged.push(input);
        const mutation = input.kind === 'apply' ? input.mutations[0] : undefined;
        if (
          mutation?.kind === 'create' &&
          mutation.record.returnTarget === '{"origin":"slow-local"}'
        ) {
          await slow;
        }
        return { kind: 'applied', transactionId: input.transactionId };
      }),
    };
    const normalization = new CodexAttentionNormalizationRegistry(presentation);
    const repeated = (invocationId: string, returnTarget: string): ObservationExchange => ({
      kind: 'append',
      deliveryGeneration: 'same-delivery',
      scope: { ...scope, invocationId },
      fromSequence: 1,
      observations: [
        {
          kind: 'connection-qualification',
          sourceSequence: 1,
          initialized: true,
          primary: true,
          capabilities: 'audited',
          foregroundOwnership: 'confirmed',
          evidence: qualificationEvidence(),
        },
        { kind: 'turn-start', sourceSequence: 2, turnKey: 'same-turn', returnTarget },
        {
          kind: 'terminal-result',
          sourceSequence: 3,
          turnKey: 'same-turn',
          result: 'success',
          occurrenceKey: 'same-turn:success',
          canonicalTitle: 'Same title',
          canonicalBody: 'Same body',
        },
      ],
    });

    const slowResult = normalization.exchange(
      repeated('11111111111111111111111111111111', '{"origin":"slow-local"}'),
    );
    await vi.waitFor(() => expect(exchanged).toHaveLength(1));
    await expect(
      normalization.exchange(repeated('22222222222222222222222222222222', '{"origin":"remote"}')),
    ).resolves.toEqual({ receivedThrough: 3, appliedThrough: 3, monitoring: 'exact' });

    expect(exchanged).toHaveLength(2);
    const records = exchanged.flatMap((exchange) =>
      exchange.kind === 'apply'
        ? exchange.mutations.flatMap((mutation) =>
            mutation.kind === 'create' ? [mutation.record] : [],
          )
        : [],
    );
    expect(records.map(({ returnTarget }) => returnTarget)).toEqual([
      '{"origin":"slow-local"}',
      '{"origin":"remote"}',
    ]);
    expect(new Set(records.map(({ key }) => key)).size).toBe(2);

    releaseSlow?.();
    await expect(slowResult).resolves.toEqual({
      receivedThrough: 3,
      appliedThrough: 3,
      monitoring: 'exact',
    });
  });

  it('keeps an unfinished older turn separately reconcilable from a newer turn', async () => {
    const exchanged: PresentationExchange[] = [];
    const presentation: AttentionPresentationPort = {
      exchange: vi.fn(async (input): Promise<PresentationReceipt> => {
        exchanged.push(input);
        return { kind: 'applied', transactionId: input.transactionId };
      }),
    };
    const normalization = new CodexAttentionNormalizationRegistry(presentation);

    await expect(
      normalization.exchange(
        append([
          {
            kind: 'connection-qualification',
            sourceSequence: 1,
            initialized: true,
            primary: true,
            capabilities: 'audited',
            foregroundOwnership: 'confirmed',
            evidence: qualificationEvidence(),
          },
          {
            kind: 'turn-start',
            sourceSequence: 2,
            turnKey: 'older-turn',
            returnTarget: 'older-route',
          },
          {
            kind: 'turn-start',
            sourceSequence: 3,
            turnKey: 'newer-turn',
            returnTarget: 'newer-route',
          },
          {
            kind: 'terminal-result',
            sourceSequence: 4,
            turnKey: 'older-turn',
            result: 'success',
            occurrenceKey: 'same-occurrence',
          },
          {
            kind: 'terminal-result',
            sourceSequence: 5,
            turnKey: 'newer-turn',
            result: 'success',
            occurrenceKey: 'same-occurrence',
          },
        ]),
      ),
    ).resolves.toEqual({ receivedThrough: 5, appliedThrough: 5, monitoring: 'exact' });

    const records = exchanged.flatMap((exchange) =>
      exchange.kind === 'apply'
        ? exchange.mutations.flatMap((mutation) =>
            mutation.kind === 'create' ? [mutation.record] : [],
          )
        : [],
    );
    expect(records.map(({ returnTarget }) => returnTarget)).toEqual(['older-route', 'newer-route']);
    expect(new Set(records.map(({ key }) => key)).size).toBe(2);
  });

  it('keys outcomes by invocation, connection, authority, foreground thread, and turn', async () => {
    const recordKeys: string[] = [];
    const presentation: AttentionPresentationPort = {
      exchange: vi.fn(async (input): Promise<PresentationReceipt> => {
        if (input.kind === 'apply' && input.mutations[0]?.kind === 'create') {
          recordKeys.push(input.mutations[0].record.key);
        }
        return { kind: 'applied', transactionId: input.transactionId };
      }),
    };
    const variants = [
      {},
      { invocationId: 'different-invocation' },
      { connectionId: 'different-connection' },
      { authorityEpoch: 'different-authority' },
      { foregroundThreadKey: 'different-thread' },
      { turnKey: 'different-turn' },
    ];

    for (const variant of variants) {
      const variantScope = {
        ...scope,
        ...(variant.invocationId === undefined ? {} : { invocationId: variant.invocationId }),
        ...(variant.connectionId === undefined ? {} : { connectionId: variant.connectionId }),
        ...(variant.authorityEpoch === undefined ? {} : { authorityEpoch: variant.authorityEpoch }),
      };
      const foregroundThreadKey = variant.foregroundThreadKey ?? 'thread-1';
      const turnKey = variant.turnKey ?? 'turn-1';
      const normalization = new CodexAttentionNormalizationRegistry(presentation);
      await normalization.exchange({
        kind: 'append',
        deliveryGeneration: 'delivery-1',
        scope: variantScope,
        fromSequence: 1,
        observations: [
          {
            kind: 'connection-qualification',
            sourceSequence: 1,
            initialized: true,
            primary: true,
            capabilities: 'audited',
            foregroundOwnership: 'confirmed',
            evidence: qualificationEvidence({
              requestedThreadKey: foregroundThreadKey,
              announcedThreadKey: foregroundThreadKey,
            }),
          },
          { kind: 'turn-start', sourceSequence: 2, turnKey, returnTarget: 'same-route' },
          {
            kind: 'terminal-result',
            sourceSequence: 3,
            turnKey,
            result: 'success',
            occurrenceKey: 'same-occurrence',
            canonicalTitle: 'Same title',
            canonicalBody: 'Same body',
          },
        ],
      });
    }

    expect(recordKeys).toHaveLength(variants.length);
    expect(new Set(recordKeys).size).toBe(variants.length);
  });
});

function qualificationEvidence(
  overrides: Partial<ConnectionQualificationEvidence> = {},
): ConnectionQualificationEvidence {
  return {
    runtimeVersion: '0.147.0',
    clientName: 'codex-tui',
    clientVersion: '0.147.0',
    experimentalApi: true,
    optedOutNotifications: [],
    serverUserAgent: 'codex_cli_rs/0.147.0',
    initializationRequestKey: 'number:1',
    initializationResponseKey: 'number:1',
    initializationAcknowledged: true,
    foregroundRequestKind: 'start' as const,
    foregroundRequestKey: 'number:2',
    foregroundResponseKey: 'number:2',
    requestedThreadKey: 'thread-1',
    announcedThreadKey: 'thread-1',
    foregroundSessionKey: 'session-root',
    foregroundSource: 'cli' as const,
    foregroundParentKey: null,
    ...overrides,
  };
}

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
