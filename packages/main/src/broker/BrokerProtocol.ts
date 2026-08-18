import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';

export const PRESENTATION_BROKER_PROTOCOL_VERSION = 2;
export const PRESENTATION_BROKER_IDLE_TIMEOUT_MS = 60_000;
export const PRESENTATION_BROKER_DRAIN_TIMEOUT_MS = 5_000;
export const PRESENTATION_BROKER_HANDSHAKE_TIMEOUT_MS = 5_000;

export interface BrokerRuntimePaths {
  discoveryFile: string;
  pipeAddress: string;
}

export interface PresentationBrokerDiscovery {
  protocolVersion: number;
  processId: number;
  presentationEpoch: string;
  pipeAddress: string;
  credential: string;
}

export type BrokerConnectionErrorCode =
  | 'authentication-failed'
  | 'incompatible-protocol'
  | 'invalid-discovery'
  | 'stale-discovery'
  | 'unavailable';

export class BrokerConnectionError extends Error {
  constructor(
    readonly code: BrokerConnectionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BrokerConnectionError';
  }
}

export function createDefaultBrokerRuntimePaths(
  environment: NodeJS.ProcessEnv = process.env,
): BrokerRuntimePaths {
  if (process.platform !== 'win32') {
    throw new BrokerConnectionError(
      'unavailable',
      'The Windows presentation broker is available only on Windows',
    );
  }
  const localApplicationData = environment.LOCALAPPDATA;
  if (!localApplicationData) {
    throw new BrokerConnectionError('unavailable', 'LOCALAPPDATA is unavailable');
  }
  const namespace = createLogonNamespace(environment);
  return {
    discoveryFile: join(
      localApplicationData,
      'RemoteNotifierCodex',
      `presentation-broker-${namespace}.json`,
    ),
    pipeAddress: `\\\\.\\pipe\\remote-notifier-codex-${namespace}`,
  };
}

export function createPresentationEpoch(): string {
  return randomBytes(16).toString('hex');
}

export function createEpochCredential(): string {
  return randomBytes(32).toString('hex');
}

export async function readBrokerDiscovery(
  discoveryFile: string,
): Promise<PresentationBrokerDiscovery | undefined> {
  let value: string;
  try {
    value = await readFile(discoveryFile, 'utf8');
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new BrokerConnectionError('invalid-discovery', 'Broker discovery is not valid JSON');
  }
  return parseBrokerDiscovery(parsed);
}

export async function writeBrokerDiscovery(
  discoveryFile: string,
  discovery: PresentationBrokerDiscovery,
): Promise<void> {
  const parsed = parseBrokerDiscovery(discovery);
  await mkdir(dirname(discoveryFile), { recursive: true });
  const temporaryFile = `${discoveryFile}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporaryFile, JSON.stringify(parsed), { encoding: 'utf8', mode: 0o600 });
  await rename(temporaryFile, discoveryFile);
}

export async function removeOwnedBrokerDiscovery(
  discoveryFile: string,
  presentationEpoch: string,
): Promise<void> {
  try {
    const current = await readBrokerDiscovery(discoveryFile);
    if (current?.presentationEpoch !== presentationEpoch) return;
    await rm(discoveryFile, { force: true });
  } catch (error) {
    if (!isErrorCode(error, 'ENOENT')) return;
  }
}

export function parseBrokerDiscovery(value: unknown): PresentationBrokerDiscovery {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BrokerConnectionError('invalid-discovery', 'Broker discovery must be an object');
  }
  const input = value as Record<string, unknown>;
  const fields = ['protocolVersion', 'processId', 'presentationEpoch', 'pipeAddress', 'credential'];
  if (Object.keys(input).length !== fields.length || fields.some((field) => !(field in input))) {
    throw new BrokerConnectionError(
      'invalid-discovery',
      'Broker discovery contains an unexpected field set',
    );
  }
  if (!Number.isSafeInteger(input.protocolVersion) || (input.protocolVersion as number) < 0) {
    throw new BrokerConnectionError('invalid-discovery', 'Invalid broker protocol version');
  }
  if (!Number.isSafeInteger(input.processId) || (input.processId as number) < 1) {
    throw new BrokerConnectionError('invalid-discovery', 'Invalid broker process id');
  }
  if (typeof input.pipeAddress !== 'string' || input.pipeAddress.length === 0) {
    throw new BrokerConnectionError('invalid-discovery', 'Invalid broker pipe address');
  }
  if (Buffer.byteLength(input.pipeAddress, 'utf8') > 1_024) {
    throw new BrokerConnectionError('invalid-discovery', 'Broker pipe address is too long');
  }
  if (
    typeof input.presentationEpoch !== 'string' ||
    !/^[0-9a-f]{32}$/.test(input.presentationEpoch)
  ) {
    throw new BrokerConnectionError('invalid-discovery', 'Invalid presentation epoch');
  }
  if (typeof input.credential !== 'string' || !/^[0-9a-f]{64}$/.test(input.credential)) {
    throw new BrokerConnectionError('invalid-discovery', 'Invalid epoch credential');
  }
  return {
    protocolVersion: input.protocolVersion as number,
    processId: input.processId as number,
    presentationEpoch: input.presentationEpoch,
    pipeAddress: input.pipeAddress,
    credential: input.credential,
  };
}

function createLogonNamespace(environment: NodeJS.ProcessEnv): string {
  const identity = [
    environment.USERDOMAIN ?? '',
    environment.USERNAME ?? safeUsername(),
    environment.SESSIONNAME ?? environment.REMOTESESSION ?? 'interactive',
    homedir(),
  ].join('\0');
  return createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 24);
}

function safeUsername(): string {
  try {
    return userInfo().username;
  } catch {
    return 'unknown-user';
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
