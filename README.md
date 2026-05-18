# Remote Notifier

> ### Stay informed about progress of your work without having to babysit it!

<p align="center">
  <img src="https://raw.githubusercontent.com/ripper37/remote-notifier/master/assets/example_notification.png" height="146">
</p>

**Remote Notifier** lets you trigger notifications from remote environments like
SSH, Docker or WSL and receive them instantly on your local machine through VS
Code.

Whether you're building your code, running tests, using some tools, or working
with an AI agents, you no longer need to keep checking back or risk missing
anything.

### Why Remote Notifier?

Working in remote environments often means losing visibility. \
You start a long-running task and then either:

- have to keep checking if it’s done already
- forget about it and come back way too late
- miss that it failed early, did nothing useful and wasted your time

This extension fixes that by allowing you to get instant notifications about
progress of your work regardless of where the work is done.

**No extra dependencies, no complex configuration, just pure productivity!**

## How It Works

**Remote Notifier** consists of two VS Code extensions:

### 🔔 Remote Notifier

- Main extension
- Runs on your local machine (UI side of the VS Code)
- Checks if the Router helper extension is installed in current workspace and
  suggests installing it if it's missing
- Receives notifications from the Router extension
- Displays them as either in-app or system level notifications

### 🔀 Remote Notifier (Router)

- Helper extension
- Runs where your workspace is (local or remote: SSH, WSL, Docker, ...)
- Exposes a simple local HTTP endpoint and installs a `code-notify` convenience
  script to simplify using it
- Allows scripts, tools, or terminal commands to trigger notifications

Neither of them require any external dependencies, 3rd party binaries or manual
configuration to work!

### Platform Support

| Component                    | Windows 10/11 |       macOS       |             Linux             |
| ---------------------------- | :-----------: | :---------------: | :---------------------------: |
| Main extension (UI)          |      Yes      |        Yes        |              Yes              |
| Router extension (workspace) |      Yes      |        Yes        |              Yes              |
| `code-notify` CLI            | `.cmd` script |    Bash script    |          Bash script          |
| OS notifications             |  SnoreToast   | terminal-notifier |          notify-send          |
| Notification sound           |      Yes      |        Yes        | Desktop environment dependent |

## How To Use

### Install extensions

The recommended way is to:

1. Install the main `Remote Notifier` extension from its
   [marketplace page](https://marketplace.visualstudio.com/items?itemName=ddyndo.remote-notifier)
2. Install helper `Remote Notifier (Router)` extension whenever prompted by the
   main extension by clicking `Install in ...` button from the notification
   - Or install it manually from its
     [marketplace page](https://marketplace.visualstudio.com/items?itemName=ddyndo.remote-notifier-router)

Alternatively, you can also download latest version from the extension's
[GitHub project page](https://github.com/RippeR37/remote-notifier/releases)
in the form of two `.vsix` files that you can install by:

1. Opening Command Palette (e.g. <kbd>F1</kbd>)
2. Choosing the `Extensions: Install from VSIX...` command and selecting the
   downloaded files

Once the extensions are installed you should be ready to trigger notifications
from your workspace scripts and tools with `code-notify` helper script! 🎉

> [!IMPORTANT]
> To use this extension in remote workspaces (e.g. via SSH) the Router helper
> extension needs to be installed on each remote workspace separately.
>
> It is recommended to watch for suggestions from the main extension and install
> the Router extension whenever prompted. Alternatively, if you've already
> installed it in your local workspace, you can also install it manually by
> navigating to the `Extensions` view, scrolling down to the
> `Remote Notifier (Router)` entry and clicking <kbd>Install in SSH: ...</kbd>
> button next to it.

### `code-notify` CLI

The easiest way to send notifications is through the **`code-notify` CLI**
convenience script.

The script should be installed automatically if it's not already present in the
workspace whenever you open a workspace with the Router extension installed.

If for some reason the convenience script is not present in your workspace you
can also request trigger its installation manually by this:

1. Open command palette (e.g. <kbd>F1</kbd>)
2. Find and choose:
   `Remote Notifier: Install code-notify command in current workspace`
3. Restart terminal, if you had it open

This will copy over the `code-notify.sh`/`code-notify.cmd` script and ensure its
on PATH. Once this is done you can trigger notifications manually or configure
your tools to call it when needed:

```bash
code-notify "Build completed"                    # message only
code-notify "Build" "Completed successfully"     # title + message
code-notify -i my_build_icon "Build" "Done"      # use custom icon key
code-notify -d system "Build" "Done"             # hint presentation as system notification
code-notify -d app "Build" "Done"                # hint presentation as VS Code toast
```

> [!NOTE]
> By default, to reduce distractions, Remote Notifier shows notifications as
> VS Code toasts when the editor has focus and system level notifications when
> it doesn't. You can configure this behavior.

> [!TIP]
> You can use this script from any context on your workspace, it doesn't have to
> be from VS Code integrated terminal! You can connect to your remote machine
> separately from VS Code instance and still use it to trigger notifications
> for your local machine.
>
> As long as the workspace is opened in VS Code, the local HTTP endpoint is open
> and VS Code will route notifications from your workspace to your local
> machine!

### Automatic configuration

This extension comes with a few options to auto-configure your favorite tools
to trigger notifications automatically (e.g. whenever they finish processing of
your prompt or require your permission to use a tool).

Currently supported tools:

- **Claude Code**
- **Codex**
- **Gemini CLI**

To automatically configure a tool simply:

1. Open Command Palette (e.g. <kbd>F1</kbd>)
2. Select
   `Remote Notifier: Auto-configure notifications in current workspace for...`
3. Select a tool you want to auto-configure

> [!IMPORTANT]
> This will configure your tool only in the current workspace. If you switch to
> a different one (e.g. different remote machine) you will have to configure it
> again.

### Triggering notifications manually

If you don't want to use provided `code-notify` script, you can simply make a
HTTP POST requests to `127.0.0.1` on a specific port.

In VS Code's integrated terminal, environment variables are set automatically:

```bash
curl -s -X POST $REMOTE_NOTIFIER_URL \
  -H "Authorization: Bearer $REMOTE_NOTIFIER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message": "Done!", "level": "information"}'
```

Outside of VS Code integrated terminal you can retrieve port and authentication
token from `~/.remote-notifier/session.json`.

### Custom icons

System notifications use a built-in icon by default. You can configure custom
icons per notification source by mapping icon keys to file paths in your
settings:

```json
{
  "remoteNotifier.iconMappings": {
    "ICON_CLAUDE_CODE": "/path/to/claude-icon.png",
    "ICON_CI": "/path/to/ci-icon.png"
  }
}
```

and then passing the icon key when sending a notification:

```bash
code-notify -i ICON_CI "CI" "Pipeline passed"
```

If the key isn't found in the mappings, the default icon will be used.

> [!CAUTION]
> Support for this feature is OS-dependent and may not work on some systems.

### Display hints

Scripts can suggest how a notification should be displayed by passing
a `display_hint`:

```bash
code-notify -d system "Deploy" "Started"    # suggest OS notification
code-notify -d app "Build" "Done"           # suggest VS Code toast
```

This is only a hint, not a guarantee. It is respected only when the
`systemNotifications` configuration is set to `auto` mode (the default), where
it overrides the focus-based routing.

In both `always` or `never` modes the hint is ignored and the user's configured
preference takes precedence.

### Troubleshooting

If you have any issues you should:

1. Verify that both extensions are installed in current workspace
2. Use `Remote Notifier: Test <...> notifications` helper commands to verify if
   one or both of the presentation systems work or not
3. Check configuration of app notifications in your system settings
4. Open `Output` panel (`View` -> `Output`), select `Remote Notifier` log
   sources and see if there are any errors there that may narrow it down

## Configuration

### Router Settings (workspace host)

| Setting                            | Default       | Description                                 |
| ---------------------------------- | ------------- | ------------------------------------------- |
| `remoteNotifier.enabled`           | `true`        | Enable/disable the notification server      |
| `remoteNotifier.port`              | `0`           | Fixed port for the server (0 = auto-assign) |
| `remoteNotifier.maxBodySize`       | `65536`       | Maximum request body size in bytes          |
| `remoteNotifier.notificationLevel` | `information` | Default level when not specified in request |
| `remoteNotifier.showTimestamp`     | `false`       | Prepend timestamp to notification messages  |

### Presenter Settings (local machine)

| Setting                                  | Default       | Description                                                                                                     |
| ---------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------- |
| `remoteNotifier.systemNotifications`     | `auto`        | `auto` (OS notification when unfocused, VS Code toast when focused), `always`, or `never`                       |
| `remoteNotifier.notificationIcon`        | `transparent` | Default icon style: `transparent` or `dark` (black background)                                                  |
| `remoteNotifier.notificationSound`       | `true`        | Play a sound when showing system-level notifications                                                            |
| `remoteNotifier.notificationSoundPath`   | `""`          | Path to a custom sound file. If empty, uses default notification cue.                                           |
| `remoteNotifier.notificationSoundPlayer` | `""`          | Optional: Command to play sound (e.g. `mpg123 ${file}`). If empty, the extension auto-detects available player. |
| `remoteNotifier.soundMappings`           | `{}`          | Map sound key names to file paths for system notifications (e.g. `{ "success": "/path/to/cheer.wav" }`)         |
| `remoteNotifier.iconMappings`            | `{}`          | Map icon key names to file paths for system notifications (e.g. `{ "claude": "/path/to/icon.png" }`)            |

## Commands

| Command                                                                   | Extension | Description                                                        |
| ------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------ |
| Remote Notifier: Test VS Code notifications                               | Main      | Triggers a in-app test notification (toast)                        |
| Remote Notifier: Test system notifications                                | Main      | Triggers a system-level test notification                          |
| Remote Notifier: Reset auto-install router extension ignored workspaces   | Main      | Resets all saved 'Do not ask me again' router installation answers |
| Remote Notifier: Auto-configure notifications in current workspace for... | Router    | Set up notification hooks for supported tools (e.g. Claude Code)   |
| Remote Notifier: Install code-notify command in current workspace         | Router    | Install the `code-notify` CLI to your PATH                         |
| Remote Notifier: Show Session Info                                        | Router    | Display URL and masked token                                       |
| Remote Notifier: Copy Notify Command                                      | Router    | Copy a curl example to clipboard                                   |
| Remote Notifier: Regenerate Token                                         | Router    | Generate a new auth token                                          |

## Security

- HTTP server binds to `127.0.0.1` only (loopback, not network-accessible)
- 256-bit random bearer token for authentication
- Session file created with `0600` permissions (Unix)
- Request body size limited to prevent memory exhaustion
- Rate limiting: max 5 notifications per 15 seconds

## Development

### Prerequisites

- Node.js 20+
- npm 10+
- VS Code 1.85+

### Setup

```bash
git clone https://github.com/ripper37/remote-notifier.git
cd remote-notifier
npm install
```

### Build

```bash
npm run format      # format code
npm run lint        # eslint
npm run build       # build all packages
npm test            # unit + integration + e2e
```

### Package

```bash
npm run package     # builds + packages .vsix for both extensions
```

Output:

- `packages/main/remote-notifier-x.y.z.vsix`
- `packages/router/remote-notifier-router-x.y.z.vsix`

### Project Structure

```
packages/
  main/       Main extension (notification display, OS notifications, Router extension installation, rate limiting)
  router/     Workspace extension (HTTP server, auth, session management, script & configs installer)
shared/       Shared TypeScript types and constants
test/e2e/     End-to-end tests (e.g. for the code-notify helper)
assets/       Extension icons
```

## License

[MIT](LICENSE)
