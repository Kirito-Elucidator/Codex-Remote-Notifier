import * as vscode from 'vscode';
import * as path from 'path';
import * as notifier from 'node-notifier';
import { NotificationPayload } from 'remote-notifier-shared';
import { NotificationPresenter } from './VscodePresenter';
import { SoundPlayer } from './SoundPlayer';

const ICONS: Record<string, string> = {
  transparent: path.join(__dirname, 'icon-transparent.png'),
  dark: path.join(__dirname, 'icon.png'),
};

const BUNDLED_SOUND = path.join(__dirname, 'notification.wav');

export class SystemPresenter implements NotificationPresenter {
  private readonly soundPlayer: SoundPlayer;

  constructor(private readonly log?: vscode.OutputChannel) {
    this.soundPlayer = new SoundPlayer(log);
  }

  async present(payload: NotificationPayload): Promise<string | undefined> {
    const title = payload.title ?? 'Remote Notifier';
    const config = vscode.workspace.getConfiguration('remoteNotifier');
    const iconStyle = config.get<string>('notificationIcon', 'transparent');
    const soundEnabled = config.get<boolean>('notificationSound', true);
    const customSoundPath = config.get<string>('notificationSoundPath', '');
    const customPlayer = config.get<string>('notificationSoundPlayer', '');
    const mappings = config.get<Record<string, string>>('iconMappings', {});
    const iconPath =
      (payload.icon && mappings[payload.icon]) || ICONS[iconStyle] || ICONS.transparent;

    let useNativeSound = false;

    if (soundEnabled) {
      if (customSoundPath) {
        // Play custom sound
        this.soundPlayer.play(customSoundPath, customPlayer);
      } else if (process.platform === 'linux') {
        // On Linux, use bundled sound if enabled and no custom path
        this.soundPlayer.play(BUNDLED_SOUND, customPlayer);
      } else {
        // On Mac/Windows, use native sound via node-notifier
        useNativeSound = true;
      }
    }

    this.log?.appendLine(
      `[SystemPresenter] Sending OS notification: title="${title}" message="${payload.message}" icon="${iconPath}" nativeSound=${useNativeSound}`,
    );

    try {
      notifier.notify(
        {
          title,
          message: payload.message,
          icon: iconPath,
          sound: useNativeSound,
          wait: false,
          appName: 'Remote Notifier',
        } as notifier.Notification,
        (err) => {
          if (err) {
            this.log?.appendLine(`[SystemPresenter] System notification error: ${err}`);
          }
        },
      );
      this.log?.appendLine('[SystemPresenter] notifier.notify() called successfully');
    } catch (err) {
      this.log?.appendLine(`[SystemPresenter] notifier.notify() threw: ${err}`);
    }

    return undefined;
  }
}
