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

describe('CodexAttentionNormalization terminal outcomes', () => {
  it('can silence successful turns while surfacing retryable errors immediately', async () => {
    const exchanged: PresentationExchange[] = [];
    const normalization = new CodexAttentionNormalizationRegistry(
      presentationRecorder(exchanged),
      undefined,
      undefined,
      { notifySuccessfulTurns: false, notifyRetryableErrors: true },
    );

    await normalization.exchange(
      append([
        qualification(1),
        turnStart(2, 'turn-alerts', 'route-alerts'),
        {
          kind: 'retry-error',
          sourceSequence: 3,
          turnKey: 'turn-alerts',
          errorKind: 'serverOverloaded',
          canonicalBody: 'Selected model is at capacity',
        },
        {
          kind: 'terminal-result',
          sourceSequence: 4,
          turnKey: 'turn-alerts',
          result: 'success',
          occurrenceKey: 'turn-alerts:success',
        },
      ]),
    );

    expect(createdRecords(exchanged)).toEqual([
      expect.objectContaining({
        appearance: 'failure',
        canonicalTitle: 'Codex service failed',
        canonicalBody: 'Selected model is at capacity',
      }),
    ]);
  });

  it('waits for five reconnect failures before surfacing an exact-mode alert', async () => {
    const exchanged: PresentationExchange[] = [];
    const normalization = new CodexAttentionNormalizationRegistry(
      presentationRecorder(exchanged),
      undefined,
      undefined,
      { notifyRetryableErrors: true, reconnectionAlertThreshold: 5 },
    );
    const observations: SanitizedAttentionObservation[] = [
      qualification(1),
      turnStart(2, 'turn-reconnect', 'route-reconnect'),
    ];
    for (let attempt = 0; attempt < 5; attempt++) {
      observations.push({
        kind: 'retry-error',
        sourceSequence: 3 + attempt,
        turnKey: 'turn-reconnect',
        errorKind: 'responseStreamDisconnected',
        canonicalBody: 'temporary disconnect',
      });
    }
    await normalization.exchange(append(observations));
    expect(createdRecords(exchanged)).toHaveLength(1);
  });

  it('starts a fresh reconnect alert sequence after a non-connection retry', async () => {
    const exchanged: PresentationExchange[] = [];
    const normalization = new CodexAttentionNormalizationRegistry(
      presentationRecorder(exchanged),
      undefined,
      undefined,
      { notifyRetryableErrors: true, reconnectionAlertThreshold: 2 },
    );
    await normalization.exchange(
      append([
        qualification(1),
        turnStart(2, 'turn-reset', 'route-reset'),
        {
          kind: 'retry-error',
          sourceSequence: 3,
          turnKey: 'turn-reset',
          errorKind: 'responseStreamDisconnected',
          canonicalBody: 'temporary disconnect',
        },
        {
          kind: 'retry-error',
          sourceSequence: 4,
          turnKey: 'turn-reset',
          errorKind: 'responseStreamDisconnected',
          canonicalBody: 'temporary disconnect',
        },
        {
          kind: 'retry-error',
          sourceSequence: 5,
          turnKey: 'turn-reset',
          errorKind: 'serverOverloaded',
          canonicalBody: 'model overloaded',
        },
        {
          kind: 'retry-error',
          sourceSequence: 6,
          turnKey: 'turn-reset',
          errorKind: 'responseStreamDisconnected',
          canonicalBody: 'temporary disconnect',
        },
        {
          kind: 'retry-error',
          sourceSequence: 7,
          turnKey: 'turn-reset',
          errorKind: 'responseStreamDisconnected',
          canonicalBody: 'temporary disconnect',
        },
      ]),
    );

    expect(createdRecords(exchanged)).toHaveLength(3);
  });

  it('retries an exact-mode reconnect alert when its first presentation is unavailable', async () => {
    const exchanged: PresentationExchange[] = [];
    const presentation: AttentionPresentationPort = {
      exchange: vi.fn(async (input): Promise<PresentationReceipt> => {
        exchanged.push(input);
        if (exchanged.length === 1) {
          return { kind: 'rejected', transactionId: input.transactionId, reason: 'unavailable' };
        }
        return { kind: 'applied', transactionId: input.transactionId };
      }),
    };
    const normalization = new CodexAttentionNormalizationRegistry(
      presentation,
      undefined,
      undefined,
      { notifyRetryableErrors: true },
    );
    await normalization.exchange(
      append([
        qualification(1),
        turnStart(2, 'turn-delivery-retry', 'route-delivery-retry'),
        {
          kind: 'retry-error',
          sourceSequence: 3,
          turnKey: 'turn-delivery-retry',
          errorKind: 'responseStreamDisconnected',
          canonicalBody: 'temporary disconnect',
        },
      ]),
    );
    await normalization.exchange(
      append(
        [
          {
            kind: 'retry-error',
            sourceSequence: 3,
            turnKey: 'turn-delivery-retry',
            errorKind: 'responseStreamDisconnected',
            canonicalBody: 'temporary disconnect',
          },
        ],
        3,
      ),
    );

    expect(presentation.exchange).toHaveBeenCalledTimes(2);
    expect(exchanged.at(-1)).toMatchObject({
      kind: 'apply',
      mutations: [{ kind: 'create', record: { appearance: 'failure' } }],
    });
  });

  it('keeps a recovered retry silent and commits only its final success', async () => {
    const exchanged: PresentationExchange[] = [];
    const normalization = new CodexAttentionNormalizationRegistry(presentationRecorder(exchanged));

    await expect(
      normalization.exchange(
        append([
          qualification(1),
          turnStart(2, 'turn-recovered', 'route-recovered'),
          {
            kind: 'retry-error',
            sourceSequence: 3,
            turnKey: 'turn-recovered',
            errorKind: 'responseStreamDisconnected',
            canonicalBody: 'temporary disconnect',
          },
          {
            kind: 'terminal-result',
            sourceSequence: 4,
            turnKey: 'turn-recovered',
            result: 'success',
            occurrenceKey: 'turn-recovered:success',
            canonicalTitle: 'Codex plan completed',
            canonicalBody: '计划完成 🙂 e\u0301',
          },
        ]),
      ),
    ).resolves.toEqual({ receivedThrough: 4, appliedThrough: 4, monitoring: 'exact' });

    expect(createdRecords(exchanged)).toEqual([
      expect.objectContaining({
        revision: 1,
        appearance: 'information',
        canonicalTitle: 'Codex plan completed',
        canonicalBody: '计划完成 🙂 e\u0301',
        returnTarget: 'route-recovered',
      }),
    ]);
  });

  it('stages exhausted retry detail until failure and then creates one classified outcome', async () => {
    const exchanged: PresentationExchange[] = [];
    const normalization = new CodexAttentionNormalizationRegistry(presentationRecorder(exchanged));

    await normalization.exchange(
      append([
        qualification(1),
        turnStart(2, 'turn-exhausted', 'route-exhausted'),
        {
          kind: 'human-action-request',
          sourceSequence: 3,
          turnKey: 'turn-exhausted',
          requestKey: 'string:approval',
          requestKind: 'approval',
        },
        {
          kind: 'retry-error',
          sourceSequence: 4,
          turnKey: 'turn-exhausted',
          errorKind: 'responseStreamDisconnected',
          canonicalBody: 'retrying',
        },
        {
          kind: 'terminal-error',
          sourceSequence: 5,
          turnKey: 'turn-exhausted',
          errorKind: 'usageLimitExceeded',
          canonicalBody: 'The account limit was reached',
        },
      ]),
    );

    expect(createdRecords(exchanged)).toHaveLength(1);
    await expect(
      normalization.exchange(
        append(
          [
            {
              kind: 'terminal-result',
              sourceSequence: 6,
              turnKey: 'turn-exhausted',
              result: 'failure',
              occurrenceKey: 'turn-exhausted:failure',
            },
          ],
          6,
        ),
      ),
    ).resolves.toEqual({ receivedThrough: 6, appliedThrough: 6, monitoring: 'exact' });

    const terminalExchange = exchanged.at(-1);
    expect(terminalExchange).toMatchObject({
      kind: 'apply',
      mutations: [
        { kind: 'withdraw', key: expect.any(String) },
        {
          kind: 'create',
          record: {
            revision: 1,
            appearance: 'failure',
            canonicalTitle: 'Codex usage limit reached',
            canonicalBody: 'The account limit was reached',
            returnTarget: 'route-exhausted',
          },
        },
      ],
    });
    expect(
      createdRecords(exchanged).filter(({ appearance }) => appearance === 'failure'),
    ).toHaveLength(1);
  });

  it('keeps other and unknown structured classifications generic without reading message text', async () => {
    const exchanged: PresentationExchange[] = [];
    const deadlines: Array<() => Promise<void>> = [];
    const normalization = new CodexAttentionNormalizationRegistry(
      presentationRecorder(exchanged),
      undefined,
      manualClock(deadlines),
    );

    await normalization.exchange(
      append([
        qualification(1),
        turnStart(2, 'turn-other', 'route-other'),
        {
          kind: 'terminal-error',
          sourceSequence: 3,
          turnKey: 'turn-other',
          errorKind: 'other',
          canonicalBody: 'usage limit exceeded and HTTP 429',
        },
        {
          kind: 'terminal-result',
          sourceSequence: 4,
          turnKey: 'turn-other',
          result: 'failure',
          occurrenceKey: 'turn-other:failure',
        },
        turnStart(5, 'turn-unknown', 'route-unknown'),
        {
          kind: 'terminal-error',
          sourceSequence: 6,
          turnKey: 'turn-unknown',
          errorKind: 'futureQuotaError',
          canonicalBody: 'quota',
        },
        {
          kind: 'terminal-result',
          sourceSequence: 7,
          turnKey: 'turn-unknown',
          result: 'failure',
          occurrenceKey: 'turn-unknown:failure',
        },
      ]),
    );

    expect(createdRecords(exchanged)).toHaveLength(0);
    expect(deadlines).toHaveLength(2);
    await deadlines[0]();
    await deadlines[1]();

    expect(
      createdRecords(exchanged)
        .filter(({ appearance }) => appearance === 'failure')
        .map(({ canonicalTitle }) => canonicalTitle),
    ).toEqual(['Codex failed', 'Codex failed']);
  });

  it('reconciles missing failure detail and enriches the same generic outcome revision', async () => {
    const exchanged: PresentationExchange[] = [];
    const deadlines: Array<() => Promise<void>> = [];
    const normalization = new CodexAttentionNormalizationRegistry(
      presentationRecorder(exchanged),
      undefined,
      manualClock(deadlines),
    );

    await normalization.exchange(
      append([
        qualification(1),
        turnStart(2, 'turn-generic', 'route-generic'),
        {
          kind: 'terminal-result',
          sourceSequence: 3,
          turnKey: 'turn-generic',
          result: 'failure',
          occurrenceKey: 'turn-generic:failure',
        },
      ]),
    );
    expect(createdRecords(exchanged)).toHaveLength(0);
    expect(deadlines).toHaveLength(1);

    await deadlines[0]();
    const generic = createdRecords(exchanged)[0];
    expect(generic).toMatchObject({
      revision: 1,
      appearance: 'failure',
      canonicalTitle: 'Codex failed',
      canonicalBody: 'Return to Codex to view details',
      returnTarget: 'route-generic',
    });

    await normalization.exchange(
      append(
        [
          {
            kind: 'terminal-error',
            sourceSequence: 4,
            turnKey: 'turn-generic',
            errorKind: 'unauthorized',
            canonicalBody: 'Sign in again',
          },
        ],
        4,
      ),
    );

    const update = exchanged.at(-1);
    expect(update).toMatchObject({
      kind: 'apply',
      mutations: [
        {
          kind: 'update',
          record: {
            key: generic?.key,
            revision: 2,
            appearance: 'failure',
            canonicalTitle: 'Codex authentication failed',
            canonicalBody: 'Sign in again',
            returnTarget: 'route-generic',
          },
        },
      ],
    });
    expect(
      createdRecords(exchanged).filter(({ appearance }) => appearance === 'failure'),
    ).toHaveLength(1);
  });

  it('lets reordered structured detail settle a pending failure without a generic occurrence', async () => {
    const exchanged: PresentationExchange[] = [];
    const normalization = new CodexAttentionNormalizationRegistry(presentationRecorder(exchanged));

    await normalization.exchange(
      append([
        qualification(1),
        turnStart(2, 'turn-reordered', 'route-reordered'),
        {
          kind: 'terminal-result',
          sourceSequence: 3,
          turnKey: 'turn-reordered',
          result: 'failure',
          occurrenceKey: 'turn-reordered:failure',
        },
        {
          kind: 'terminal-error',
          sourceSequence: 4,
          turnKey: 'turn-reordered',
          errorKind: 'contextWindowExceeded',
          canonicalBody: 'Context is full',
        },
      ]),
    );

    expect(createdRecords(exchanged)).toEqual([
      expect.objectContaining({
        revision: 1,
        appearance: 'failure',
        canonicalTitle: 'Codex context window exceeded',
        canonicalBody: 'Context is full',
        returnTarget: 'route-reordered',
      }),
    ]);
  });

  it('withdraws pending requests for structured interruption and stays silent without intent', async () => {
    const exchanged: PresentationExchange[] = [];
    const normalization = new CodexAttentionNormalizationRegistry(presentationRecorder(exchanged));

    await expect(
      normalization.exchange(
        append([
          qualification(1),
          turnStart(2, 'turn-interrupted', 'route-interrupted'),
          {
            kind: 'human-action-request',
            sourceSequence: 3,
            turnKey: 'turn-interrupted',
            requestKey: 'string:input',
            requestKind: 'input',
          },
          { kind: 'interruption', sourceSequence: 4, turnKey: 'turn-interrupted' },
          {
            kind: 'human-action-request',
            sourceSequence: 5,
            turnKey: 'turn-interrupted',
            requestKey: 'string:late',
            requestKind: 'input',
          },
          {
            kind: 'retry-error',
            sourceSequence: 6,
            turnKey: 'turn-interrupted',
            errorKind: 'responseStreamDisconnected',
          },
        ]),
      ),
    ).resolves.toEqual({ receivedThrough: 6, appliedThrough: 6, monitoring: 'exact' });

    expect(
      createdRecords(exchanged).filter(({ appearance }) => appearance !== 'action'),
    ).toHaveLength(0);
    expect(exchanged.at(-1)).toMatchObject({
      kind: 'apply',
      mutations: [{ kind: 'withdraw', key: expect.any(String) }],
    });
  });

  it('keeps the first conflicting terminal result and degrades monitoring without duplication', async () => {
    const exchanged: PresentationExchange[] = [];
    const normalization = new CodexAttentionNormalizationRegistry(presentationRecorder(exchanged));

    await expect(
      normalization.exchange(
        append([
          qualification(1),
          turnStart(2, 'turn-conflict', 'route-conflict'),
          {
            kind: 'terminal-result',
            sourceSequence: 3,
            turnKey: 'turn-conflict',
            result: 'success',
            occurrenceKey: 'turn-conflict:success',
          },
          {
            kind: 'terminal-result',
            sourceSequence: 4,
            turnKey: 'turn-conflict',
            result: 'failure',
            occurrenceKey: 'turn-conflict:failure',
          },
          { kind: 'interruption', sourceSequence: 5, turnKey: 'turn-conflict' },
          {
            kind: 'terminal-error',
            sourceSequence: 6,
            turnKey: 'turn-conflict',
            errorKind: 'usageLimitExceeded',
          },
        ]),
      ),
    ).resolves.toEqual({ receivedThrough: 6, appliedThrough: 6, monitoring: 'degraded' });

    expect(createdRecords(exchanged)).toEqual([
      expect.objectContaining({ appearance: 'information', canonicalTitle: 'Codex completed' }),
    ]);
  });

  it('keeps late terminal outcomes for an older turn isolated from the current turn', async () => {
    const exchanged: PresentationExchange[] = [];
    const normalization = new CodexAttentionNormalizationRegistry(presentationRecorder(exchanged));

    await normalization.exchange(
      append([
        qualification(1),
        turnStart(2, 'older-turn', 'older-route'),
        {
          kind: 'human-action-request',
          sourceSequence: 3,
          turnKey: 'older-turn',
          requestKey: 'string:older-request',
          requestKind: 'input',
        },
        turnStart(4, 'current-turn', 'current-route'),
        {
          kind: 'terminal-error',
          sourceSequence: 5,
          turnKey: 'older-turn',
          errorKind: 'serverOverloaded',
        },
        {
          kind: 'terminal-result',
          sourceSequence: 6,
          turnKey: 'older-turn',
          result: 'failure',
          occurrenceKey: 'older-turn:failure',
        },
        {
          kind: 'terminal-result',
          sourceSequence: 7,
          turnKey: 'current-turn',
          result: 'success',
          occurrenceKey: 'current-turn:success',
        },
      ]),
    );

    expect(exchanged).toContainEqual(
      expect.objectContaining({
        kind: 'apply',
        mutations: [expect.objectContaining({ kind: 'withdraw' })],
      }),
    );
    expect(
      createdRecords(exchanged)
        .filter(({ appearance }) => appearance !== 'action')
        .map(({ appearance, returnTarget }) => [appearance, returnTarget]),
    ).toEqual([
      ['failure', 'older-route'],
      ['information', 'current-route'],
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

function manualClock(deadlines: Array<() => Promise<void>>) {
  return {
    setTimeout(callback: () => Promise<void>, _milliseconds: number): void {
      deadlines.push(callback);
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
