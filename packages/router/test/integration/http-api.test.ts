import * as http from 'http';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NotificationPresenter } from 'remote-notifier-shared';
import { NotificationServer } from '../../src/server/NotificationServer';
import { NotificationHandler } from '../../src/handler/NotificationHandler';
import { Configuration } from '../../src/config/Configuration';
import { CodexEventHandler } from '../../src/codex/CodexEventHandler';
import { sendNotification, checkHealth, sendRaw } from '../helpers/http-client';
import * as routerPackageJson from '../../package.json';

describe('HTTP API Integration', () => {
  let server: NotificationServer;
  let mockPresenter: NotificationPresenter;
  let mockCodexEvents: Pick<CodexEventHandler, 'handle'>;
  const token = 'test_token_' + 'a'.repeat(53);
  let port: number;

  beforeAll(async () => {
    mockPresenter = { present: vi.fn().mockResolvedValue(undefined) };
    const config = {
      port: 0,
      maxBodySize: 1024,
      enabled: true,
      notificationLevel: 'information',
      showTimestamp: false,
    } as unknown as Configuration;
    const handler = new NotificationHandler(mockPresenter, config);
    mockCodexEvents = { handle: vi.fn().mockResolvedValue(undefined) };
    server = new NotificationServer(handler, config, mockCodexEvents as CodexEventHandler);
    await server.start(token);
    port = server.port;
  });

  afterAll(async () => {
    await server.stop();
  });

  describe('GET /health', () => {
    it('returns 200 with version', async () => {
      const { status, body } = await checkHealth(port);
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.version).toBe(routerPackageJson.version);
    });

    it('requires no authentication', async () => {
      const res = await sendRaw(port, 'GET', '/health', {});
      expect(res.status).toBe(200);
    });
  });

  describe('POST /notify', () => {
    it('returns 200 for valid request', async () => {
      const { status, body } = await sendNotification(port, token, {
        message: 'Hello',
      });
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.id).toMatch(/^notif_/);
    });

    it('calls presenter with payload', async () => {
      vi.mocked(mockPresenter.present).mockClear();
      await sendNotification(port, token, {
        message: 'Test message',
        level: 'warning',
      });
      expect(mockPresenter.present).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Test message', level: 'warning' }),
      );
    });

    it('returns 401 without auth header', async () => {
      const res = await sendRaw(
        port,
        'POST',
        '/notify',
        {
          'Content-Type': 'application/json',
        },
        '{"message":"hi"}',
      );
      expect(res.status).toBe(401);
    });

    it('returns 401 with wrong token', async () => {
      const { status } = await sendNotification(port, 'wrong_token', {
        message: 'hi',
      });
      expect(status).toBe(401);
    });

    it('returns 400 for invalid JSON', async () => {
      const res = await sendRaw(
        port,
        'POST',
        '/notify',
        {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        'not json',
      );
      expect(res.status).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.details).toContain('invalid JSON');
    });

    it('returns 400 for missing message', async () => {
      const res = await sendRaw(
        port,
        'POST',
        '/notify',
        {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        '{"title":"no message"}',
      );
      expect(res.status).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.details).toContain('message is required');
    });

    it('returns 400 for wrong content-type', async () => {
      const res = await sendRaw(
        port,
        'POST',
        '/notify',
        {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'text/plain',
        },
        '{"message":"hi"}',
      );
      expect(res.status).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.details).toContain('Content-Type');
    });

    it('rejects a non-UTF-8 JSON charset instead of guessing its encoding', async () => {
      const response = await sendRaw(
        port,
        'POST',
        '/notify',
        {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=windows-1252',
        },
        '{"message":"hello"}',
      );

      expect(response.status).toBe(400);
      expect(JSON.parse(response.body).details).toContain('Content-Type');
    });

    it('accepts a quoted UTF-8 JSON charset', async () => {
      const response = await sendRaw(
        port,
        'POST',
        '/notify',
        {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset="UTF-8"',
        },
        '{"message":"hello"}',
      );

      expect(response.status).toBe(200);
    });

    it('returns 413 for payload exceeding maxBodySize', async () => {
      const largeBody = JSON.stringify({ message: 'x'.repeat(2000) });
      const res = await sendRaw(
        port,
        'POST',
        '/notify',
        {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        largeBody,
      );
      expect(res.status).toBe(413);
    });

    it('returns 405 for GET /notify', async () => {
      const res = await sendRaw(port, 'GET', '/notify', {});
      expect(res.status).toBe(405);
    });

    it('returns 405 for PUT /notify', async () => {
      const res = await sendRaw(
        port,
        'PUT',
        '/notify',
        {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        '{"message":"hi"}',
      );
      expect(res.status).toBe(405);
    });
  });

  describe('POST /notify/async', () => {
    it('acknowledges a valid hook request before presentation completes', async () => {
      let finishPresentation: (() => void) | undefined;
      vi.mocked(mockPresenter.present).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishPresentation = resolve;
          }),
      );

      const response = await sendRaw(
        port,
        'POST',
        '/notify/async',
        {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        JSON.stringify({ message: 'Async hook notification' }),
      );

      expect(response.status).toBe(202);
      expect(JSON.parse(response.body)).toMatchObject({ ok: true, queued: true });
      expect(mockPresenter.present).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Async hook notification' }),
      );
      finishPresentation?.();
    });

    it('still authenticates asynchronous hook requests', async () => {
      const response = await sendRaw(
        port,
        'POST',
        '/notify/async',
        { 'Content-Type': 'application/json' },
        JSON.stringify({ message: 'Unauthorized' }),
      );

      expect(response.status).toBe(401);
    });
  });

  describe('POST /codex/events', () => {
    const validEvent = {
      version: 1,
      kind: 'protocol',
      method: 'turn/started',
      instance_id: 'instance-1',
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      process_ancestry: [42],
    };

    it('authenticates, validates, and immediately accepts a protocol event', async () => {
      let finishHandling: (() => void) | undefined;
      vi.mocked(mockCodexEvents.handle).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishHandling = resolve;
          }),
      );

      const response = await sendRaw(
        port,
        'POST',
        '/codex/events',
        {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        JSON.stringify(validEvent),
      );

      expect(response.status).toBe(202);
      expect(JSON.parse(response.body)).toMatchObject({ ok: true, queued: true });
      expect(mockCodexEvents.handle).toHaveBeenCalledWith(validEvent);
      finishHandling?.();
    });

    it('accepts a bounded error occurrence id and rejects an oversized one', async () => {
      const errorEvent = {
        ...validEvent,
        method: 'error',
        occurrence_id: 'error-42',
        will_retry: true,
        error: {
          message: 'temporary disconnect',
          code: 'responseStreamDisconnected',
        },
      };
      const accepted = await sendRaw(
        port,
        'POST',
        '/codex/events',
        {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        JSON.stringify(errorEvent),
      );
      expect(accepted.status).toBe(202);

      const rejected = await sendRaw(
        port,
        'POST',
        '/codex/events',
        {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        JSON.stringify({ ...errorEvent, occurrence_id: 'x'.repeat(201) }),
      );
      expect(rejected.status).toBe(400);
    });

    it('rejects unauthenticated event requests', async () => {
      const response = await sendRaw(
        port,
        'POST',
        '/codex/events',
        { 'Content-Type': 'application/json' },
        JSON.stringify(validEvent),
      );

      expect(response.status).toBe(401);
    });

    it('rejects malformed or non-whitelisted protocol events', async () => {
      vi.mocked(mockCodexEvents.handle).mockClear();
      const response = await sendRaw(
        port,
        'POST',
        '/codex/events',
        {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        JSON.stringify({ ...validEvent, method: 'item/agentMessage/delta' }),
      );

      expect(response.status).toBe(400);
      expect(mockCodexEvents.handle).not.toHaveBeenCalled();
    });

    it('rejects an entire malformed UTF-8 envelope without handling its valid prefix', async () => {
      vi.mocked(mockCodexEvents.handle).mockClear();
      const prefix = Buffer.from(
        '{"version":1,"kind":"protocol","method":"turn/completed","instance_id":"instance-1","thread_id":"thread-1","turn_id":"turn-1","status":"completed","preview":"',
        'utf-8',
      );
      const malformed = Buffer.from([0xc3, 0x28]);
      const suffix = Buffer.from('"}', 'utf-8');

      const response = await sendRawChunks(port, token, [prefix, malformed, suffix]);

      expect(response.status).toBe(400);
      expect(JSON.parse(response.body)).toMatchObject({
        error: 'validation_error',
        details: 'invalid UTF-8 JSON',
      });
      expect(mockCodexEvents.handle).not.toHaveBeenCalled();
    });

    it('streams split UTF-8 JSON without changing Chinese, emoji, or combining marks', async () => {
      vi.mocked(mockCodexEvents.handle).mockClear();
      const preview = '中文🙂e\u0301<&>';
      const bytes = Buffer.from(
        JSON.stringify({
          ...validEvent,
          method: 'turn/completed',
          status: 'completed',
          preview,
        }),
        'utf-8',
      );
      const chinese = Buffer.from('中', 'utf-8');
      const split = bytes.indexOf(chinese) + 1;

      const response = await sendRawChunks(port, token, [
        bytes.subarray(0, split),
        bytes.subarray(split),
      ]);

      expect(response.status).toBe(202);
      expect(mockCodexEvents.handle).toHaveBeenCalledWith(expect.objectContaining({ preview }));
    });

    it('rejects raw protocol fields outside the sanitized event contract', async () => {
      const response = await sendRaw(
        port,
        'POST',
        '/codex/events',
        {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        JSON.stringify({ ...validEvent, prompt: 'must never enter the Router' }),
      );

      expect(response.status).toBe(400);
    });

    it('enforces the shared request size limit', async () => {
      const response = await sendRaw(
        port,
        'POST',
        '/codex/events',
        {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        JSON.stringify({ ...validEvent, preview: 'x'.repeat(2000) }),
      );

      expect(response.status).toBe(413);
    });

    it('rejects non-POST methods', async () => {
      const response = await sendRaw(port, 'GET', '/codex/events', {});
      expect(response.status).toBe(405);
    });
  });

  describe('unknown paths', () => {
    it('returns 404 for unknown path', async () => {
      const res = await sendRaw(port, 'GET', '/unknown', {});
      expect(res.status).toBe(404);
    });

    it('returns 404 for POST to unknown path', async () => {
      const res = await sendRaw(
        port,
        'POST',
        '/other',
        {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        '{}',
      );
      expect(res.status).toBe(404);
    });
  });

  describe('concurrent requests', () => {
    it('handles multiple simultaneous requests', async () => {
      const promises = Array.from({ length: 10 }, (_, i) =>
        sendNotification(port, token, { message: `concurrent ${i}` }),
      );
      const results = await Promise.all(promises);
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(new Set(results.map((r) => r.body.id)).size).toBe(10);
    });
  });
});

function sendRawChunks(
  port: number,
  token: string,
  chunks: Buffer[],
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/codex/events',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
      },
      (response) => {
        const responseChunks: Buffer[] = [];
        response.on('data', (chunk) => responseChunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(responseChunks).toString('utf-8'),
          }),
        );
      },
    );
    request.on('error', reject);
    for (const chunk of chunks) request.write(chunk);
    request.end();
  });
}
