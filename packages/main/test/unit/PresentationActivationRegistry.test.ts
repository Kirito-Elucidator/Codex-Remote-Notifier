import { describe, expect, it } from 'vitest';

import { PresentationActivationRegistry } from '../../src/broker/PresentationActivationRegistry';

describe('PresentationActivationRegistry', () => {
  it('rotates revision-scoped ids and never reuses an id consumed in the epoch', () => {
    const firstId = '1'.repeat(32);
    const secondId = '2'.repeat(32);
    const thirdId = '3'.repeat(32);
    const candidates = [firstId, secondId, firstId, secondId, thirdId];
    const registry = new PresentationActivationRegistry('a'.repeat(32), () => {
      const candidate = candidates.shift();
      if (candidate === undefined) throw new Error('No activation candidate');
      return candidate;
    });

    registry.reconcile([record('first', 1, 'target-1')]);
    expect(registry.nativeRecord(record('first', 1, 'target-1')).activationId).toBe(firstId);

    registry.reconcile([record('first', 2, 'target-2')]);
    expect(registry.nativeRecord(record('first', 2, 'target-2')).activationId).toBe(secondId);
    expect(registry.redeem('a'.repeat(32), firstId)).toBeUndefined();
    expect(registry.redeem('a'.repeat(32), secondId)).toEqual({
      key: 'first',
      revision: 2,
      returnTarget: 'target-2',
    });
    expect(registry.redeem('a'.repeat(32), secondId)).toBeUndefined();

    registry.reconcile([record('second', 1, 'target-3')]);
    expect(registry.nativeRecord(record('second', 1, 'target-3')).activationId).toBe(thirdId);
  });
});

function record(key: string, revision: number, returnTarget: string) {
  return {
    key,
    revision,
    appearance: 'action' as const,
    canonicalTitle: `Title ${key}`,
    canonicalBody: `Body ${key}`,
    returnTarget,
  };
}
