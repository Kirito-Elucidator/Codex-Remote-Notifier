import { NotificationPayload } from './types';

export interface NotificationPresenter {
  present(payload: NotificationPayload): Promise<string | undefined>;
}
