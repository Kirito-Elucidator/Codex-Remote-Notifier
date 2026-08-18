import { describe, expect, it, vi } from 'vitest';

import {
  NativeAttentionPresentationAdapter,
  NativeIdentityAllocator,
  NativeWindowsNotificationHost,
} from '../../src/broker/NativeWindowsAttentionAdapter';

describe('NativeAttentionPresentationAdapter', () => {
  it('shows one compact activatable ToastGeneric item for a new record', async () => {
    const host = createHost();
    const adapter = new NativeAttentionPresentationAdapter({
      host,
      iconPath: 'C:\\extension\\icon-transparent.png',
      presentationEpoch: 'a'.repeat(32),
      sound: false,
    });
    const exchange = createExchange('create-1', {
      kind: 'create',
      record: record('attention-1', 1, 'b'.repeat(32)),
    });

    await adapter.exchange(exchange);
    await adapter.exchange(exchange);

    expect(host.show).toHaveBeenCalledOnce();
    const shown = vi.mocked(host.show).mock.calls[0][0];
    expect(shown.title).toBe('\u4e2d\u6587 & <title> \u{1f642}');
    expect(shown.body).toBe('Remote e\u0301 body & <details>');
    expect(shown.tag).toMatch(/^[0-9a-f]{16}$/);
    expect(shown.group).toMatch(/^[0-9a-f]{16}$/);
    expect(shown.xml).toContain('template="ToastGeneric"');
    expect(shown.xml).toContain('placement="appLogoOverride"');
    expect(shown.xml).toContain('<audio silent="true"/>');
    expect(shown.xml).not.toContain('<actions>');
    expect(shown.xml).not.toContain('scenario=');
    expect(shown.xml).toContain(
      'vscode://ddyndo.remote-notifier-codex/notification?epoch=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&amp;activation=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    );
    expect(JSON.stringify(shown)).not.toContain('opaque:origin');
  });

  it('retains collision-checked tag and group identities for the presentation epoch', () => {
    const allocator = new NativeIdentityAllocator('a'.repeat(32), (input) => {
      const salt = input.slice(input.lastIndexOf('\0') + 1);
      if (salt === '0') return 'c'.repeat(64);
      return input.includes('record-one') ? '1'.repeat(64) : '2'.repeat(64);
    });

    const first = allocator.forKey('record-one');
    const second = allocator.forKey('record-two');

    expect(first).toEqual({ tag: 'c'.repeat(16), group: 'c'.repeat(16) });
    expect(second).toEqual({ tag: '2'.repeat(16), group: '2'.repeat(16) });
    expect(allocator.forKey('record-one')).toBe(first);
  });

  it('updates text in place without showing a second item', async () => {
    const host = createHost();
    vi.mocked(host.update).mockResolvedValue('updated');
    const adapter = createAdapter(host);

    await adapter.exchange(
      createExchange('create-1', {
        kind: 'create',
        record: record('attention-1', 1, '1'.repeat(32)),
      }),
    );
    await adapter.exchange(
      createExchange('update-1', {
        kind: 'update',
        record: {
          ...record('attention-1', 2, '1'.repeat(32)),
          canonicalBody: 'Enriched body',
        },
      }),
    );

    expect(host.show).toHaveBeenCalledOnce();
    expect(host.update).toHaveBeenCalledOnce();
    expect(vi.mocked(host.update).mock.calls[0][0]).toMatchObject({
      body: 'Enriched body',
      ...pickIdentity(vi.mocked(host.show).mock.calls[0][0]),
    });
  });

  it('replaces the same native identity when a revision receives a new activation id', async () => {
    const host = createHost();
    const adapter = createAdapter(host);

    await adapter.exchange(
      createExchange('create-1', {
        kind: 'create',
        record: record('attention-1', 1, '1'.repeat(32)),
      }),
    );
    await adapter.exchange(
      createExchange('update-1', {
        kind: 'update',
        record: {
          ...record('attention-1', 2, '2'.repeat(32)),
          canonicalBody: 'Revision-scoped activation',
        },
      }),
    );

    expect(host.show).toHaveBeenCalledOnce();
    expect(host.replace).toHaveBeenCalledOnce();
    expect(host.update).not.toHaveBeenCalled();
    const shown = vi.mocked(host.show).mock.calls[0][0];
    const replaced = vi.mocked(host.replace).mock.calls[0][0];
    expect(replaced).toMatchObject({
      body: 'Revision-scoped activation',
      ...pickIdentity(shown),
    });
    expect(replaced.xml).toContain(`activation=${'2'.repeat(32)}`);
    expect(replaced.xml).toContain('<audio silent="true"/>');
  });

  it('keeps unsupported enrichment ledger-only instead of showing another item', async () => {
    const host = createHost();
    vi.mocked(host.update).mockResolvedValue('unsupported');
    const adapter = createAdapter(host);

    await adapter.exchange(
      createExchange('create-1', {
        kind: 'create',
        record: record('attention-1', 1, '1'.repeat(32)),
      }),
    );
    await adapter.exchange(
      createExchange('update-1', {
        kind: 'update',
        record: { ...record('attention-1', 2, '1'.repeat(32)), canonicalBody: 'Later detail' },
      }),
    );

    expect(host.update).toHaveBeenCalledOnce();
    expect(host.show).toHaveBeenCalledOnce();
  });

  it('forgets the live item before best-effort native history removal', async () => {
    const host = createHost();
    vi.mocked(host.remove).mockRejectedValue(new Error('shell history unavailable'));
    const adapter = createAdapter(host);
    await adapter.exchange(
      createExchange('create-1', {
        kind: 'create',
        record: record('attention-1', 1, '1'.repeat(32)),
      }),
    );

    await expect(
      adapter.exchange(createExchange('withdraw-1', { kind: 'withdraw', key: 'attention-1' })),
    ).resolves.toBeUndefined();
    await adapter.exchange(createExchange('withdraw-2', { kind: 'withdraw', key: 'attention-1' }));
    await adapter.exchange(
      createExchange('late-create', {
        kind: 'create',
        record: record('attention-1', 9, '2'.repeat(32)),
      }),
    );

    expect(host.remove).toHaveBeenCalledOnce();
    expect(host.show).toHaveBeenCalledOnce();
  });

  it('filters invalid display units and bounds title and body without changing scalars', async () => {
    const host = createHost();
    const adapter = createAdapter(host);
    const input = {
      ...record('bounded', 1, '1'.repeat(32)),
      canonicalTitle: `valid\u0001\ufffd\ud800${'A'.repeat(1_000)}`,
      canonicalBody: '\u{1f642}'.repeat(1_000),
    };

    await adapter.exchange(createExchange('bounded', { kind: 'create', record: input }));

    const shown = vi.mocked(host.show).mock.calls[0][0];
    expect(shown.title.startsWith('valid')).toBe(true);
    expect(shown.title).not.toMatch(/[\u0001\ufffd\ud800]/u);
    expect(Buffer.byteLength(shown.title, 'utf8')).toBeLessThanOrEqual(512);
    expect(Buffer.byteLength(shown.body, 'utf8')).toBeLessThanOrEqual(2_048);
    expect(input.canonicalBody).toBe('\u{1f642}'.repeat(1_000));
  });
});

function createAdapter(host: NativeWindowsNotificationHost): NativeAttentionPresentationAdapter {
  return new NativeAttentionPresentationAdapter({
    host,
    iconPath: 'C:\\extension\\icon-transparent.png',
    presentationEpoch: 'a'.repeat(32),
    sound: true,
  });
}

function createHost(): NativeWindowsNotificationHost {
  return {
    remove: vi.fn().mockResolvedValue(undefined),
    replace: vi.fn().mockResolvedValue(undefined),
    show: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue('updated'),
  };
}

function createExchange(
  transactionId: string,
  mutation:
    | { kind: 'create' | 'update'; record: ReturnType<typeof record> }
    | { kind: 'withdraw'; key: string },
) {
  return { kind: 'apply' as const, transactionId, mutations: [mutation] };
}

function record(key: string, revision: number, activationId: string) {
  return {
    key,
    revision,
    appearance: 'information' as const,
    canonicalTitle: '\u4e2d\u6587 & <title> \u{1f642}',
    canonicalBody: 'Remote e\u0301 body & <details>',
    activationId,
  };
}

function pickIdentity(input: { group: string; tag: string }): { group: string; tag: string } {
  return { group: input.group, tag: input.tag };
}
