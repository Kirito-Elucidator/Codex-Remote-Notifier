import * as path from 'path';

import * as vscode from 'vscode';

import * as notifier from 'node-notifier';

import { fileExists, NotificationPayload, NotificationPresenter } from 'remote-notifier-shared';

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
    const soundEnabled = config.get<boolean>('notificationSound', true);
    const customPlayer = config.get<string>('notificationSoundPlayer', '');

    const iconPath = await this.resolveIconPath(payload, config);
    const { soundPath, useNativeSound } = await this.resolveSoundPath(payload, config);

    if (soundEnabled && soundPath) {
      this.soundPlayer.play(soundPath, customPlayer);
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

  private async resolveIconPath(
    payload: NotificationPayload,
    config: vscode.WorkspaceConfiguration,
  ): Promise<string> {
    const iconMappings = config.get<Record<string, string>>('iconMappings', {});
    const iconStyle = config.get<string>('notificationIcon', 'transparent');
    const defaultIcon = ICONS[iconStyle] || ICONS.transparent;

    if (payload.icon) {
      const mappedPath = iconMappings[payload.icon];
      if (mappedPath) {
        if (await fileExists(mappedPath)) {
          this.log?.appendLine(
            `[SystemPresenter] Using mapped icon: "${payload.icon}" -> "${mappedPath}"`,
          );
          return mappedPath;
        } else {
          this.log?.appendLine(
            `[SystemPresenter] Mapped icon path does not exist: "${mappedPath}". Falling back.`,
          );
        }
      } else {
        this.log?.appendLine(
          `[SystemPresenter] No icon mapping found for key: "${payload.icon}". Falling back.`,
        );
      }
    }

    this.log?.appendLine(`[SystemPresenter] Using default icon: "${defaultIcon}"`);
    return defaultIcon;
  }

  private async resolveSoundPath(
    payload: NotificationPayload,
    config: vscode.WorkspaceConfiguration,
  ): Promise<{ soundPath?: string; useNativeSound: boolean }> {
    const soundEnabled = config.get<boolean>('notificationSound', true);
    if (!soundEnabled) {
      this.log?.appendLine('[SystemPresenter] Sound is disabled in settings.');
      return { useNativeSound: false };
    }

    const soundMappings = config.get<Record<string, string>>('soundMappings', {});
    const globalSoundPath = config.get<string>('notificationSoundPath', '');

    // 1. Check mapped sound
    if (payload.sound) {
      const mappedPath = soundMappings[payload.sound];
      if (mappedPath) {
        if (await fileExists(mappedPath)) {
          this.log?.appendLine(
            `[SystemPresenter] Using mapped sound: "${payload.sound}" -> "${mappedPath}"`,
          );
          return { soundPath: mappedPath, useNativeSound: false };
        } else {
          this.log?.appendLine(
            `[SystemPresenter] Mapped sound path does not exist: "${mappedPath}". Falling back.`,
          );
        }
      } else {
        this.log?.appendLine(
          `[SystemPresenter] No sound mapping found for key: "${payload.sound}". Falling back.`,
        );
      }
    }

    // 2. Check global custom sound
    if (globalSoundPath) {
      if (await fileExists(globalSoundPath)) {
        this.log?.appendLine(`[SystemPresenter] Using global custom sound: "${globalSoundPath}"`);
        return { soundPath: globalSoundPath, useNativeSound: false };
      } else {
        this.log?.appendLine(
          `[SystemPresenter] Global custom sound path does not exist: "${globalSoundPath}". Falling back.`,
        );
      }
    }

    // 3. Platform-specific defaults
    if (process.platform === 'linux') {
      this.log?.appendLine(`[SystemPresenter] Using bundled Linux sound: "${BUNDLED_SOUND}"`);
      return { soundPath: BUNDLED_SOUND, useNativeSound: false };
    }

    this.log?.appendLine('[SystemPresenter] Using OS native notification sound.');
    return { useNativeSound: true };
  }
}
