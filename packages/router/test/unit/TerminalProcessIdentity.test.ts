import { describe, expect, it } from 'vitest';

import { readTerminalProcessIdentity } from '../../src/terminal/TerminalProcessIdentity';

describe('terminal process identity', { timeout: 10_000 }, () => {
  it('rejects invalid process IDs', async () => {
    for (const pid of [0, -1, NaN, 1.5])
      expect(await readTerminalProcessIdentity(pid)).toBeUndefined();
  });

  it.skipIf(!['linux', 'win32'].includes(process.platform))(
    'reads a stable start identity for the live process',
    async () => {
      const identity = await readTerminalProcessIdentity(process.pid);
      expect(identity).toBeTruthy();
      expect(await readTerminalProcessIdentity(process.pid)).toBe(identity);
    },
  );
});
