import { describe, expect, it } from 'vitest';

import {
  ATTENTION_EXCHANGE_LIMITS,
  AttentionExchangeValidationError,
  parseObservationExchange,
  parseObservationExchangeReceipt,
  parsePresentationExchange,
  parsePresentationInteraction,
  parsePresentationReceipt,
} from '../attentionExchange';

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

  it('represents connection qualification without source protocol details', () => {
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
