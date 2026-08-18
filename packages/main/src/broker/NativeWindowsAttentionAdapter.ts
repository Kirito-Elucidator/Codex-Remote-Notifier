import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { deriveDisplayableNotificationText } from 'remote-notifier-shared/notificationText';

import nativeAttentionScript from './native-windows-attention.ps1';

const APP_ID = 'Remote Notifier';
const NATIVE_IDENTITY_LENGTH = 16;
const MAXIMUM_DISPLAY_TITLE_BYTES = 512;
const MAXIMUM_DISPLAY_BODY_BYTES = 2_048;

export interface NativePresentationRecord {
  key: string;
  revision: number;
  appearance: 'information' | 'action' | 'failure';
  canonicalTitle: string;
  canonicalBody: string;
  activationId: string;
}

export type NativePresentationMutation =
  | { kind: 'create' | 'update'; record: NativePresentationRecord }
  | { kind: 'withdraw'; key: string };

export type NativePresentationExchange =
  | { kind: 'apply'; transactionId: string; mutations: NativePresentationMutation[] }
  | { kind: 'reconcile'; transactionId: string; records: NativePresentationRecord[] };

export interface NativeNotificationIdentity {
  tag: string;
  group: string;
}

export interface NativeShowRequest extends NativeNotificationIdentity {
  body: string;
  revision: number;
  title: string;
  xml: string;
}

export interface NativeUpdateRequest extends NativeNotificationIdentity {
  body: string;
  revision: number;
  title: string;
}

export type NativeUpdateResult = 'updated' | 'not-found' | 'unsupported';

export interface NativeWindowsNotificationHost {
  show(input: NativeShowRequest): Promise<void>;
  update(input: NativeUpdateRequest): Promise<NativeUpdateResult>;
  remove(input: NativeNotificationIdentity): Promise<void>;
}

export interface NativeAttentionPresentationAdapterOptions {
  host?: NativeWindowsNotificationHost;
  iconPath: string;
  onDiagnostic?: (code: string) => void;
  presentationEpoch: string;
  sound: boolean;
}

interface RetainedNativeRecord {
  identity: NativeNotificationIdentity;
  record: NativePresentationRecord;
}

export class NativeIdentityAllocator {
  private readonly identities = new Map<string, NativeNotificationIdentity>();
  private readonly owners = new Map<string, string>();

  constructor(
    private readonly presentationEpoch: string,
    private readonly hash: (value: string) => string = (value) =>
      createHash('sha256').update(value, 'utf8').digest('hex'),
  ) {}

  forKey(key: string): NativeNotificationIdentity {
    const retained = this.identities.get(key);
    if (retained !== undefined) return retained;

    for (let salt = 0; ; salt += 1) {
      const digest = this.hash(`${this.presentationEpoch}\0${key}\0${salt}`);
      if (!/^[0-9a-f]{32,}$/.test(digest)) throw new Error('Invalid native identity digest');
      const identity = {
        tag: digest.slice(0, NATIVE_IDENTITY_LENGTH),
        group: digest.slice(NATIVE_IDENTITY_LENGTH, NATIVE_IDENTITY_LENGTH * 2),
      };
      const nativeKey = `${identity.tag}\0${identity.group}`;
      const owner = this.owners.get(nativeKey);
      if (owner !== undefined && owner !== key) continue;
      this.owners.set(nativeKey, key);
      this.identities.set(key, identity);
      return identity;
    }
  }
}

export class NativeAttentionPresentationAdapter {
  private readonly allocator: NativeIdentityAllocator;
  private readonly host: NativeWindowsNotificationHost;
  private readonly records = new Map<string, RetainedNativeRecord>();
  private readonly tombstones = new Set<string>();
  private readonly transactions = new Map<string, string>();

  constructor(private readonly options: NativeAttentionPresentationAdapterOptions) {
    this.allocator = new NativeIdentityAllocator(options.presentationEpoch);
    this.host = options.host ?? new PowerShellWindowsNotificationHost();
  }

  async exchange(exchange: NativePresentationExchange): Promise<void> {
    const fingerprint = fingerprintExchange(exchange);
    const retained = this.transactions.get(exchange.transactionId);
    if (retained !== undefined) {
      if (retained !== fingerprint) throw new Error('Conflicting native presentation transaction');
      return;
    }
    this.transactions.set(exchange.transactionId, fingerprint);

    const mutations =
      exchange.kind === 'apply' ? exchange.mutations : this.reconcileMutations(exchange.records);
    for (const mutation of mutations) {
      if (mutation.kind === 'withdraw') await this.withdraw(mutation.key);
      else await this.applyRecord(mutation.record);
    }
  }

  async cleanup(): Promise<void> {
    const retained = [...this.records.values()];
    this.records.clear();
    await Promise.all(
      retained.map(({ identity }) =>
        this.host.remove(identity).catch(() => this.options.onDiagnostic?.('native-remove-failed')),
      ),
    );
  }

  private async applyRecord(record: NativePresentationRecord): Promise<void> {
    if (this.tombstones.has(record.key)) return;
    const current = this.records.get(record.key);
    if (current !== undefined && record.revision <= current.record.revision) return;

    const identity = current?.identity ?? this.allocator.forKey(record.key);
    this.records.set(record.key, { identity, record: { ...record } });
    const displayable = deriveDisplayableNotificationText(
      record.canonicalTitle,
      record.canonicalBody,
    );
    const title = boundUtf8(displayable.title, MAXIMUM_DISPLAY_TITLE_BYTES);
    const body = boundUtf8(displayable.body, MAXIMUM_DISPLAY_BODY_BYTES);

    if (current === undefined) {
      const launchUri = createActivationUri(this.options.presentationEpoch, record.activationId);
      await this.host
        .show({
          ...identity,
          body,
          revision: record.revision,
          title,
          xml: buildToastGenericXml(launchUri, this.options.iconPath, this.options.sound),
        })
        .catch(() => this.options.onDiagnostic?.('native-show-failed'));
      return;
    }

    await this.host
      .update({ ...identity, body, revision: record.revision, title })
      .then((result) => {
        if (result !== 'updated') this.options.onDiagnostic?.(`native-update-${result}`);
      })
      .catch(() => this.options.onDiagnostic?.('native-update-failed'));
  }

  private async withdraw(key: string): Promise<void> {
    const current = this.records.get(key);
    this.tombstones.add(key);
    if (current === undefined) return;
    this.records.delete(key);
    await this.host
      .remove(current.identity)
      .catch(() => this.options.onDiagnostic?.('native-remove-failed'));
  }

  private reconcileMutations(records: NativePresentationRecord[]): NativePresentationMutation[] {
    const projection = new Map(records.map((record) => [record.key, record]));
    const mutations: NativePresentationMutation[] = [];
    for (const key of this.records.keys()) {
      if (!projection.has(key)) mutations.push({ kind: 'withdraw', key });
    }
    for (const record of records) {
      mutations.push({ kind: this.records.has(record.key) ? 'update' : 'create', record });
    }
    return mutations;
  }
}

export class PowerShellWindowsNotificationHost implements NativeWindowsNotificationHost {
  async show(input: NativeShowRequest): Promise<void> {
    await runPowerShell({
      RN_NATIVE_BODY: input.body,
      RN_NATIVE_GROUP: input.group,
      RN_NATIVE_OPERATION: 'show',
      RN_NATIVE_REVISION: String(input.revision),
      RN_NATIVE_TAG: input.tag,
      RN_NATIVE_TITLE: input.title,
      RN_NATIVE_XML: input.xml,
    });
  }

  async update(input: NativeUpdateRequest): Promise<NativeUpdateResult> {
    const output = await runPowerShell({
      RN_NATIVE_BODY: input.body,
      RN_NATIVE_GROUP: input.group,
      RN_NATIVE_OPERATION: 'update',
      RN_NATIVE_REVISION: String(input.revision),
      RN_NATIVE_TAG: input.tag,
      RN_NATIVE_TITLE: input.title,
    });
    if (output.includes('RN_UPDATE:Succeeded')) return 'updated';
    if (output.includes('RN_UPDATE:NotificationNotFound')) return 'not-found';
    return 'unsupported';
  }

  async remove(input: NativeNotificationIdentity): Promise<void> {
    await runPowerShell({
      RN_NATIVE_GROUP: input.group,
      RN_NATIVE_OPERATION: 'remove',
      RN_NATIVE_TAG: input.tag,
    });
  }
}

export function buildToastGenericXml(launchUri: string, iconPath: string, sound: boolean): string {
  const iconUri = pathToFileURL(iconPath).href;
  const audio = sound ? '' : '\n  <audio silent="true"/>';
  return `<toast activationType="protocol" launch="${escapeXml(launchUri)}">
  <visual>
    <binding template="ToastGeneric">
      <image placement="appLogoOverride" src="${escapeXml(iconUri)}"/>
      <text>{title}</text>
      <text>{body}</text>
    </binding>
  </visual>${audio}
</toast>`;
}

function createActivationUri(presentationEpoch: string, activationId: string): string {
  if (!/^[0-9a-f]{32}$/.test(presentationEpoch) || !/^[0-9a-f]{32}$/.test(activationId)) {
    throw new Error('Invalid native activation identity');
  }
  const query = new URLSearchParams({ epoch: presentationEpoch, activation: activationId });
  return `vscode://ddyndo.remote-notifier-codex/notification?${query.toString()}`;
}

function boundUtf8(value: string, maximumBytes: number): string {
  let output = '';
  let bytes = 0;
  for (const scalar of value) {
    const scalarBytes = Buffer.byteLength(scalar, 'utf8');
    if (bytes + scalarBytes > maximumBytes) break;
    output += scalar;
    bytes += scalarBytes;
  }
  return output;
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function fingerprintExchange(exchange: NativePresentationExchange): string {
  return createHash('sha256').update(JSON.stringify(exchange), 'utf8').digest('hex');
}

async function runPowerShell(environment: Record<string, string>): Promise<string> {
  const encodedScript = Buffer.from(nativeAttentionScript, 'utf16le').toString('base64');
  return await new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encodedScript,
      ],
      {
        env: { ...process.env, ...environment, RN_NATIVE_APP_ID: APP_ID },
        timeout: 5_000,
        windowsHide: true,
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}
