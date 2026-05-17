import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';

export interface PlayerInfo {
  command: string;
  args?: string[];
  placeholder?: string; // Default is ${file}
}

export class PlayerRegistry {
  public static getSupportedPlayers(platform: string): Record<string, string> {
    switch (platform) {
      case 'darwin':
        return {
          afplay: '"${file}"',
        };
      case 'win32':
        return {
          powershell:
            '-c "Add-Type -AssemblyName PresentationCore; $player = New-Object System.Windows.Media.MediaPlayer; $player.Open(\'${file}\'); $player.Play(); Start-Sleep -s 10"',
        };
      case 'linux':
        return {
          paplay: '"${file}"',
          'pw-play': '"${file}"',
          'canberra-gtk-play': '--file="${file}"',
          aplay: '"${file}"',
          mpv: '--no-video "${file}"',
          ffplay: '-nodisp -autoexit "${file}"',
        };
      default:
        return {};
    }
  }
}

export class SoundPlayer {
  private detectedPlayerTemplate: string | undefined;
  private isDetected = false;

  constructor(private readonly log?: vscode.OutputChannel) {}

  public async play(soundPath: string, customPlayer?: string): Promise<void> {
    let playerTemplate: string | undefined = customPlayer;

    if (!playerTemplate) {
      if (!this.isDetected) {
        this.detectedPlayerTemplate = this.detectPlayer();
        this.isDetected = true;
      }
      playerTemplate = this.detectedPlayerTemplate;
    }

    if (!playerTemplate) {
      this.log?.appendLine('[SoundPlayer] No suitable sound player found.');
      return;
    }

    // Ensure path is absolute and properly quoted
    const absolutePath = path.isAbsolute(soundPath) ? soundPath : path.resolve(soundPath);

    // We use simple string replacement for ${file}
    const command = playerTemplate.includes('${file}')
      ? playerTemplate.replace(/\$\{file\}/g, absolutePath)
      : `${playerTemplate} "${absolutePath}"`;

    this.log?.appendLine(`[SoundPlayer] Executing (async): ${command}`);

    // Execute asynchronously without awaiting the promise
    new Promise<void>((resolve) => {
      cp.exec(command, (error) => {
        if (error) {
          this.log?.appendLine(`[SoundPlayer] Playback error: ${error.message}`);
        }
        resolve();
      });
    }).catch((err) => {
      this.log?.appendLine(`[SoundPlayer] Unexpected error during async playback: ${err}`);
    });
  }

  private detectPlayer(): string | undefined {
    const players = PlayerRegistry.getSupportedPlayers(process.platform);

    for (const [bin, args] of Object.entries(players)) {
      try {
        // Simple check if command exists using 'which' (Linux/Mac) or 'where' (Windows)
        const checkCmd = process.platform === 'win32' ? `where ${bin}` : `which ${bin}`;
        cp.execSync(checkCmd, { stdio: 'ignore' });
        return `${bin} ${args}`;
      } catch {
        continue;
      }
    }

    return undefined;
  }
}
