import { randomBytes } from 'crypto';

import {
  NotificationPayload,
  NotificationPresenter,
  NotificationResponse,
} from 'remote-notifier-shared';

import { Configuration } from '../config/Configuration';

const MAX_MESSAGE_LENGTH = 1000;
const MAX_TITLE_LENGTH = 100;
const MAX_ICON_LENGTH = 50;
const VALID_LEVELS = ['information', 'warning', 'error'];
const VALID_DISPLAYS = ['app', 'system'];

export class NotificationHandler {
  constructor(
    private readonly presenter: NotificationPresenter,
    private readonly config: Configuration,
  ) {}

  async handle(payload: unknown): Promise<NotificationResponse> {
    const validationError = this.validate(payload);
    if (validationError) {
      return { ok: false, error: 'validation_error', details: validationError };
    }

    const formatted = this.format(payload as NotificationPayload);

    try {
      await this.presenter.present(formatted);
      const id = `notif_${randomBytes(8).toString('hex')}`;
      return { ok: true, id };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      return { ok: false, error: 'presenter_error', details: message };
    }
  }

  private validate(payload: unknown): string | null {
    if (typeof payload !== 'object' || payload === null) {
      return 'request body must be a JSON object';
    }

    const obj = payload as Record<string, unknown>;

    if (typeof obj.message !== 'string' || obj.message.length === 0) {
      return 'message is required and must be a non-empty string';
    }
    if (obj.message.length > MAX_MESSAGE_LENGTH) {
      return `message exceeds maximum length of ${MAX_MESSAGE_LENGTH} characters`;
    }

    if (obj.title !== undefined) {
      if (typeof obj.title !== 'string') {
        return 'title must be a string';
      }
      if (obj.title.length > MAX_TITLE_LENGTH) {
        return `title exceeds maximum length of ${MAX_TITLE_LENGTH} characters`;
      }
    }

    if (obj.level !== undefined) {
      if (typeof obj.level !== 'string' || !VALID_LEVELS.includes(obj.level)) {
        return `level must be one of: ${VALID_LEVELS.join(', ')}`;
      }
    }

    if (obj.display_hint !== undefined) {
      if (typeof obj.display_hint !== 'string' || !VALID_DISPLAYS.includes(obj.display_hint)) {
        return `display_hint must be one of: ${VALID_DISPLAYS.join(', ')}`;
      }
    }

    if (obj.icon !== undefined) {
      if (typeof obj.icon !== 'string') {
        return 'icon must be a string';
      }
      if (obj.icon.length > MAX_ICON_LENGTH) {
        return `icon exceeds maximum length of ${MAX_ICON_LENGTH} characters`;
      }
    }

    return null;
  }

  private format(payload: NotificationPayload): NotificationPayload {
    let message = payload.message;

    if (this.config.showTimestamp) {
      const timestamp = new Date().toISOString();
      message = `[${timestamp}] ${message}`;
    }

    return {
      ...payload,
      message,
      level: payload.level ?? this.config.notificationLevel,
    };
  }
}
