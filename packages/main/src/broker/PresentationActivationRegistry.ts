import { randomBytes } from 'node:crypto';

import { PresentationRecord } from 'remote-notifier-shared/attentionExchange';

import { NativePresentationRecord } from './NativeWindowsAttentionAdapter';

interface ActivationEntry {
  activationId: string;
  key: string;
  revision: number;
  returnTarget: string;
}

export interface RedeemedPresentationActivation {
  key: string;
  revision: number;
  returnTarget: string;
}

export class PresentationActivationRegistry {
  private readonly byActivation = new Map<string, ActivationEntry>();
  private readonly byKey = new Map<string, ActivationEntry>();

  constructor(
    private readonly presentationEpoch: string,
    private readonly createActivationId: () => string = () => randomBytes(16).toString('hex'),
  ) {}

  reconcile(records: PresentationRecord[]): void {
    const projection = new Map(records.map((record) => [record.key, record]));
    for (const [key, entry] of this.byKey) {
      if (projection.has(key)) continue;
      this.byKey.delete(key);
      this.byActivation.delete(entry.activationId);
    }
    for (const record of records) {
      const current = this.byKey.get(record.key);
      if (current !== undefined) {
        current.revision = record.revision;
        current.returnTarget = record.returnTarget;
        continue;
      }
      const entry = this.mint(record);
      this.byKey.set(record.key, entry);
      this.byActivation.set(entry.activationId, entry);
    }
  }

  nativeRecord(record: PresentationRecord): NativePresentationRecord {
    const entry = this.byKey.get(record.key);
    if (entry === undefined || entry.revision !== record.revision) {
      throw new Error('Presentation record has no current activation');
    }
    return {
      key: record.key,
      revision: record.revision,
      appearance: record.appearance,
      canonicalTitle: record.canonicalTitle,
      canonicalBody: record.canonicalBody,
      activationId: entry.activationId,
    };
  }

  redeem(
    presentationEpoch: string,
    activationId: string,
  ): RedeemedPresentationActivation | undefined {
    if (presentationEpoch !== this.presentationEpoch) return undefined;
    const entry = this.byActivation.get(activationId);
    if (entry === undefined) return undefined;
    this.byActivation.delete(activationId);
    this.byKey.delete(entry.key);
    return { key: entry.key, revision: entry.revision, returnTarget: entry.returnTarget };
  }

  private mint(record: PresentationRecord): ActivationEntry {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const activationId = this.createActivationId();
      if (!/^[0-9a-f]{32}$/.test(activationId)) {
        throw new Error('Invalid presentation activation id');
      }
      if (!this.byActivation.has(activationId)) {
        return {
          activationId,
          key: record.key,
          revision: record.revision,
          returnTarget: record.returnTarget,
        };
      }
    }
    throw new Error('Could not mint a unique presentation activation id');
  }
}
