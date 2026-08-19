import { describe, expect, it } from 'vitest';

import {
  ATTENTION_EXCHANGE_LIMITS,
  AttentionExchangeValidationError,
  ConnectionQualificationEvidence,
  parseObservationExchange,
  parseObservationExchangeReceipt,
  parsePresentationExchange,
  parsePresentationInteraction,
  parsePresentationReceipt,
} from '../attentionExchange';
import { deriveDisplayableNotificationText } from '../notificationText';

describe('attention exchange contracts', () => {
  const record = {
    key: 'invocation/request/1',
    revision: 1,
    appearance: 'action',
    canonicalTitle: 'Codex needs your attention',
    canonicalBody: 'Review the requested action',
    returnTarget: 'opaque:return-target',
  };

  it('accepts source-neutral append and reconcile observation exchanges', () => {
    const scope = {
      invocationId: 'invocation-a',
      connectionId: 'connection-a',
      authorityEpoch: 'epoch-a',
    };
    const observation = {
      kind: 'turn-start',
      sourceSequence: 1,
      turnKey: 'turn-a',
      returnTarget: 'opaque:return-target',
    };

    expect(
      parseObservationExchange({
        kind: 'append',
        deliveryGeneration: 'generation-a',
        scope,
        fromSequence: 1,
        observations: [observation],
      }),
    ).toEqual({
      kind: 'append',
      deliveryGeneration: 'generation-a',
      scope,
      fromSequence: 1,
      observations: [observation],
    });

    expect(
      parseObservationExchange({
        kind: 'reconcile',
        deliveryGeneration: 'generation-b',
        scope,
        retainedRange: { fromSequence: 1, throughSequence: 1 },
        checkpoint: {
          throughSequence: 1,
          monitoring: 'exact',
          observations: [observation],
        },
        tail: [],
      }).kind,
    ).toBe('reconcile');
  });

  it('represents sanitized qualification evidence without raw source messages', () => {
    const exchange = parseObservationExchange({
      kind: 'append',
      deliveryGeneration: 'generation-a',
      scope: {
        invocationId: 'invocation-a',
        connectionId: 'connection-a',
        authorityEpoch: 'epoch-a',
      },
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
      ],
    });

    expect(exchange.kind).toBe('append');
    expect(JSON.stringify(exchange)).not.toMatch(/protocol|hook|method/i);
  });

  it('accepts atomic presentation mutations, reconciliation, and interactions', () => {
    const apply = parsePresentationExchange({
      kind: 'apply',
      transactionId: 'transaction-a',
      mutations: [
        { kind: 'create', record },
        { kind: 'update', record: { ...record, revision: 2 } },
        { kind: 'withdraw', key: record.key },
      ],
    });
    const reconcile = parsePresentationExchange({
      kind: 'reconcile',
      transactionId: 'transaction-b',
      records: [record],
    });

    expect(apply.kind).toBe('apply');
    expect(reconcile.kind).toBe('reconcile');
    expect(
      parsePresentationInteraction({
        kind: 'activate',
        key: record.key,
        revision: record.revision,
      }),
    ).toEqual({ kind: 'activate', key: record.key, revision: 1 });
  });

  it('represents received, applied, and replay outcomes explicitly', () => {
    expect(
      parseObservationExchangeReceipt({
        receivedThrough: 8,
        appliedThrough: 7,
        replayFrom: 9,
        monitoring: 'compatibility',
      }),
    ).toEqual({
      receivedThrough: 8,
      appliedThrough: 7,
      replayFrom: 9,
      monitoring: 'compatibility',
    });
    expect(parsePresentationReceipt({ kind: 'received', transactionId: 'tx-1' }).kind).toBe(
      'received',
    );
    expect(parsePresentationReceipt({ kind: 'applied', transactionId: 'tx-1' }).kind).toBe(
      'applied',
    );
    expect(parsePresentationReceipt({ kind: 'replay', transactionId: 'tx-1' }).kind).toBe('replay');
  });

  it('rejects unbounded and source-specific presentation data', () => {
    expect(() =>
      parsePresentationExchange({
        kind: 'apply',
        transactionId: 'transaction-a',
        mutations: [
          {
            kind: 'create',
            record: {
              ...record,
              canonicalBody: 'x'.repeat(ATTENTION_EXCHANGE_LIMITS.canonicalBodyBytes + 1),
            },
          },
        ],
      }),
    ).toThrow(AttentionExchangeValidationError);

    expect(() =>
      parsePresentationExchange({
        kind: 'reconcile',
        transactionId: 'transaction-b',
        records: [{ ...record, protocolMethod: 'turn/completed' }],
      }),
    ).toThrow(/unexpected field/i);
  });

  it('rejects malformed exchanges instead of producing an acknowledgement', () => {
    expect(() =>
      parseObservationExchange({
        kind: 'append',
        deliveryGeneration: 'generation-a',
        scope: {
          invocationId: 'invocation-a',
          connectionId: 'connection-a',
          authorityEpoch: 'epoch-a',
        },
        fromSequence: 2,
        observations: [
          {
            kind: 'turn-start',
            sourceSequence: 3,
            turnKey: 'turn-a',
            returnTarget: 'opaque:return-target',
          },
        ],
      }),
    ).toThrow(/contiguous/i);

    expect(() =>
      parsePresentationReceipt({ kind: 'applied', transactionId: '', ok: true }),
    ).toThrow(AttentionExchangeValidationError);

    expect(() =>
      parseObservationExchange({
        kind: 'append',
        deliveryGeneration: 'generation-a',
        scope: {
          invocationId: 'invocation-a',
          connectionId: 'connection-a',
          authorityEpoch: 'epoch-a',
        },
        fromSequence: 1,
        observations: [
          {
            kind: 'turn-start',
            sourceSequence: 1,
            turnKey: '\ud800',
            returnTarget: 'opaque:return-target',
          },
        ],
      }),
    ).toThrow(/Unicode scalar/i);
  });

  it('preserves canonical Unicode exactly and derives a separately filtered display copy', () => {
    const canonical = '中文🙂e\u0301<&>"\'涓枃棰勮';
    const damagedTitle = `\ud800${canonical}\ufffd\u0001\udfff`;
    const damagedBody = '\ud800\ufffd\u0000\udfff';
    const observationExchange = parseObservationExchange({
      kind: 'append',
      deliveryGeneration: 'unicode-generation',
      scope: {
        invocationId: 'unicode-invocation',
        connectionId: 'unicode-connection',
        authorityEpoch: 'unicode-epoch',
      },
      fromSequence: 1,
      observations: [
        {
          kind: 'human-action-request',
          sourceSequence: 1,
          turnKey: 'unicode-turn',
          requestKey: 'unicode-request',
          requestKind: 'input',
          canonicalTitle: damagedTitle,
          canonicalBody: damagedBody,
        },
      ],
    });
    const exchange = parsePresentationExchange({
      kind: 'reconcile',
      transactionId: 'unicode-transaction',
      records: [
        {
          ...record,
          canonicalTitle: damagedTitle,
          canonicalBody: damagedBody,
        },
      ],
    });

    expect(observationExchange.kind).toBe('append');
    if (observationExchange.kind !== 'append') throw new Error('expected append exchange');
    expect(observationExchange.observations[0]).toMatchObject({
      canonicalTitle: damagedTitle,
      canonicalBody: damagedBody,
    });
    expect(exchange.kind).toBe('reconcile');
    if (exchange.kind !== 'reconcile') throw new Error('expected reconcile exchange');
    expect(exchange.records[0].canonicalTitle).toBe(damagedTitle);
    expect(exchange.records[0].canonicalBody).toBe(damagedBody);
    expect(deriveDisplayableNotificationText(damagedTitle, damagedBody)).toEqual({
      title: canonical,
      body: '请返回 Codex 查看详情',
      titleFiltered: true,
      bodyFiltered: true,
    });
  });

  it('uses the generic title fallback only when title filtering removes every character', () => {
    expect(deriveDisplayableNotificationText('\ud800\ufffd\u0001', 'valid body')).toEqual({
      title: 'Codex 需要你的注意',
      body: 'valid body',
      titleFiltered: true,
      bodyFiltered: false,
    });
  });

  it('rejects a reconcile tail that does not exactly cover the retained range', () => {
    const scope = {
      invocationId: 'invocation-a',
      connectionId: 'connection-a',
      authorityEpoch: 'epoch-a',
    };
    const tail = [1, 2].map((sourceSequence) => ({
      kind: 'turn-start',
      sourceSequence,
      turnKey: `turn-${sourceSequence}`,
      returnTarget: `opaque:target-${sourceSequence}`,
    }));

    expect(() =>
      parseObservationExchange({
        kind: 'reconcile',
        deliveryGeneration: 'generation-a',
        scope,
        retainedRange: { fromSequence: 1, throughSequence: 1 },
        checkpoint: { throughSequence: 0, monitoring: 'exact', observations: [] },
        tail,
      }),
    ).toThrow(/retainedRange\.throughSequence/i);
  });
});

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
