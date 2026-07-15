import { randomBytes } from 'crypto';
import * as http from 'http';
import type { AddressInfo } from 'net';

import * as vscode from 'vscode';

import {
  CodexFocusResult,
  COMMAND_FOCUS_CODEX_SESSION,
  COMMAND_FOCUS_CODEX_SESSION_PREFIX,
  NotificationPayload,
} from 'remote-notifier-shared';

const EXTENSION_ID = 'ddyndo.remote-notifier-codex';
const ACTIVATION_PATH = '/notification';
const BROKER_PATH = '/activate';
const MAX_ACTIVATIONS = 256;
const MAX_SESSION_ID_LENGTH = 200;
const FORWARD_TIMEOUT_MS = 1500;
const URI_ACTIVATION_SETTLE_MS = 150;

interface ActivationTarget {
  sessionId: string;
  focusCommand?: string;
  createdAt: number;
}

type ForwardResult = 'accepted' | 'unavailable' | 'unknown';

export class NotificationFocusBroker implements vscode.Disposable {
  private readonly activations = new Map<string, ActivationTarget>();
  private readonly activationTimers = new Set<ReturnType<typeof setTimeout>>();
  private server?: http.Server;
  private port?: number;

  constructor(
    private readonly log?: vscode.OutputChannel,
    private readonly activationDelayMs = URI_ACTIVATION_SETTLE_MS,
  ) {}

  async start(): Promise<void> {
    if (this.server) return;

    const server = http.createServer((request, response) => {
      void this.handleBrokerRequest(request, response).catch((error) => {
        this.log?.appendLine(`[NotificationFocusBroker] Activation request failed: ${error}`);
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(0, '127.0.0.1');
    });
    this.port = (server.address() as AddressInfo).port;
    this.log?.appendLine(`[NotificationFocusBroker] Listening on 127.0.0.1:${this.port}`);
  }

  createLaunchUri(payload: NotificationPayload): string {
    const baseUri = `${vscode.env.uriScheme}://${EXTENSION_ID}${ACTIVATION_PATH}`;
    const sessionId = this.parseSessionId(payload.session_id ?? null);
    if (payload.source !== 'codex' || !sessionId) return baseUri;

    const focusCommand = this.parseFocusCommand(payload.codex_focus_command);
    const query = new URLSearchParams({ session_id: sessionId });
    if (focusCommand) query.set('focus_command', focusCommand);

    if (this.port) {
      const activation = randomBytes(32).toString('hex');
      this.activations.set(activation, { sessionId, focusCommand, createdAt: Date.now() });
      this.pruneActivations();
      query.set('port', String(this.port));
      query.set('activation', activation);
    }
    return `${baseUri}?${query.toString()}`;
  }

  handleUri(uri: vscode.Uri): void {
    if (uri.path !== ACTIVATION_PATH) return;

    const query = new URLSearchParams(uri.query);
    const port = this.parsePort(query.get('port'));
    const activation = query.get('activation');
    const fallbackSessionId = this.parseSessionId(query.get('session_id'));
    const fallbackFocusCommand = this.parseFocusCommand(query.get('focus_command'));

    // Let VS Code finish handling the protocol URI before another window claims focus.
    // Otherwise the URI-owning window can steal focus back after the target briefly appears.
    this.scheduleActivation(async () => {
      if (port && activation && this.isActivationToken(activation)) {
        if (port === this.port) {
          if (await this.activateLocal(activation)) return;
        } else {
          const forwarded = await this.forwardActivation(port, activation);
          if (forwarded === 'accepted') {
            this.log?.appendLine(
              '[NotificationFocusBroker] Originating window accepted the activation',
            );
            return;
          }
          if (forwarded === 'unknown') {
            this.log?.appendLine(
              '[NotificationFocusBroker] Activation delivery is uncertain; skipping current-window fallback',
            );
            return;
          }
        }
      }

      this.log?.appendLine(
        '[NotificationFocusBroker] Originating window is unavailable; using the current window fallback',
      );
      await this.focusSession(fallbackSessionId, fallbackFocusCommand);
    });
  }

  dispose(): void {
    this.activations.clear();
    this.activationTimers.forEach((timer) => clearTimeout(timer));
    this.activationTimers.clear();
    this.server?.close();
    this.server = undefined;
    this.port = undefined;
  }

  private async handleBrokerRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    if (request.method !== 'POST' || request.url !== BROKER_PATH) {
      response.writeHead(404).end();
      return;
    }

    const authorization = request.headers.authorization;
    const activation = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : '';
    if (!this.isActivationToken(activation)) {
      response.writeHead(401).end();
      return;
    }

    const target = this.takeActivation(activation);
    if (!target) {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: false }));
      return;
    }

    // Acknowledge ownership before window activation or remote Router commands can block.
    response.writeHead(202, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: true, accepted: true }));
    void this.focusTarget(target);
  }

  private async activateLocal(activation: string): Promise<boolean> {
    const target = this.takeActivation(activation);
    if (!target) return false;
    await this.focusTarget(target);
    return true;
  }

  private takeActivation(activation: string): ActivationTarget | undefined {
    const target = this.activations.get(activation);
    if (target) this.activations.delete(activation);
    return target;
  }

  private async focusTarget(target: ActivationTarget): Promise<void> {
    try {
      await this.focusSession(target.sessionId, target.focusCommand);
    } catch (error) {
      this.log?.appendLine(`[NotificationFocusBroker] Claimed activation failed: ${error}`);
    }
  }

  private async focusSession(sessionId?: string, focusCommand?: string): Promise<void> {
    try {
      await vscode.commands.executeCommand('workbench.action.focusWindow');
    } catch (error) {
      this.log?.appendLine(`[NotificationFocusBroker] Failed to focus VS Code window: ${error}`);
    }
    if (!sessionId) return;

    const preferredCommand = this.parseFocusCommand(focusCommand);
    const commands = preferredCommand
      ? [preferredCommand, COMMAND_FOCUS_CODEX_SESSION]
      : [COMMAND_FOCUS_CODEX_SESSION];
    for (const command of commands) {
      try {
        const result = await vscode.commands.executeCommand<CodexFocusResult>(command, {
          session_id: sessionId,
        });
        if (result?.ok) {
          this.log?.appendLine(
            `[NotificationFocusBroker] Focused Codex session ${sessionId} in terminal "${result.terminal_name ?? ''}"`,
          );
          return;
        }
        this.log?.appendLine(
          `[NotificationFocusBroker] Codex terminal focus failed via ${command} for ${sessionId}: ${result?.reason ?? 'no-result'}`,
        );
      } catch (error) {
        this.log?.appendLine(
          `[NotificationFocusBroker] Codex terminal focus command ${command} failed for ${sessionId}: ${error}`,
        );
      }
    }

    await vscode.window.showWarningMessage(
      'Remote Notifier: The original Codex terminal is closed or could not be located.',
    );
  }

  private forwardActivation(port: number, activation: string): Promise<ForwardResult> {
    return new Promise((resolve) => {
      let timedOut = false;
      let settled = false;
      const finish = (result: ForwardResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const request = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: BROKER_PATH,
          method: 'POST',
          headers: { Authorization: `Bearer ${activation}` },
          timeout: FORWARD_TIMEOUT_MS,
        },
        (response) => {
          response.resume();
          response.on('end', () => {
            const status = response.statusCode ?? 0;
            finish(status >= 200 && status < 300 ? 'accepted' : 'unavailable');
          });
          response.on('aborted', () => finish('unknown'));
          response.on('error', () => finish('unknown'));
        },
      );
      request.on('timeout', () => {
        timedOut = true;
        request.destroy();
      });
      request.on('error', (error: NodeJS.ErrnoException) => {
        finish(!timedOut && error.code === 'ECONNREFUSED' ? 'unavailable' : 'unknown');
      });
      request.end();
    });
  }

  private parsePort(value: string | null): number | undefined {
    if (!value || !/^\d{1,5}$/.test(value)) return undefined;
    const port = Number(value);
    return port > 0 && port <= 65535 ? port : undefined;
  }

  private parseSessionId(value: string | null): string | undefined {
    if (!value || value.length > MAX_SESSION_ID_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) {
      return undefined;
    }
    return value;
  }

  private parseFocusCommand(value: string | null | undefined): string | undefined {
    if (!value?.startsWith(COMMAND_FOCUS_CODEX_SESSION_PREFIX)) return undefined;
    const instanceId = value.slice(COMMAND_FOCUS_CODEX_SESSION_PREFIX.length);
    return /^[0-9a-f]{32}$/.test(instanceId) ? value : undefined;
  }

  private isActivationToken(value: string | null | undefined): value is string {
    return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
  }

  private scheduleActivation(callback: () => Promise<void>): void {
    const timer = setTimeout(() => {
      this.activationTimers.delete(timer);
      void callback().catch((error) => {
        this.log?.appendLine(`[NotificationFocusBroker] Scheduled activation failed: ${error}`);
      });
    }, this.activationDelayMs);
    this.activationTimers.add(timer);
  }

  private pruneActivations(): void {
    if (this.activations.size <= MAX_ACTIVATIONS) return;
    const oldest = [...this.activations.entries()]
      .sort((left, right) => left[1].createdAt - right[1].createdAt)
      .slice(0, this.activations.size - MAX_ACTIVATIONS);
    oldest.forEach(([activation]) => this.activations.delete(activation));
  }
}
