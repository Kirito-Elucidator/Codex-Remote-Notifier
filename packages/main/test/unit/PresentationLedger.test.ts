import { describe, expect, it } from 'vitest';

import { PresentationRecord } from 'remote-notifier-shared';

import { PresentationLedger } from '../../src/broker/PresentationLedger';

describe('PresentationLedger', () => {
  it('applies a transaction once and rejects conflicting transaction reuse', async () => {
    const ledger = new PresentationLedger('epoch-one');
    const exchange = {
      kind: 'apply' as const,
      transactionId: 'transaction-one',
      mutations: [{ kind: 'create' as const, record: record('record-one', 1, 'original') }],
    };

    await expect(ledger.exchange(exchange)).resolves.toEqual({
      kind: 'applied',
      transactionId: 'transaction-one',
    });
    await expect(ledger.exchange(exchange)).resolves.toEqual({
      kind: 'replay',
      transactionId: 'transaction-one',
    });
    await expect(
      ledger.exchange({
        ...exchange,
        mutations: [{ kind: 'create', record: record('record-one', 1, 'different') }],
      }),
    ).resolves.toEqual({
      kind: 'rejected',
      transactionId: 'transaction-one',
      reason: 'conflict',
    });
    expect(ledger.currentRecords()).toEqual([record('record-one', 1, 'original')]);
  });

  it('keeps newer revisions when stale updates arrive', async () => {
    const ledger = new PresentationLedger('epoch-one');

    await ledger.exchange({
      kind: 'apply',
      transactionId: 'create-newer',
      mutations: [{ kind: 'create', record: record('record-one', 3, 'newer') }],
    });
    await expect(
      ledger.exchange({
        kind: 'apply',
        transactionId: 'stale-update',
        mutations: [{ kind: 'update', record: record('record-one', 2, 'stale') }],
      }),
    ).resolves.toMatchObject({ kind: 'applied' });

    expect(ledger.currentRecords()).toEqual([record('record-one', 3, 'newer')]);
    await expect(
      ledger.exchange({
        kind: 'apply',
        transactionId: 'conflicting-revision',
        mutations: [{ kind: 'update', record: record('record-one', 3, 'conflict') }],
      }),
    ).resolves.toMatchObject({ kind: 'rejected', reason: 'conflict' });
  });

  it('reconciles the current projection atomically and tombstones missing keys', async () => {
    const ledger = new PresentationLedger('epoch-one');
    await ledger.exchange({
      kind: 'reconcile',
      transactionId: 'initial-projection',
      records: [record('keep', 1, 'keep'), record('withdraw', 1, 'withdraw')],
    });

    await expect(
      ledger.exchange({
        kind: 'reconcile',
        transactionId: 'next-projection',
        records: [record('keep', 2, 'updated'), record('new', 1, 'new')],
      }),
    ).resolves.toMatchObject({ kind: 'applied' });
    expect(ledger.currentRecords()).toEqual([
      record('keep', 2, 'updated'),
      record('new', 1, 'new'),
    ]);

    await ledger.exchange({
      kind: 'apply',
      transactionId: 'late-resurrection',
      mutations: [{ kind: 'create', record: record('withdraw', 9, 'must stay gone') }],
    });
    expect(ledger.currentRecords()).toEqual([
      record('keep', 2, 'updated'),
      record('new', 1, 'new'),
    ]);
  });

  it('rejects a conflicting batch without partially committing it', async () => {
    const ledger = new PresentationLedger('epoch-one');
    await ledger.exchange({
      kind: 'apply',
      transactionId: 'seed',
      mutations: [{ kind: 'create', record: record('existing', 1, 'original') }],
    });

    await expect(
      ledger.exchange({
        kind: 'apply',
        transactionId: 'atomic-conflict',
        mutations: [
          { kind: 'create', record: record('would-be-added', 1, 'new') },
          { kind: 'update', record: record('existing', 1, 'conflict') },
        ],
      }),
    ).resolves.toMatchObject({ kind: 'rejected', reason: 'conflict' });
    expect(ledger.currentRecords()).toEqual([record('existing', 1, 'original')]);
  });

  it('backpressures without evicting accepted records at count and byte limits', async () => {
    const countBounded = new PresentationLedger('epoch-count', {
      maximumBytes: 1_000_000,
      maximumEntries: 1,
      maximumTransactions: 10,
    });
    await countBounded.exchange({
      kind: 'apply',
      transactionId: 'first',
      mutations: [{ kind: 'create', record: record('first', 1, 'first') }],
    });
    await expect(
      countBounded.exchange({
        kind: 'apply',
        transactionId: 'second',
        mutations: [{ kind: 'create', record: record('second', 1, 'second') }],
      }),
    ).resolves.toMatchObject({ kind: 'rejected', reason: 'capacity' });
    expect(countBounded.currentRecords()).toEqual([record('first', 1, 'first')]);

    const byteBounded = new PresentationLedger('epoch-bytes', {
      maximumBytes: 400,
      maximumEntries: 10,
      maximumTransactions: 10,
    });
    await byteBounded.exchange({
      kind: 'apply',
      transactionId: 'small',
      mutations: [{ kind: 'create', record: record('small', 1, 'small') }],
    });
    await expect(
      byteBounded.exchange({
        kind: 'apply',
        transactionId: 'large',
        mutations: [{ kind: 'create', record: record('large', 1, 'x'.repeat(300)) }],
      }),
    ).resolves.toMatchObject({ kind: 'rejected', reason: 'capacity' });
    expect(byteBounded.currentRecords()).toEqual([record('small', 1, 'small')]);
  });
});

function record(key: string, revision: number, body: string): PresentationRecord {
  return {
    key,
    revision,
    appearance: 'information',
    canonicalTitle: `Title for ${key}`,
    canonicalBody: body,
    returnTarget: `opaque:${key}`,
  };
}
