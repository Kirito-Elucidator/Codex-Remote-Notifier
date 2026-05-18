import { IncomingMessage, ServerResponse } from 'http';

import * as routerPackageJson from '../../package.json';
import { NotificationHandler } from '../handler/NotificationHandler';
import { extractBearerToken, validateToken } from './auth';

export class Router {
  constructor(
    private readonly handler: NotificationHandler,
    private readonly token: string,
    private readonly maxBodySize: number,
  ) {}

  async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { method, url } = req;

    if (method === 'GET' && url === '/health') {
      return this.sendJson(res, 200, { ok: true, version: routerPackageJson.version });
    }

    if (url === '/notify') {
      if (method !== 'POST') {
        return this.sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
      }
      return this.handleNotify(req, res);
    }

    this.sendJson(res, 404, { ok: false, error: 'not_found' });
  }

  private async handleNotify(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const bearerToken = extractBearerToken(req.headers.authorization);
    if (!bearerToken || !validateToken(bearerToken, this.token)) {
      return this.sendJson(res, 401, { ok: false, error: 'unauthorized' });
    }

    const contentType = req.headers['content-type'];
    if (!contentType || !contentType.includes('application/json')) {
      return this.sendJson(res, 400, {
        ok: false,
        error: 'validation_error',
        details: 'Content-Type must be application/json',
      });
    }

    let body: string;
    try {
      body = await this.readBody(req);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        return this.sendJson(res, 413, { ok: false, error: 'payload_too_large' });
      }
      return this.sendJson(res, 400, {
        ok: false,
        error: 'validation_error',
        details: 'failed to read request body',
      });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return this.sendJson(res, 400, {
        ok: false,
        error: 'validation_error',
        details: 'invalid JSON',
      });
    }

    const result = await this.handler.handle(payload);
    const statusCode = result.ok ? 200 : 400;
    this.sendJson(res, statusCode, result);
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
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
        chunks.push(chunk);
      });

      req.on('end', () => {
        if (!rejected) {
          resolve(Buffer.concat(chunks).toString('utf-8'));
        }
      });
      req.on('error', (err) => {
        if (!rejected) reject(err);
      });
    });
  }

  private sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
    const json = JSON.stringify(body);
    res.writeHead(statusCode, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(json),
    });
    res.end(json);
  }
}

class PayloadTooLargeError extends Error {
  constructor() {
    super('payload too large');
  }
}
