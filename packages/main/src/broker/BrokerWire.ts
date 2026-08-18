import { Socket } from 'node:net';

import {
  parsePresentationExchange,
  parsePresentationReceipt,
  PresentationExchange,
  PresentationReceipt,
} from 'remote-notifier-shared/attentionExchange';

export const BROKER_WIRE_MESSAGE_LIMIT_BYTES = 70 * 1024;
const MAXIMUM_PENDING_MESSAGES = 64;

export type BrokerClientMessage =
  | { kind: 'hello'; protocolVersion: number; credential: string }
  | { kind: 'exchange'; requestId: string; exchange: PresentationExchange }
  | {
      kind: 'redeem-activation';
      requestId: string;
      presentationEpoch: string;
      activationId: string;
    }
  | { kind: 'focus-result'; requestId: string; focused: boolean }
  | { kind: 'stop'; requestId: string };

export type BrokerServerMessage =
  | {
      kind: 'hello';
      status: 'ready' | 'incompatible';
      protocolVersion: number;
      presentationEpoch: string;
    }
  | {
      kind: 'exchange-receipt';
      requestId: string;
      receipt: PresentationReceipt;
    }
  | { kind: 'activation-result'; requestId: string; status: 'focused' | 'failed' }
  | { kind: 'focus-offer'; requestId: string; returnTarget: string }
  | {
      kind: 'stopped';
      requestId: string;
      presentationEpoch: string;
      epochReset: true;
    }
  | {
      kind: 'error';
      code: 'authentication-failed' | 'incompatible-protocol' | 'invalid-request';
    };

export class BrokerJsonChannel<TMessage> {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private readonly failureListeners = new Set<(error: Error) => void>();
  private readonly messageListeners = new Set<(message: TMessage) => void>();
  private readonly pendingMessages: TMessage[] = [];
  private readonly waiters = new Set<{
    match: (message: TMessage) => boolean;
    reject: (error: Error) => void;
    resolve: (message: TMessage) => void;
    timer: NodeJS.Timeout;
  }>();
  private buffer = '';
  private resolveClosed!: () => void;
  readonly whenClosed: Promise<void>;

  constructor(
    private readonly socket: Socket,
    private readonly parseMessage: (value: unknown) => TMessage,
  ) {
    this.whenClosed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    socket.on('data', this.handleData);
    socket.on('error', this.handleFailure);
    socket.once('close', this.handleClose);
  }

  close(): void {
    this.socket.destroy();
  }

  dispose(): void {
    this.socket.off('data', this.handleData);
    this.socket.off('error', this.handleFailure);
    this.socket.off('close', this.handleClose);
    this.failWaiters(new Error('Broker channel was disposed'));
    this.failureListeners.clear();
    this.messageListeners.clear();
  }

  onFailure(listener: (error: Error) => void): void {
    this.failureListeners.add(listener);
  }

  onMessage(listener: (message: TMessage) => void): void {
    this.messageListeners.add(listener);
  }

  async send(message: BrokerClientMessage | BrokerServerMessage): Promise<void> {
    const payload = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(payload, 'utf8') > BROKER_WIRE_MESSAGE_LIMIT_BYTES) {
      throw new Error('Broker message exceeds the wire limit');
    }
    await new Promise<void>((resolve, reject) => {
      this.socket.write(payload, 'utf8', (error) => (error ? reject(error) : resolve()));
    });
  }

  async waitFor(match: (message: TMessage) => boolean, timeoutMs: number): Promise<TMessage> {
    const pendingIndex = this.pendingMessages.findIndex(match);
    if (pendingIndex >= 0) return this.pendingMessages.splice(pendingIndex, 1)[0];
    return await new Promise((resolve, reject) => {
      const waiter = {
        match,
        reject,
        resolve,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error('Timed out waiting for the broker response'));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  private readonly handleData = (chunk: Buffer): void => {
    try {
      this.buffer += this.decoder.decode(chunk, { stream: true });
      let newline = this.buffer.indexOf('\n');
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (Buffer.byteLength(line, 'utf8') > BROKER_WIRE_MESSAGE_LIMIT_BYTES) {
          throw new Error('Broker message exceeds the wire limit');
        }
        if (line.length > 0) this.dispatch(this.parseMessage(JSON.parse(line)));
        newline = this.buffer.indexOf('\n');
      }
      if (Buffer.byteLength(this.buffer, 'utf8') > BROKER_WIRE_MESSAGE_LIMIT_BYTES) {
        throw new Error('Broker message exceeds the wire limit');
      }
    } catch (error) {
      this.handleFailure(error instanceof Error ? error : new Error(String(error)));
    }
  };

  private readonly handleFailure = (error: Error): void => {
    this.failWaiters(error);
    for (const listener of this.failureListeners) listener(error);
  };

  private readonly handleClose = (): void => {
    this.handleFailure(new Error('Broker connection closed'));
    this.resolveClosed();
  };

  private dispatch(message: TMessage): void {
    const waiter = [...this.waiters].find(({ match }) => match(message));
    if (waiter !== undefined) {
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve(message);
    }
    for (const listener of this.messageListeners) listener(message);
    if (waiter === undefined && this.messageListeners.size === 0) {
      if (this.pendingMessages.length >= MAXIMUM_PENDING_MESSAGES) {
        this.handleFailure(new Error('Too many pending broker messages'));
        this.close();
        return;
      }
      this.pendingMessages.push(message);
    }
  }

  private failWaiters(error: Error): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }
}

export function parseBrokerClientMessage(value: unknown): BrokerClientMessage {
  const input = expectObject(value, 'broker client message');
  switch (input.kind) {
    case 'hello':
      expectFields(input, ['kind', 'protocolVersion', 'credential']);
      return {
        kind: input.kind,
        protocolVersion: expectProtocolVersion(input.protocolVersion),
        credential: expectHex(input.credential, 64, 'epoch credential'),
      };
    case 'exchange':
      expectFields(input, ['kind', 'requestId', 'exchange']);
      return {
        kind: input.kind,
        requestId: expectRequestId(input.requestId),
        exchange: parsePresentationExchange(input.exchange),
      };
    case 'redeem-activation':
      expectFields(input, ['kind', 'requestId', 'presentationEpoch', 'activationId']);
      return {
        kind: input.kind,
        requestId: expectRequestId(input.requestId),
        presentationEpoch: expectHex(input.presentationEpoch, 32, 'presentation epoch'),
        activationId: expectHex(input.activationId, 32, 'activation id'),
      };
    case 'focus-result':
      expectFields(input, ['kind', 'requestId', 'focused']);
      if (typeof input.focused !== 'boolean') throw new Error('Invalid focus result');
      return {
        kind: input.kind,
        requestId: expectRequestId(input.requestId),
        focused: input.focused,
      };
    case 'stop':
      expectFields(input, ['kind', 'requestId']);
      return { kind: input.kind, requestId: expectRequestId(input.requestId) };
    default:
      throw new Error('Unsupported broker client message');
  }
}

export function parseBrokerServerMessage(value: unknown): BrokerServerMessage {
  const input = expectObject(value, 'broker server message');
  switch (input.kind) {
    case 'hello':
      expectFields(input, ['kind', 'status', 'protocolVersion', 'presentationEpoch']);
      if (input.status !== 'ready' && input.status !== 'incompatible') {
        throw new Error('Invalid broker handshake status');
      }
      return {
        kind: input.kind,
        status: input.status,
        protocolVersion: expectProtocolVersion(input.protocolVersion),
        presentationEpoch: expectHex(input.presentationEpoch, 32, 'presentation epoch'),
      };
    case 'exchange-receipt':
      expectFields(input, ['kind', 'requestId', 'receipt']);
      return {
        kind: input.kind,
        requestId: expectRequestId(input.requestId),
        receipt: parsePresentationReceipt(input.receipt),
      };
    case 'activation-result':
      expectFields(input, ['kind', 'requestId', 'status']);
      if (input.status !== 'focused' && input.status !== 'failed') {
        throw new Error('Invalid activation result');
      }
      return {
        kind: input.kind,
        requestId: expectRequestId(input.requestId),
        status: input.status,
      };
    case 'focus-offer':
      expectFields(input, ['kind', 'requestId', 'returnTarget']);
      return {
        kind: input.kind,
        requestId: expectRequestId(input.requestId),
        returnTarget: expectBoundedString(input.returnTarget, 4_096, 'return target'),
      };
    case 'stopped':
      expectFields(input, ['kind', 'requestId', 'presentationEpoch', 'epochReset']);
      if (input.epochReset !== true) throw new Error('Invalid broker epoch reset response');
      return {
        kind: input.kind,
        requestId: expectRequestId(input.requestId),
        presentationEpoch: expectHex(input.presentationEpoch, 32, 'presentation epoch'),
        epochReset: true,
      };
    case 'error':
      expectFields(input, ['kind', 'code']);
      if (
        input.code !== 'authentication-failed' &&
        input.code !== 'incompatible-protocol' &&
        input.code !== 'invalid-request'
      ) {
        throw new Error('Invalid broker error code');
      }
      return { kind: input.kind, code: input.code };
    default:
      throw new Error('Unsupported broker server message');
  }
}

function expectObject(value: unknown, description: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${description} must be an object`);
  }
  return value as Record<string, unknown>;
}

function expectFields(input: Record<string, unknown>, fields: readonly string[]): void {
  if (Object.keys(input).length !== fields.length || fields.some((field) => !(field in input))) {
    throw new Error('Broker message contains an unexpected field set');
  }
}

function expectProtocolVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error('Invalid broker protocol version');
  }
  return value as number;
}

function expectRequestId(value: unknown): string {
  return expectHex(value, 32, 'broker request id');
}

function expectHex(value: unknown, length: number, description: string): string {
  if (typeof value !== 'string' || !new RegExp(`^[0-9a-f]{${length}}$`).test(value)) {
    throw new Error(`Invalid ${description}`);
  }
  return value;
}

function expectBoundedString(value: unknown, maximumBytes: number, description: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > maximumBytes
  ) {
    throw new Error(`Invalid ${description}`);
  }
  return value;
}
