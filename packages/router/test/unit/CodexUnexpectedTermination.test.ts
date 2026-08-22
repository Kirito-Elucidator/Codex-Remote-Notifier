import { describe, expect, it, vi } from 'vitest';

import type {
  AttentionPresentationPort,
  ConnectionQualificationEvidence,
  ObservationExchange,
  PresentationExchange,
  PresentationReceipt,
  SanitizedAttentionObservation,
} from 'remote-notifier-shared/attentionExchange';

import { CodexAttentionNormalizationRegistry } from '../../src/codex/CodexAttentionNormalization';

const scope = {
  invocationId: '0123456789abcdef0123456789abcdef',
  connectionId: 'primary-connection',
  authorityEpoch: 'authority-1',
};

describe('CodexAttentionNormalization unexpected termination', () => {
  it('performs idle end cleanup without scheduling or presenting an outcome', async () => {
    const exchanged: PresentationExchange[] = [];
    const deadlines: Array<{ callback: () => Promise<void>; milliseconds: number }> = [];
    const normalization = new CodexAttentionNormalizationRegistry(
      presentationRecorder(exchanged),
      undefined,
      manualClock(deadlines),
    );

    await expect(
      normalization.exchange(
        append([
          qualification(1),
          {
            kind: 'connection-end',
            sourceSequence: 2,
            endKey: 'foreground-end',
            endSource: 'primary-eof',
            reason: 'app-server-output-closed',
          },
        ]),
      ),
    ).resolves.toEqual({ receivedThrough: 2, appliedThrough: 2, monitoring: 'unavailable' });
    expect(deadlines).toEqual([]);
    expect(exchanged).toEqual([]);
  });

  it('withdraws active requests and reports one generic stopped outcome after five seconds', async () => {
    const exchanged: PresentationExchange[] = [];
    const deadlines: Array<{ callback: () => Promise<void>; milliseconds: number }> = [];
    const normalization = new CodexAttentionNormalizationRegistry(
      presentationRecorder(exchanged),
      undefined,
      manualClock(deadlines),
    );

    await expect(
      normalization.exchange(
        append([
          qualification(1),
          turnStart(2, 'turn-stopped', 'route-stopped'),
          {
            kind: 'human-action-request',
            sourceSequence: 3,
            turnKey: 'turn-stopped',
            requestKey: 'string:approval',
            requestKind: 'approval',
          },
          { kind: 'connection-end', sourceSequence: 4, endKey: 'foreground-end' },
        ]),
      ),
    ).resolves.toEqual({ receivedThrough: 4, appliedThrough: 4, monitoring: 'unavailable' });

    expect(exchanged.at(-1)).toMatchObject({
      kind: 'apply',
      mutations: [{ kind: 'withdraw', key: expect.any(String) }],
    });
    expect(deadlines).toEqual([{ callback: expect.any(Function), milliseconds: 5_000 }]);

    await deadlines[0].callback();

    expect(createdRecords(exchanged).filter(({ appearance }) => appearance === 'failure')).toEqual([
      expect.objectContaining({
        revision: 1,
        canonicalTitle: 'Codex stopped',
        canonicalBody: 'Return to Codex to view details',
        returnTarget: 'route-stopped',
      }),
    ]);
  });

  it('starts the five-second deadline before request withdrawal finishes', async () => {
    const exchanged: PresentationExchange[] = [];
    const deadlines: Array<{ callback: () => Promise<void>; milliseconds: number }> = [];
    let releaseWithdrawal = (): void => {};
    const withdrawalGate = new Promise<void>((resolve) => {
      releaseWithdrawal = resolve;
    });
    const presentation: AttentionPresentationPort = {
      exchange: vi.fn(async (input): Promise<PresentationReceipt> => {
        exchanged.push(input);
        if (
          input.kind === 'apply' &&
          input.mutations.some((mutation) => mutation.kind === 'withdraw')
        ) {
          await withdrawalGate;
        }
        return { kind: 'applied', transactionId: input.transactionId };
      }),
    };
    const normalization = new CodexAttentionNormalizationRegistry(
      presentation,
      undefined,
      manualClock(deadlines),
    );

    const exchange = normalization.exchange(
      append([
        qualification(1),
        turnStart(2, 'turn-slow-withdrawal', 'route-slow-withdrawal'),
        {
          kind: 'human-action-request',
          sourceSequence: 3,
          turnKey: 'turn-slow-withdrawal',
          requestKey: 'string:approval',
          requestKind: 'approval',
        },
        { kind: 'connection-end', sourceSequence: 4, endKey: 'foreground-end' },
      ]),
    );
    await vi.waitFor(() =>
      expect(exchanged.at(-1)).toMatchObject({
        kind: 'apply',
        mutations: [{ kind: 'withdraw' }],
      }),
    );
    const scheduledBeforeWithdrawalFinished = deadlines.map(({ milliseconds }) => milliseconds);
    releaseWithdrawal();
    await exchange;

    expect(scheduledBeforeWithdrawalFinished).toEqual([5_000]);
  });

  it('turns an expired sidecar lease into the same reconciled end boundary', async () => {
    const exchanged: PresentationExchange[] = [];
    const deadlines: Array<{ callback: () => Promise<void>; milliseconds: number }> = [];
    const normalization = new CodexAttentionNormalizationRegistry(
      presentationRecorder(exchanged),
      undefined,
      manualClock(deadlines),
    );

    await normalization.exchange(
      append([
        {
          kind: 'sidecar-lease',
          sourceSequence: 1,
          leaseKey: 'foreground-sidecar',
          expiresAfterMs: 6_000,
        },
        qualification(2),
        turnStart(3, 'turn-lease', 'route-lease'),
        {
          kind: 'human-action-request',
          sourceSequence: 4,
          turnKey: 'turn-lease',
          requestKey: 'string:input',
          requestKind: 'input',
        },
      ]),
    );

    expect(deadlines.map(({ milliseconds }) => milliseconds)).toEqual([6_000]);
    await deadlines[0].callback();
    expect(exchanged.at(-1)).toMatchObject({
      kind: 'apply',
      mutations: [{ kind: 'withdraw', key: expect.any(String) }],
    });
    expect(deadlines.map(({ milliseconds }) => milliseconds)).toEqual([6_000, 5_000]);

    await deadlines[1].callback();
    expect(createdRecords(exchanged).filter(({ appearance }) => appearance === 'failure')).toEqual([
      expect.objectContaining({ canonicalTitle: 'Codex stopped', returnTarget: 'route-lease' }),
    ]);
  });

  it('renews a stable lease without letting an older timer end the turn', async () => {
    const exchanged: PresentationExchange[] = [];
    const deadlines: Array<{ callback: () => Promise<void>; milliseconds: number }> = [];
    const normalization = new CodexAttentionNormalizationRegistry(
      presentationRecorder(exchanged),
      undefined,
      manualClock(deadlines),
    );
    const lease: Extract<SanitizedAttentionObservation, { kind: 'sidecar-lease' }> = {
      kind: 'sidecar-lease',
      sourceSequence: 1,
      leaseKey: 'foreground-sidecar',
      expiresAfterMs: 6_000,
    };

    await normalization.exchange(
      append([lease, qualification(2), turnStart(3, 'turn-renewed', 'route-renewed')]),
    );
    await normalization.exchange(append([lease]));
    expect(deadlines.map(({ milliseconds }) => milliseconds)).toEqual([6_000, 6_000]);

    await deadlines[0].callback();
    expect(deadlines).toHaveLength(2);
    expect(createdRecords(exchanged)).toEqual([]);

    await deadlines[1].callback();
    expect(deadlines.map(({ milliseconds }) => milliseconds)).toEqual([6_000, 6_000, 5_000]);
  });

  it.each([
    {
      name: 'success',
      observations: [
        {
          kind: 'terminal-result',
          sourceSequence: 4,
          turnKey: 'turn-buffered',
          result: 'success',
          occurrenceKey: 'turn-buffered:success',
        },
      ] satisfies SanitizedAttentionObservation[],
      appearance: 'information',
    },
    {
      name: 'failure',
      observations: [
        {
          kind: 'terminal-error',
          sourceSequence: 4,
          turnKey: 'turn-buffered',
          errorKind: 'usageLimitExceeded',
        },
        {
          kind: 'terminal-result',
          sourceSequence: 5,
          turnKey: 'turn-buffered',
          result: 'failure',
          occurrenceKey: 'turn-buffered:failure',
        },
      ] satisfies SanitizedAttentionObservation[],
      appearance: 'failure',
    },
    {
      name: 'interruption',
      observations: [
        { kind: 'interruption', sourceSequence: 4, turnKey: 'turn-buffered' },
      ] satisfies SanitizedAttentionObservation[],
      appearance: undefined,
    },
  ])(
    'lets buffered structured $name settle before the end deadline',
    async ({ observations, appearance }) => {
      const exchanged: PresentationExchange[] = [];
      const deadlines: Array<{ callback: () => Promise<void>; milliseconds: number }> = [];
      const normalization = new CodexAttentionNormalizationRegistry(
        presentationRecorder(exchanged),
        undefined,
        manualClock(deadlines),
      );

      await normalization.exchange(
        append([
          qualification(1),
          turnStart(2, 'turn-buffered', 'route-buffered'),
          { kind: 'connection-end', sourceSequence: 3, endKey: 'foreground-end' },
        ]),
      );
      await normalization.exchange(append(observations, 4));
      await deadlines[0].callback();

      const outcomes = createdRecords(exchanged).filter(
        ({ appearance }) => appearance !== 'action',
      );
      expect(outcomes.some(({ canonicalTitle }) => canonicalTitle === 'Codex stopped')).toBe(false);
      expect(outcomes.map((record) => record.appearance)).toEqual(
        appearance === undefined ? [] : [appearance],
      );
    },
  );

  it('keeps a locally observed user interruption silent when the process then ends', async () => {
    const exchanged: PresentationExchange[] = [];
    const deadlines: Array<{ callback: () => Promise<void>; milliseconds: number }> = [];
    const normalization = new CodexAttentionNormalizationRegistry(
      presentationRecorder(exchanged),
      undefined,
      manualClock(deadlines),
    );

    await normalization.exchange(
      append([
        qualification(1),
        turnStart(2, 'turn-cancelled', 'route-cancelled'),
        {
          kind: 'human-action-request',
          sourceSequence: 3,
          turnKey: 'turn-cancelled',
          requestKey: 'string:approval',
          requestKind: 'approval',
        },
        { kind: 'interruption-intent', sourceSequence: 4, turnKey: 'turn-cancelled' },
        { kind: 'invocation-end', sourceSequence: 5, endKey: 'foreground-end' },
      ]),
    );
    await deadlines[0].callback();

    expect(exchanged.at(-1)).toMatchObject({
      kind: 'apply',
      mutations: [{ kind: 'withdraw', key: expect.any(String) }],
    });
    expect(createdRecords(exchanged).filter(({ appearance }) => appearance === 'failure')).toEqual(
      [],
    );
  });

  it('deduplicates every end source and enriches only the same stopped record', async () => {
    const exchanged: PresentationExchange[] = [];
    const deadlines: Array<{ callback: () => Promise<void>; milliseconds: number }> = [];
    const normalization = new CodexAttentionNormalizationRegistry(
      presentationRecorder(exchanged),
      undefined,
      manualClock(deadlines),
    );
    const ends: SanitizedAttentionObservation[] = [
      {
        kind: 'connection-end',
        sourceSequence: 3,
        endKey: 'foreground-end',
        endSource: 'primary-eof',
        reason: 'usageLimitExceeded',
      },
      {
        kind: 'invocation-end',
        sourceSequence: 4,
        endKey: 'foreground-end',
        endSource: 'process-exit',
        exitCode: 23,
        signal: 'SIGTERM',
        reason: 'foreground-tui-exit',
      },
      {
        kind: 'connection-end',
        sourceSequence: 5,
        endKey: 'foreground-end',
        endSource: 'transport-end',
        reason: 'primary-transport-ended',
      },
    ];

    await normalization.exchange(
      append([qualification(1), turnStart(2, 'turn-deduplicated', 'route-deduplicated'), ...ends]),
    );
    await normalization.exchange(append(ends, 3));
    expect(deadlines).toHaveLength(1);
    await deadlines[0].callback();

    const stopped = createdRecords(exchanged).find(({ appearance }) => appearance === 'failure');
    expect(stopped).toMatchObject({ revision: 1, canonicalTitle: 'Codex stopped' });

    await normalization.exchange(
      append(
        [
          {
            kind: 'terminal-error',
            sourceSequence: 6,
            turnKey: 'turn-deduplicated',
            errorKind: 'usageLimitExceeded',
            canonicalBody: 'The account limit was reached',
          },
          {
            kind: 'terminal-result',
            sourceSequence: 7,
            turnKey: 'turn-deduplicated',
            result: 'failure',
            occurrenceKey: 'turn-deduplicated:failure',
          },
        ],
        6,
      ),
    );

    const terminalCreates = createdRecords(exchanged).filter(
      ({ appearance }) => appearance === 'failure',
    );
    expect(terminalCreates).toHaveLength(1);
    expect(exchanged).toContainEqual(
      expect.objectContaining({
        kind: 'apply',
        mutations: [
          {
            kind: 'update',
            record: expect.objectContaining({
              key: stopped?.key,
              revision: 2,
              canonicalTitle: 'Codex usage limit reached',
            }),
          },
        ],
      }),
    );

    await normalization.exchange({
      kind: 'append',
      deliveryGeneration: 'hook-delivery',
      scope: { ...scope, connectionId: 'hook-connection', authorityEpoch: 'hook-authority' },
      fromSequence: 1,
      observations: [
        { kind: 'authority-change', sourceSequence: 1, monitoring: 'compatibility' },
        turnStart(2, 'turn-deduplicated', 'route-deduplicated'),
        {
          kind: 'terminal-result',
          sourceSequence: 3,
          turnKey: 'turn-deduplicated',
          result: 'failure',
          occurrenceKey: 'hook:turn-deduplicated:failure',
        },
      ],
    });
    expect(
      createdRecords(exchanged).filter(({ appearance }) => appearance === 'failure'),
    ).toHaveLength(1);
  });

  it('treats a Hook end as a duplicate of the protocol end boundary', async () => {
    const exchanged: PresentationExchange[] = [];
    const deadlines: Array<{ callback: () => Promise<void>; milliseconds: number }> = [];
    const normalization = new CodexAttentionNormalizationRegistry(
      presentationRecorder(exchanged),
      undefined,
      manualClock(deadlines),
    );

    await normalization.exchange(
      append([
        qualification(1),
        turnStart(2, 'turn-cross-source', 'route-cross-source'),
        { kind: 'connection-end', sourceSequence: 3, endKey: 'foreground-end' },
      ]),
    );
    await normalization.exchange({
      kind: 'append',
      deliveryGeneration: 'hook-delivery',
      scope: { ...scope, connectionId: 'hook-connection', authorityEpoch: 'hook-authority' },
      fromSequence: 1,
      observations: [
        { kind: 'authority-change', sourceSequence: 1, monitoring: 'compatibility' },
        turnStart(2, 'turn-cross-source', 'route-cross-source'),
        { kind: 'invocation-end', sourceSequence: 3, endKey: 'foreground-end' },
      ],
    });

    expect(deadlines).toHaveLength(1);
    await deadlines[0].callback();
    expect(createdRecords(exchanged).filter(({ appearance }) => appearance === 'failure')).toEqual([
      expect.objectContaining({ canonicalTitle: 'Codex stopped' }),
    ]);
  });

  it('ignores a Hook end until the supervised protocol scope ends', async () => {
    const exchanged: PresentationExchange[] = [];
    const deadlines: Array<{ callback: () => Promise<void>; milliseconds: number }> = [];
    const normalization = new CodexAttentionNormalizationRegistry(
      presentationRecorder(exchanged),
      undefined,
      manualClock(deadlines),
    );

    await normalization.exchange(
      append([qualification(1), turnStart(2, 'turn-hook-first', 'route-hook-first')]),
    );
    await normalization.exchange({
      kind: 'append',
      deliveryGeneration: 'hook-delivery',
      scope: { ...scope, connectionId: 'hook-connection', authorityEpoch: 'hook-authority' },
      fromSequence: 1,
      observations: [
        { kind: 'authority-change', sourceSequence: 1, monitoring: 'compatibility' },
        turnStart(2, 'turn-hook-first', 'route-hook-first'),
        { kind: 'invocation-end', sourceSequence: 3, endKey: 'foreground-end' },
      ],
    });
    expect(deadlines).toEqual([]);

    await normalization.exchange(
      append([{ kind: 'connection-end', sourceSequence: 3, endKey: 'foreground-end' }], 3),
    );
    expect(deadlines).toHaveLength(1);
    await deadlines[0].callback();
    expect(createdRecords(exchanged).filter(({ appearance }) => appearance === 'failure')).toEqual([
      expect.objectContaining({ canonicalTitle: 'Codex stopped' }),
    ]);
  });

  it('reconciles every separately tracked foreground turn at the end boundary', async () => {
    const exchanged: PresentationExchange[] = [];
    const deadlines: Array<{ callback: () => Promise<void>; milliseconds: number }> = [];
    const normalization = new CodexAttentionNormalizationRegistry(
      presentationRecorder(exchanged),
      undefined,
      manualClock(deadlines),
    );

    await normalization.exchange(
      append([
        qualification(1),
        turnStart(2, 'turn-older', 'route-older'),
        turnStart(3, 'turn-newer', 'route-newer'),
        { kind: 'connection-end', sourceSequence: 4, endKey: 'foreground-end' },
      ]),
    );
    expect(deadlines).toHaveLength(1);
    await deadlines[0].callback();

    expect(
      createdRecords(exchanged)
        .filter(({ appearance }) => appearance === 'failure')
        .map(({ canonicalTitle, returnTarget }) => ({ canonicalTitle, returnTarget })),
    ).toEqual([
      { canonicalTitle: 'Codex stopped', returnTarget: 'route-older' },
      { canonicalTitle: 'Codex stopped', returnTarget: 'route-newer' },
    ]);
  });

  it('retries the same stopped transaction after transient presentation failure', async () => {
    const exchanged: PresentationExchange[] = [];
    const deadlines: Array<{ callback: () => Promise<void>; milliseconds: number }> = [];
    let stoppedAttempts = 0;
    const presentation: AttentionPresentationPort = {
      exchange: vi.fn(async (input): Promise<PresentationReceipt> => {
        exchanged.push(input);
        const createsStopped =
          input.kind === 'apply' &&
          input.mutations.some(
            (mutation) =>
              mutation.kind === 'create' && mutation.record.canonicalTitle === 'Codex stopped',
          );
        if (createsStopped && stoppedAttempts++ === 0) throw new Error('temporarily unavailable');
        return { kind: 'applied', transactionId: input.transactionId };
      }),
    };
    const normalization = new CodexAttentionNormalizationRegistry(
      presentation,
      undefined,
      manualClock(deadlines),
    );

    await normalization.exchange(
      append([
        qualification(1),
        turnStart(2, 'turn-retried-stop', 'route-retried-stop'),
        { kind: 'connection-end', sourceSequence: 3, endKey: 'foreground-end' },
      ]),
    );
    await deadlines[0].callback();
    expect(deadlines[1].milliseconds).toBeGreaterThan(100);
    expect(deadlines[1].milliseconds).toBeLessThanOrEqual(125);
    await deadlines[1].callback();

    const attempts = exchanged.filter(
      (exchange) =>
        exchange.kind === 'apply' &&
        exchange.mutations.some(
          (mutation) =>
            mutation.kind === 'create' && mutation.record.canonicalTitle === 'Codex stopped',
        ),
    );
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(deadlines).toHaveLength(2);
  });

  it('stops retrying a stopped transaction after terminal rejection', async () => {
    const exchanged: PresentationExchange[] = [];
    const deadlines: Array<{ callback: () => Promise<void>; milliseconds: number }> = [];
    const presentation: AttentionPresentationPort = {
      exchange: vi.fn(async (input): Promise<PresentationReceipt> => {
        exchanged.push(input);
        const createsStopped =
          input.kind === 'apply' &&
          input.mutations.some(
            (mutation) =>
              mutation.kind === 'create' && mutation.record.canonicalTitle === 'Codex stopped',
          );
        return createsStopped
          ? { kind: 'rejected', transactionId: input.transactionId, reason: 'invalid' }
          : { kind: 'applied', transactionId: input.transactionId };
      }),
    };
    const normalization = new CodexAttentionNormalizationRegistry(
      presentation,
      undefined,
      manualClock(deadlines),
    );

    await normalization.exchange(
      append([
        qualification(1),
        turnStart(2, 'turn-terminal-rejection', 'route-terminal-rejection'),
        { kind: 'connection-end', sourceSequence: 3, endKey: 'foreground-end' },
      ]),
    );
    await deadlines[0].callback();

    expect(deadlines).toHaveLength(1);
    expect(
      exchanged.filter(
        (exchange) =>
          exchange.kind === 'apply' &&
          exchange.mutations.some((mutation) => mutation.kind === 'create'),
      ),
    ).toHaveLength(1);
  });

  it('resets stopped delivery backoff when another turn makes forward progress', async () => {
    const deadlines: Array<{ callback: () => Promise<void>; milliseconds: number }> = [];
    const attempts = new Map<string, number>();
    const presentation: AttentionPresentationPort = {
      exchange: vi.fn(async (input): Promise<PresentationReceipt> => {
        const create =
          input.kind === 'apply'
            ? input.mutations.find((mutation) => mutation.kind === 'create')
            : undefined;
        if (create?.kind === 'create') {
          const target = create.record.returnTarget;
          const attempt = (attempts.get(target) ?? 0) + 1;
          attempts.set(target, attempt);
          if (target === 'route-backoff-b' || attempt === 1) {
            throw new Error('temporarily unavailable');
          }
        }
        return { kind: 'applied', transactionId: input.transactionId };
      }),
    };
    const normalization = new CodexAttentionNormalizationRegistry(
      presentation,
      undefined,
      manualClock(deadlines),
    );

    await normalization.exchange(
      append([
        qualification(1),
        turnStart(2, 'turn-backoff-a', 'route-backoff-a'),
        turnStart(3, 'turn-backoff-b', 'route-backoff-b'),
        { kind: 'connection-end', sourceSequence: 4, endKey: 'foreground-end' },
      ]),
    );
    await deadlines[0].callback();
    await deadlines[1].callback();

    expect(deadlines[2].milliseconds).toBeGreaterThan(100);
    expect(deadlines[2].milliseconds).toBeLessThanOrEqual(125);
  });

  it('keeps identical compatibility turn ids separately scoped at termination', async () => {
    const exchanged: PresentationExchange[] = [];
    const deadlines: Array<{ callback: () => Promise<void>; milliseconds: number }> = [];
    const normalization = new CodexAttentionNormalizationRegistry(
      presentationRecorder(exchanged),
      undefined,
      manualClock(deadlines),
    );
    const firstScope = {
      ...scope,
      connectionId: 'compatibility-connection-a',
      authorityEpoch: 'compatibility-authority-a',
    };
    const secondScope = {
      ...scope,
      connectionId: 'compatibility-connection-b',
      authorityEpoch: 'compatibility-authority-b',
    };

    await normalization.exchange({
      kind: 'append',
      deliveryGeneration: 'compatibility-a',
      scope: firstScope,
      fromSequence: 1,
      observations: [
        { kind: 'authority-change', sourceSequence: 1, monitoring: 'compatibility' },
        turnStart(2, 'shared-local-turn', 'route-compatibility-a'),
      ],
    });
    await normalization.exchange({
      kind: 'append',
      deliveryGeneration: 'compatibility-b',
      scope: secondScope,
      fromSequence: 1,
      observations: [
        { kind: 'authority-change', sourceSequence: 1, monitoring: 'compatibility' },
        turnStart(2, 'shared-local-turn', 'route-compatibility-b'),
      ],
    });
    await normalization.exchange({
      kind: 'append',
      deliveryGeneration: 'compatibility-a',
      scope: firstScope,
      fromSequence: 3,
      observations: [{ kind: 'invocation-end', sourceSequence: 3, endKey: 'foreground-end' }],
    });
    await deadlines[0].callback();

    expect(
      createdRecords(exchanged)
        .filter(({ appearance }) => appearance === 'failure')
        .map(({ returnTarget }) => returnTarget),
    ).toEqual(['route-compatibility-a', 'route-compatibility-b']);
  });

  it('keeps a stopped outcome when a conflicting success arrives after the deadline', async () => {
    const exchanged: PresentationExchange[] = [];
    const deadlines: Array<{ callback: () => Promise<void>; milliseconds: number }> = [];
    const normalization = new CodexAttentionNormalizationRegistry(
      presentationRecorder(exchanged),
      undefined,
      manualClock(deadlines),
    );

    await normalization.exchange(
      append([
        qualification(1),
        turnStart(2, 'turn-late', 'route-late'),
        { kind: 'connection-end', sourceSequence: 3, endKey: 'foreground-end' },
      ]),
    );
    await deadlines[0].callback();
    await expect(
      normalization.exchange(
        append(
          [
            {
              kind: 'terminal-result',
              sourceSequence: 4,
              turnKey: 'turn-late',
              result: 'success',
              occurrenceKey: 'turn-late:success',
            },
          ],
          4,
        ),
      ),
    ).resolves.toMatchObject({ monitoring: 'degraded' });

    expect(createdRecords(exchanged).filter(({ appearance }) => appearance !== 'action')).toEqual([
      expect.objectContaining({ canonicalTitle: 'Codex stopped' }),
    ]);
  });
});

function presentationRecorder(exchanged: PresentationExchange[]): AttentionPresentationPort {
  return {
    exchange: vi.fn(async (input): Promise<PresentationReceipt> => {
      exchanged.push(input);
      return { kind: 'applied', transactionId: input.transactionId };
    }),
  };
}

function manualClock(deadlines: Array<{ callback: () => Promise<void>; milliseconds: number }>) {
  return {
    setTimeout(callback: () => Promise<void>, milliseconds: number): void {
      deadlines.push({ callback, milliseconds });
    },
  };
}

function createdRecords(exchanges: PresentationExchange[]) {
  return exchanges.flatMap((exchange) =>
    exchange.kind === 'apply'
      ? exchange.mutations.flatMap((mutation) =>
          mutation.kind === 'create' ? [mutation.record] : [],
        )
      : [],
  );
}

function qualification(
  sourceSequence: number,
): Extract<SanitizedAttentionObservation, { kind: 'connection-qualification' }> {
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

function qualificationEvidence(): ConnectionQualificationEvidence {
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
    foregroundRequestKind: 'start',
    foregroundRequestKey: 'number:2',
    foregroundResponseKey: 'number:2',
    requestedThreadKey: 'thread-1',
    announcedThreadKey: 'thread-1',
    foregroundSessionKey: 'session-root',
    foregroundSource: 'cli',
    foregroundParentKey: null,
  };
}

function turnStart(
  sourceSequence: number,
  turnKey: string,
  returnTarget: string,
): Extract<SanitizedAttentionObservation, { kind: 'turn-start' }> {
  return { kind: 'turn-start', sourceSequence, turnKey, returnTarget };
}

function append(
  observations: SanitizedAttentionObservation[],
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
