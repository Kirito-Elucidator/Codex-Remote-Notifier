import { createHash } from 'node:crypto';

import {
  ATTENTION_EXCHANGE_LIMITS,
  AttentionPresentationPort,
  parsePresentationExchange,
  PresentationExchange,
  PresentationReceipt,
  PresentationRecord,
} from 'remote-notifier-shared/attentionExchange';

export interface PresentationLedgerLimits {
  maximumBytes: number;
  maximumEntries: number;
  maximumTransactions: number;
}

interface RetainedTransaction {
  fingerprint: string;
  receipt: PresentationReceipt;
}

const DEFAULT_LEDGER_LIMITS: PresentationLedgerLimits = Object.freeze({
  maximumBytes: 32 * 1024 * 1024,
  maximumEntries: ATTENTION_EXCHANGE_LIMITS.presentationRecords,
  maximumTransactions: ATTENTION_EXCHANGE_LIMITS.presentationRecords,
});

export class PresentationLedger implements AttentionPresentationPort {
  private records = new Map<string, PresentationRecord>();
  private tombstones = new Set<string>();
  private transactions = new Map<string, RetainedTransaction>();

  readonly limits: PresentationLedgerLimits;

  constructor(
    readonly presentationEpoch: string,
    limits: Partial<PresentationLedgerLimits> = {},
  ) {
    this.limits = { ...DEFAULT_LEDGER_LIMITS, ...limits };
  }

  async exchange(input: PresentationExchange): Promise<PresentationReceipt> {
    const exchange = parsePresentationExchange(input);
    const fingerprint = fingerprintExchange(exchange);
    const retained = this.transactions.get(exchange.transactionId);
    if (retained !== undefined) {
      if (retained.fingerprint !== fingerprint) {
        return rejected(exchange.transactionId, 'conflict');
      }
      return retained.receipt.kind === 'applied'
        ? { kind: 'replay', transactionId: exchange.transactionId }
        : retained.receipt;
    }

    const nextRecords = new Map(this.records);
    const nextTombstones = new Set(this.tombstones);
    const conflict =
      exchange.kind === 'apply'
        ? applyMutations(exchange, nextRecords, nextTombstones)
        : reconcileRecords(exchange.records, nextRecords, nextTombstones);
    if (conflict) {
      const receipt = rejected(exchange.transactionId, 'conflict');
      this.retainTerminalRejection(exchange.transactionId, fingerprint, receipt);
      return receipt;
    }

    if (
      this.transactions.size >= this.limits.maximumTransactions ||
      nextRecords.size + nextTombstones.size > this.limits.maximumEntries
    ) {
      return rejected(exchange.transactionId, 'capacity');
    }

    const receipt: PresentationReceipt = {
      kind: 'applied',
      transactionId: exchange.transactionId,
    };
    const nextTransactions = new Map(this.transactions).set(exchange.transactionId, {
      fingerprint,
      receipt,
    });
    if (
      encodedLedgerBytes(nextRecords, nextTombstones, nextTransactions) > this.limits.maximumBytes
    ) {
      return rejected(exchange.transactionId, 'capacity');
    }

    this.records = nextRecords;
    this.tombstones = nextTombstones;
    this.transactions = nextTransactions;
    return receipt;
  }

  currentRecords(): PresentationRecord[] {
    return [...this.records.values()].map((record) => ({ ...record }));
  }

  isEmpty(): boolean {
    return this.records.size === 0;
  }

  private retainTerminalRejection(
    transactionId: string,
    fingerprint: string,
    receipt: PresentationReceipt,
  ): void {
    if (this.transactions.size >= this.limits.maximumTransactions) return;
    const transactions = new Map(this.transactions).set(transactionId, { fingerprint, receipt });
    if (
      encodedLedgerBytes(this.records, this.tombstones, transactions) > this.limits.maximumBytes
    ) {
      return;
    }
    this.transactions = transactions;
  }
}

function applyMutations(
  exchange: Extract<PresentationExchange, { kind: 'apply' }>,
  records: Map<string, PresentationRecord>,
  tombstones: Set<string>,
): boolean {
  for (const mutation of exchange.mutations) {
    if (mutation.kind === 'withdraw') {
      records.delete(mutation.key);
      tombstones.add(mutation.key);
      continue;
    }
    if (applyRecord(mutation.record, records, tombstones)) return true;
  }
  return false;
}

function reconcileRecords(
  projection: PresentationRecord[],
  records: Map<string, PresentationRecord>,
  tombstones: Set<string>,
): boolean {
  const projectedKeys = new Set(projection.map(({ key }) => key));
  for (const record of projection) {
    if (applyRecord(record, records, tombstones)) return true;
  }
  for (const key of records.keys()) {
    if (!projectedKeys.has(key)) {
      records.delete(key);
      tombstones.add(key);
    }
  }
  return false;
}

function applyRecord(
  record: PresentationRecord,
  records: Map<string, PresentationRecord>,
  tombstones: Set<string>,
): boolean {
  if (tombstones.has(record.key)) return false;
  const current = records.get(record.key);
  if (current === undefined) {
    records.set(record.key, record);
    return false;
  }
  if (record.revision < current.revision) return false;
  if (record.revision === current.revision) return !recordsMatch(current, record);
  records.set(record.key, record);
  return false;
}

function encodedLedgerBytes(
  records: Map<string, PresentationRecord>,
  tombstones: Set<string>,
  transactions: Map<string, RetainedTransaction>,
): number {
  let bytes = 0;
  for (const record of records.values()) bytes += encodedBytes(record);
  for (const key of tombstones) bytes += Buffer.byteLength(key, 'utf8');
  for (const [transactionId, transaction] of transactions) {
    bytes += Buffer.byteLength(transactionId, 'utf8');
    bytes += Buffer.byteLength(transaction.fingerprint, 'utf8');
    bytes += encodedBytes(transaction.receipt);
  }
  return bytes;
}

function encodedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function fingerprintExchange(exchange: PresentationExchange): string {
  return createHash('sha256').update(JSON.stringify(exchange), 'utf8').digest('hex');
}

function recordsMatch(left: PresentationRecord, right: PresentationRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function rejected(
  transactionId: string,
  reason: Extract<PresentationReceipt, { kind: 'rejected' }>['reason'],
): PresentationReceipt {
  return { kind: 'rejected', transactionId, reason };
}
