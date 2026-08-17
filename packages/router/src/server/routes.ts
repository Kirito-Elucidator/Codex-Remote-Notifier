import { IncomingMessage, ServerResponse } from 'http';

import * as routerPackageJson from '../../package.json';
import { CodexEventHandler } from '../codex/CodexEventHandler';
import { parseCodexEvent } from '../codex/CodexEventValidation';
import { NotificationHandler } from '../handler/NotificationHandler';
import { extractBearerToken, validateToken } from './auth';

export class Router {
  constructor(
    private readonly handler: NotificationHandler,
    private readonly token: string,
    private readonly maxBodySize: number,
    private readonly codexEvents?: CodexEventHandler,
  ) {}

  async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { method, url } = req;

    if (method === 'GET' && url === '/health') {
      return this.sendJson(res, 200, { ok: true, version: routerPackageJson.version });
    }

    if (url === '/notify' || url === '/notify/async') {
      if (method !== 'POST') {
        return this.sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
      }
      return this.handleNotify(req, res, url === '/notify/async');
    }

    if (url === '/codex/events') {
      if (method !== 'POST') {
        return this.sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
      }
      return this.handleCodexEvent(req, res);
    }

    this.sendJson(res, 404, { ok: false, error: 'not_found' });
  }

  private async handleCodexEvent(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.codexEvents) {
      return this.sendJson(res, 503, { ok: false, error: 'codex_events_unavailable' });
    }

    const payload = await this.readAuthenticatedJson(req, res);
    if (payload === INVALID_REQUEST) return;
    const parsed = parseCodexEvent(payload);
    if (!parsed.ok) {
      return this.sendJson(res, 400, {
        ok: false,
        error: 'validation_error',
        details: parsed.error,
      });
    }

    this.sendJson(res, 202, { ok: true, queued: true });
    void this.codexEvents.handle(parsed.event).catch(() => {});
  }

  private async handleNotify(
    req: IncomingMessage,
    res: ServerResponse,
    respondBeforePresentation: boolean,
  ): Promise<void> {
    const payload = await this.readAuthenticatedJson(req, res);
    if (payload === INVALID_REQUEST) return;

    if (respondBeforePresentation) {
      this.sendJson(res, 202, { ok: true, queued: true });
      void this.handler.handle(payload).catch(() => {});
      return;
    }

    const result = await this.handler.handle(payload);
    const statusCode = result.ok ? 200 : 400;
    this.sendJson(res, statusCode, result);
  }

  private async readAuthenticatedJson(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<unknown | typeof INVALID_REQUEST> {
    const bearerToken = extractBearerToken(req.headers.authorization);
    if (!bearerToken || !validateToken(bearerToken, this.token)) {
      this.sendJson(res, 401, { ok: false, error: 'unauthorized' });
      return INVALID_REQUEST;
    }

    const contentType = req.headers['content-type'];
    if (!isUtf8JsonContentType(contentType)) {
      this.sendJson(res, 400, {
        ok: false,
        error: 'validation_error',
        details: 'Content-Type must be application/json',
      });
      return INVALID_REQUEST;
    }

    let body: string;
    try {
      body = await this.readBody(req);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        this.sendJson(res, 413, { ok: false, error: 'payload_too_large' });
        return INVALID_REQUEST;
      }
      if (err instanceof InvalidUtf8Error) {
        this.sendJson(res, 400, {
          ok: false,
          error: 'validation_error',
          details: 'invalid UTF-8 JSON',
        });
        return INVALID_REQUEST;
      }
      this.sendJson(res, 400, {
        ok: false,
        error: 'validation_error',
        details: 'failed to read request body',
      });
      return INVALID_REQUEST;
    }

    try {
      return JSON.parse(body);
    } catch {
      this.sendJson(res, 400, {
        ok: false,
        error: 'validation_error',
        details: 'invalid JSON',
      });
      return INVALID_REQUEST;
    }
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
      let body = '';
      let size = 0;
      let rejected = false;

      req.on('data', (chunk: Buffer) => {
        if (rejected) return;
        size += chunk.length;
        if (size > this.maxBodySize) {
          rejected = true;
          req.resume();
          reject(new PayloadTooLargeError());
          return;
        }
        try {
          body += decoder.decode(chunk, { stream: true });
        } catch (error) {
          rejected = true;
          req.resume();
          reject(new InvalidUtf8Error(error));
        }
      });

      req.on('end', () => {
        if (!rejected) {
          try {
            resolve(body + decoder.decode());
          } catch (error) {
            reject(new InvalidUtf8Error(error));
          }
        }
      });
      req.on('error', (err) => {
        if (!rejected) reject(err);
      });
    });
  }

  private sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
    const bytes = Buffer.from(JSON.stringify(body), 'utf-8');
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': bytes.length,
    });
    res.end(bytes);
  }
}

const INVALID_REQUEST = Symbol('invalid request');

class PayloadTooLargeError extends Error {
  constructor() {
    super('payload too large');
  }
}

class InvalidUtf8Error extends Error {
  constructor(cause: unknown) {
    super('invalid UTF-8', { cause });
  }
}

function isUtf8JsonContentType(value: string | undefined): boolean {
  if (!value) return false;
  const [mediaType, ...parameters] = value.split(';').map((part) => part.trim().toLowerCase());
  if (mediaType !== 'application/json') return false;
  const charsets = parameters.filter((parameter) => parameter.startsWith('charset='));
  return charsets.every((charset) => charset === 'charset=utf-8' || charset === 'charset=utf8');
}
