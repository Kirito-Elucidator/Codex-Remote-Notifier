import { describe, expect, it } from 'vitest';

import {
  createUnixCodexLauncher,
  wrapNpmCodexLauncher,
} from '../../src/installer/CodexBootstrapInstaller';

describe('startup-safe npm launchers', () => {
  it('quotes Unix paths and preserves direct execution outside VS Code', () => {
    const script = createUnixCodexLauncher('/home/a b/bootstrap.js', "/home/a'c/codex.js");
    expect(script).toContain('TERM_PROGRAM');
    expect(script).toContain("'/home/a b/bootstrap.js'");
    expect(script).toContain("--real '/home/a'\\''c/codex.js' -- \"$@\"");
    expect(script).toContain("exec node '/home/a'\\''c/codex.js' \"$@\"");
  });
  it.each(['cmd', 'powershell'] as const)(
    'preserves the original %s launcher and wraps it only once',
    (platform) => {
      const original =
        platform === 'cmd' ? '@echo off\r\nnode codex.js %*' : '& node codex.js @args';
      const wrapped = wrapNpmCodexLauncher(original, platform);
      expect(wrapped.endsWith(original)).toBe(true);
      expect(wrapNpmCodexLauncher(wrapped, platform)).toBe(wrapped);
      expect(wrapped).toContain('TERM_PROGRAM');
      expect(wrapped).toContain('codex-notifier-bootstrap.js');
      expect(wrapped).toContain('--real');
    },
  );
});
