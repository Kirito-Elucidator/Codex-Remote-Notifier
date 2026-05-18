import * as http from 'http';

import * as vscode from 'vscode';

import { Configuration } from '../config/Configuration';
import { NotificationHandler } from '../handler/NotificationHandler';
import { Router } from './routes';

export class NotificationServer implements vscode.Disposable {
  private server: http.Server | null = null;
  private _port = 0;
  private router: Router | null = null;

  get port(): number {
    return this._port;
  }

  constructor(
    private readonly handler: NotificationHandler,
    private readonly config: Configuration,
  ) {}

  async start(token: string): Promise<void> {
    this.router = new Router(this.handler, token, this.config.maxBodySize);
    this.server = http.createServer(this.handleRequest.bind(this));

    const configuredPort = this.config.port;
    try {
      await this.listen(configuredPort);
    } catch (err: unknown) {
      if (isAddrInUse(err) && configuredPort !== 0) {
        vscode.window.showWarningMessage(
          `Remote Notifier: Port ${configuredPort} is in use, using a random port instead.`,
        );
        await this.listen(0);
      } else {
        throw err;
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }
    return new Promise((resolve, reject) => {
      this.server!.close((err) => {
        this.server = null;
        this._port = 0;
        if (err) reject(err);
        else resolve();
      });
    });
  }

  updateToken(token: string): void {
    this.router = new Router(this.handler, token, this.config.maxBodySize);
  }

  dispose(): void {
    this.stop().catch(() => {});
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.router!.dispatch(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'internal_error' }));
      }
    });
  }

  private listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, '127.0.0.1', () => {
        this.server!.removeListener('error', reject);
        const addr = this.server!.address();
        if (addr && typeof addr === 'object') {
          this._port = addr.port;
        }
        resolve();
      });
    });
  }
}

function isAddrInUse(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'EADDRINUSE';
}
