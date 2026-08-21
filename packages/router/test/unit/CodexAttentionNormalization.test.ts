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
  it('labels Hook-derived attention as Compatibility and reports a no-source state', async () => {
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
          { kind: 'authority-change', sourceSequence: 1, monitoring: 'compatibility' },
          {
            kind: 'turn-start',
            sourceSequence: 2,
            turnKey: 'hook-turn',
            returnTarget: 'hook-route',
          },
          {
            kind: 'terminal-result',
            sourceSequence: 3,
            turnKey: 'hook-turn',
            result: 'success',
            occurrenceKey: 'hook-stop',
            canonicalTitle: 'Codex completed',
          },
        ]),
      ),
    ).resolves.toEqual({ receivedThrough: 3, appliedThrough: 3, monitoring: 'compatibility' });

    expect(exchanged).toMatchObject([
      {
        kind: 'apply',
        mutations: [
          {
            kind: 'create',
            record: {
              canonicalTitle: '[Compatibility] Codex completed',
              returnTarget: 'hook-route',
            },
          },
        ],
      },
    ]);

    await expect(
      normalization.exchange(
        append([{ kind: 'authority-change', sourceSequence: 4, monitoring: 'unavailable' }], 4),
      ),
    ).resolves.toEqual({ receivedThrough: 4, appliedThrough: 4, monitoring: 'unavailable' });
    expect(exchanged).toHaveLength(1);
  });

  it('keeps unsupported and upgraded protocol shapes in Compatibility', async () => {
    const presentation: AttentionPresentationPort = { exchange: vi.fn() };

    for (const runtimeVersion of ['0.144.9', '0.148.0', '1.0.0']) {
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
                runtimeVersion,
                clientVersion: runtimeVersion,
                serverUserAgent: `codex_cli_rs/${runtimeVersion}`,
              }),
            },
          ]),
        ),
      ).resolves.toEqual({ receivedThrough: 1, appliedThrough: 1, monitoring: 'compatibility' });
    }

    expect(presentation.exchange).not.toHaveBeenCalled();
  });

  it('publishes bounded monitoring changes without presenting attention', async () => {
    const monitoring = vi.fn();
    const presentation: AttentionPresentationPort = { exchange: vi.fn() };
    const normalization = new CodexAttentionNormalizationRegistry(presentation, monitoring);

    await normalization.exchange(
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
        { kind: 'authority-change', sourceSequence: 2, monitoring: 'unavailable' },
      ]),
    );

    expect(monitoring.mock.calls).toEqual([
      [
        {
          invocationId: scope.invocationId,
          foregroundThreadKey: 'thread-1',
          monitoring: 'exact',
          reason: 'protocol-qualified',
        },
      ],
      [
        {
          invocationId: scope.invocationId,
          monitoring: 'unavailable',
          reason: 'no-source',
        },
      ],
    ]);
    expect(presentation.exchange).not.toHaveBeenCalled();
  });

  it('removes monitoring state when the foreground invocation ends', async () => {
    const monitoring = vi.fn();
    const normalization = new CodexAttentionNormalizationRegistry(
      { exchange: vi.fn() },
      monitoring,
    );

    await expect(
      normalization.exchange(
        append([
          qualification(1),
          { kind: 'invocation-end', sourceSequence: 2, endKey: 'foreground-tui-exit' },
        ]),
      ),
    ).resolves.toEqual({ receivedThrough: 2, appliedThrough: 2, monitoring: 'unavailable' });
    expect(monitoring.mock.calls).toEqual([
      [
        {
          invocationId: scope.invocationId,
          foregroundThreadKey: 'thread-1',
          monitoring: 'exact',
          reason: 'protocol-qualified',
        },
      ],
      [
        {
          invocationId: scope.invocationId,
          ended: true,
          reason: 'invocation-ended',
        },
      ],
    ]);
  });

  it('hands matching Hook observations to qualified protocol authority by identity', async () => {
    const exchanged: PresentationExchange[] = [];
    const presentation: AttentionPresentationPort = {
      exchange: vi.fn(async (input): Promise<PresentationReceipt> => {
        exchanged.push(input);
        return { kind: 'applied', transactionId: input.transactionId };
      }),
    };
    const normalization = new CodexAttentionNormalizationRegistry(presentation);
    const hookScope = {
      ...scope,
      connectionId: 'hook-compatibility',
      authorityEpoch: 'hook-epoch-1',
    };

    await expect(
      normalization.exchange(
        appendFor(hookScope, [
          { kind: 'authority-change', sourceSequence: 1, monitoring: 'compatibility' },
          {
            kind: 'turn-start',
            sourceSequence: 2,
            turnKey: 'shared-turn',
            returnTarget: 'hook-route',
          },
        ]),
      ),
    ).resolves.toEqual({ receivedThrough: 2, appliedThrough: 2, monitoring: 'compatibility' });

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
            turnKey: 'shared-turn',
            returnTarget: 'protocol-route',
          },
          {
            kind: 'terminal-result',
            sourceSequence: 3,
            turnKey: 'shared-turn',
            result: 'success',
            occurrenceKey: 'protocol-success',
          },
        ]),
      ),
    ).resolves.toEqual({ receivedThrough: 3, appliedThrough: 3, monitoring: 'exact' });

    await expect(
      normalization.exchange(
        appendFor(
          hookScope,
          [
            {
              kind: 'terminal-result',
              sourceSequence: 3,
              turnKey: 'shared-turn',
              result: 'success',
              occurrenceKey: 'hook-stop',
            },
          ],
          3,
        ),
      ),
    ).resolves.toEqual({ receivedThrough: 3, appliedThrough: 3, monitoring: 'exact' });

    expect(exchanged).toHaveLength(1);
    expect(exchanged[0]).toMatchObject({
      kind: 'apply',
      mutations: [{ kind: 'create', record: { returnTarget: 'protocol-route' } }],
    });
  });

  it('closes a lost exact epoch and recovers only at a later turn boundary', async () => {
    const exchanged: PresentationExchange[] = [];
    const presentation: AttentionPresentationPort = {
      exchange: vi.fn(async (input): Promise<PresentationReceipt> => {
        exchanged.push(input);
        return { kind: 'applied', transactionId: input.transactionId };
      }),
    };
    const normalization = new CodexAttentionNormalizationRegistry(presentation);

    await normalization.exchange(
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
          turnKey: 'interrupted-turn',
          returnTarget: 'protocol-old-route',
        },
      ]),
    );
    await expect(
      normalization.exchange(
        append([{ kind: 'authority-change', sourceSequence: 3, monitoring: 'compatibility' }], 3),
      ),
    ).resolves.toEqual({ receivedThrough: 3, appliedThrough: 3, monitoring: 'compatibility' });
    await expect(
      normalization.exchange(
        append(
          [
            {
              kind: 'connection-qualification',
              sourceSequence: 4,
              initialized: true,
              primary: true,
              capabilities: 'audited',
              foregroundOwnership: 'confirmed',
              evidence: qualificationEvidence(),
            },
          ],
          4,
        ),
      ),
    ).resolves.toEqual({ receivedThrough: 4, appliedThrough: 4, monitoring: 'compatibility' });

    const hookScope = {
      ...scope,
      connectionId: 'hook-after-loss',
      authorityEpoch: 'hook-epoch-after-loss',
    };
    await expect(
      normalization.exchange(
        appendFor(hookScope, [
          { kind: 'authority-change', sourceSequence: 1, monitoring: 'compatibility' },
          {
            kind: 'turn-start',
            sourceSequence: 2,
            turnKey: 'interrupted-turn',
            returnTarget: 'hook-route',
          },
          {
            kind: 'terminal-result',
            sourceSequence: 3,
            turnKey: 'interrupted-turn',
            result: 'success',
            occurrenceKey: 'hook-stop',
          },
        ]),
      ),
    ).resolves.toEqual({ receivedThrough: 3, appliedThrough: 3, monitoring: 'compatibility' });

    const recoveredScope = {
      ...scope,
      connectionId: 'connection-recovered',
      authorityEpoch: 'authority-2',
    };
    await expect(
      normalization.exchange(
        appendFor(recoveredScope, [
          {
            kind: 'connection-qualification',
            sourceSequence: 1,
            initialized: true,
            primary: true,
            capabilities: 'audited',
            foregroundOwnership: 'confirmed',
            evidence: qualificationEvidence(),
          },
        ]),
      ),
    ).resolves.toEqual({ receivedThrough: 1, appliedThrough: 1, monitoring: 'compatibility' });
    await expect(
      normalization.exchange(reconcileFor(recoveredScope, qualification(1))),
    ).resolves.toEqual({ receivedThrough: 1, appliedThrough: 1, monitoring: 'compatibility' });
    await expect(
      normalization.exchange(
        appendFor(
          recoveredScope,
          [
            {
              kind: 'turn-start',
              sourceSequence: 2,
              turnKey: 'later-turn',
              returnTarget: 'protocol-new-route',
            },
            {
              kind: 'terminal-result',
              sourceSequence: 3,
              turnKey: 'later-turn',
              result: 'success',
              occurrenceKey: 'later-success',
            },
          ],
          2,
        ),
      ),
    ).resolves.toEqual({ receivedThrough: 3, appliedThrough: 3, monitoring: 'exact' });

    const records = exchanged.flatMap((exchange) =>
      exchange.kind === 'apply'
        ? exchange.mutations.flatMap((mutation) =>
            mutation.kind === 'create' ? [mutation.record] : [],
          )
        : [],
    );
    expect(records).toMatchObject([
      { canonicalTitle: '[Compatibility] Codex completed', returnTarget: 'hook-route' },
      { canonicalTitle: 'Codex completed', returnTarget: 'protocol-new-route' },
    ]);
  });

  it('withdraws protocol-owned requests before closing authority', async () => {
    const exchanged: PresentationExchange[] = [];
    const presentation: AttentionPresentationPort = {
      exchange: vi.fn(async (input): Promise<PresentationReceipt> => {
        exchanged.push(input);
        return { kind: 'applied', transactionId: input.transactionId };
      }),
    };
    const normalization = new CodexAttentionNormalizationRegistry(presentation);

    await normalization.exchange(
      append([
        qualification(1),
        {
          kind: 'turn-start',
          sourceSequence: 2,
          turnKey: 'active-turn',
          returnTarget: 'protocol-route',
        },
        {
          kind: 'human-action-request',
          sourceSequence: 3,
          turnKey: 'active-turn',
          requestKey: 'string:approval-1',
          requestKind: 'approval',
        },
      ]),
    );
    await expect(
      normalization.exchange(
        append([{ kind: 'authority-change', sourceSequence: 4, monitoring: 'compatibility' }], 4),
      ),
    ).resolves.toEqual({ receivedThrough: 4, appliedThrough: 4, monitoring: 'compatibility' });

    expect(exchanged).toHaveLength(2);
    const create = exchanged[0].kind === 'apply' ? exchanged[0].mutations[0] : undefined;
    expect(create).toMatchObject({
      kind: 'create',
      record: { appearance: 'action', returnTarget: 'protocol-route' },
    });
    const requestKey = create?.kind === 'create' ? create.record.key : undefined;
    expect(exchanged[1]).toMatchObject({
      kind: 'apply',
      mutations: [{ kind: 'withdraw', key: requestKey }],
    });
  });

  it('keeps simultaneous typed request identities independent through denial and replay', async () => {
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
          qualification(1),
          { kind: 'turn-start', sourceSequence: 2, turnKey: 'turn-1', returnTarget: 'route-1' },
          {
            kind: 'human-action-request',
            sourceSequence: 3,
            turnKey: 'turn-1',
            requestKey: 'number:1',
            requestKind: 'approval',
            canonicalBody: 'Same visible request',
          },
          {
            kind: 'human-action-request',
            sourceSequence: 4,
            turnKey: 'turn-1',
            requestKey: 'string:1',
            requestKind: 'approval',
            canonicalBody: 'Same visible request',
          },
          {
            kind: 'request-resolution',
            sourceSequence: 5,
            turnKey: 'turn-1',
            requestKey: 'number:1',
          },
          {
            kind: 'human-action-request',
            sourceSequence: 6,
            turnKey: 'turn-1',
            requestKey: 'number:1',
            requestKind: 'approval',
            canonicalBody: 'Replayed after denial',
          },
        ]),
      ),
    ).resolves.toEqual({ receivedThrough: 6, appliedThrough: 6, monitoring: 'exact' });

    expect(exchanged).toHaveLength(3);
    const first = exchanged[0].kind === 'apply' ? exchanged[0].mutations[0] : undefined;
    const second = exchanged[1].kind === 'apply' ? exchanged[1].mutations[0] : undefined;
    expect(first).toMatchObject({
      kind: 'create',
      record: { canonicalBody: 'Same visible request' },
    });
    expect(second).toMatchObject({
      kind: 'create',
      record: { canonicalBody: 'Same visible request' },
    });
    const firstKey = first?.kind === 'create' ? first.record.key : undefined;
    const secondKey = second?.kind === 'create' ? second.record.key : undefined;
    expect(firstKey).not.toBe(secondKey);
    expect(exchanged[2]).toMatchObject({
      kind: 'apply',
      mutations: [{ kind: 'withdraw', key: firstKey }],
    });
  });

  it('suppresses requests delivered after their resolution or terminal turn tombstone', async () => {
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
          qualification(1),
          { kind: 'turn-start', sourceSequence: 2, turnKey: 'turn-1', returnTarget: 'route-1' },
          {
            kind: 'request-resolution',
            sourceSequence: 3,
            turnKey: 'turn-1',
            requestKey: 'string:late',
          },
          {
            kind: 'human-action-request',
            sourceSequence: 4,
            turnKey: 'turn-1',
            requestKey: 'string:late',
            requestKind: 'input',
          },
          {
            kind: 'terminal-result',
            sourceSequence: 5,
            turnKey: 'turn-1',
            result: 'success',
            occurrenceKey: 'turn-1:success',
          },
          {
            kind: 'human-action-request',
            sourceSequence: 6,
            turnKey: 'turn-1',
            requestKey: 'string:post-terminal',
            requestKind: 'permission',
          },
        ]),
      ),
    ).resolves.toEqual({ receivedThrough: 6, appliedThrough: 6, monitoring: 'exact' });

    expect(exchanged).toHaveLength(1);
    expect(exchanged[0]).toMatchObject({
      kind: 'apply',
      mutations: [{ kind: 'create', record: { appearance: 'information' } }],
    });
  });

  it('atomically withdraws every pending request before creating the terminal outcome', async () => {
    const exchanged: PresentationExchange[] = [];
    const presentation: AttentionPresentationPort = {
      exchange: vi.fn(async (input): Promise<PresentationReceipt> => {
        exchanged.push(input);
        return { kind: 'applied', transactionId: input.transactionId };
      }),
    };
    const normalization = new CodexAttentionNormalizationRegistry(presentation);

    await normalization.exchange(
      append([
        qualification(1),
        { kind: 'turn-start', sourceSequence: 2, turnKey: 'turn-1', returnTarget: 'route-1' },
        {
          kind: 'human-action-request',
          sourceSequence: 3,
          turnKey: 'turn-1',
          requestKey: 'number:7',
          requestKind: 'approval',
        },
        {
          kind: 'human-action-request',
          sourceSequence: 4,
          turnKey: 'turn-1',
          requestKey: 'string:7',
          requestKind: 'elicitation',
        },
        {
          kind: 'terminal-result',
          sourceSequence: 5,
          turnKey: 'turn-1',
          result: 'success',
          occurrenceKey: 'turn-1:success',
        },
      ]),
    );

    const requestKeys = exchanged.slice(0, 2).map((exchange) => {
      const mutation = exchange.kind === 'apply' ? exchange.mutations[0] : undefined;
      if (mutation?.kind !== 'create') throw new Error('expected request create');
      return mutation.record.key;
    });
    expect(exchanged[2]).toMatchObject({
      kind: 'apply',
      mutations: [
        { kind: 'withdraw', key: requestKeys[0] },
        { kind: 'withdraw', key: requestKeys[1] },
        { kind: 'create', record: { appearance: 'information', returnTarget: 'route-1' } },
      ],
    });
  });

  it('withdraws pending requests and suppresses stale delivery at a failed terminal boundary', async () => {
    const exchanged: PresentationExchange[] = [];
    const presentation: AttentionPresentationPort = {
      exchange: vi.fn(async (input): Promise<PresentationReceipt> => {
        exchanged.push(input);
        return { kind: 'applied', transactionId: input.transactionId };
      }),
    };
    const normalization = new CodexAttentionNormalizationRegistry(presentation);

    await normalization.exchange(
      append([
        qualification(1),
        { kind: 'turn-start', sourceSequence: 2, turnKey: 'turn-1', returnTarget: 'route-1' },
        {
          kind: 'human-action-request',
          sourceSequence: 3,
          turnKey: 'turn-1',
          requestKey: 'string:approval',
          requestKind: 'approval',
        },
        {
          kind: 'terminal-result',
          sourceSequence: 4,
          turnKey: 'turn-1',
          result: 'failure',
          occurrenceKey: 'turn-1:failure',
        },
        {
          kind: 'human-action-request',
          sourceSequence: 5,
          turnKey: 'turn-1',
          requestKey: 'string:late',
          requestKind: 'approval',
        },
      ]),
    );

    const create = exchanged[0].kind === 'apply' ? exchanged[0].mutations[0] : undefined;
    const requestKey = create?.kind === 'create' ? create.record.key : undefined;
    expect(exchanged).toHaveLength(2);
    expect(exchanged[1]).toMatchObject({
      kind: 'apply',
      mutations: [{ kind: 'withdraw', key: requestKey }],
    });
  });

  it('does not restore exact authority for an interrupted turn identity', async () => {
    const presentation: AttentionPresentationPort = { exchange: vi.fn() };
    const normalization = new CodexAttentionNormalizationRegistry(presentation);
    await normalization.exchange(
      append([
        qualification(1),
        { kind: 'turn-start', sourceSequence: 2, turnKey: 'same-turn', returnTarget: 'old-route' },
        { kind: 'authority-change', sourceSequence: 3, monitoring: 'compatibility' },
      ]),
    );
    const recoveredScope = { ...scope, connectionId: 'recovered', authorityEpoch: 'authority-2' };
    await normalization.exchange(appendFor(recoveredScope, [qualification(1)]));
    await normalization.exchange(reconcileFor(recoveredScope, qualification(1)));

    await expect(
      normalization.exchange(
        appendFor(
          recoveredScope,
          [
            {
              kind: 'turn-start',
              sourceSequence: 2,
              turnKey: 'same-turn',
              returnTarget: 'new-route',
            },
          ],
          2,
        ),
      ),
    ).resolves.toEqual({ receivedThrough: 2, appliedThrough: 2, monitoring: 'compatibility' });
  });

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
    ).resolves.toEqual({ receivedThrough: 5, appliedThrough: 5, monitoring: 'degraded' });

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

function qualification(
  sourceSequence: number,
): Extract<
  Extract<ObservationExchange, { kind: 'append' }>['observations'][number],
  { kind: 'connection-qualification' }
> {
  return {
    kind: 'connection-qualification',
    sourceSequence,
    initialized: true,
    primary: true,
    capabilities: 'audited',
    foregroundOwnership: 'confirmed',
    evidence: qualificationEvidence(),
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

function appendFor(
  exchangeScope: ObservationExchange['scope'],
  observations: Extract<ObservationExchange, { kind: 'append' }>['observations'],
  fromSequence = 1,
): ObservationExchange {
  return {
    kind: 'append',
    deliveryGeneration: 'delivery-1',
    scope: exchangeScope,
    fromSequence,
    observations,
  };
}

function reconcileFor(
  exchangeScope: ObservationExchange['scope'],
  qualificationObservation: Extract<
    Extract<ObservationExchange, { kind: 'append' }>['observations'][number],
    { kind: 'connection-qualification' }
  >,
): ObservationExchange {
  return {
    kind: 'reconcile',
    deliveryGeneration: 'delivery-1',
    scope: exchangeScope,
    retainedRange: { fromSequence: 1, throughSequence: qualificationObservation.sourceSequence },
    checkpoint: {
      throughSequence: qualificationObservation.sourceSequence,
      monitoring: 'exact',
      observations: [qualificationObservation],
    },
    tail: [],
  };
}
