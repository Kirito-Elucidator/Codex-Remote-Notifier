import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { NotificationPresenter } from 'remote-notifier-shared';
import { NotificationServer } from '../../src/server/NotificationServer';
import { NotificationHandler } from '../../src/handler/NotificationHandler';
import { Configuration } from '../../src/config/Configuration';
import { sendNotification, checkHealth, sendRaw } from '../helpers/http-client';
import * as routerPackageJson from '../../package.json';

describe('HTTP API Integration', () => {
  let server: NotificationServer;
  let mockPresenter: NotificationPresenter;
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
    server = new NotificationServer(handler, config);
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
