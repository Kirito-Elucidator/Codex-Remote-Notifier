# Remote Notifier Codex (Router)

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

## Remote Notifier (Router)

This is the Router component of the unofficial Codex-focused fork of
[ripper37/remote-notifier v1.0.1](https://github.com/ripper37/remote-notifier/tree/v1.0.1).
It installs attention hooks for task completion,
questions, ongoing or completed plans, and permission requests. Run the
auto-configure command and select Codex; the helper is installed at
`~/.local/bin/codex-attention-hook`. Use
`Remote Notifier: Remove Codex notification hooks` to remove only the hooks and
helper owned by this extension. Completed-turn notifications show both the
renamed session and answer preview when both are available.

For Codex notifications, the Router also matches the hook process ancestry to
the VS Code terminal process and stores a `session_id` mapping. Clicking the
Windows notification routes the activation back to the originating VS Code
window and invokes a unique command registered by that Router instance. This
reveals the existing terminal without starting a new conversation or selecting
a different workspace's Router in multi-window setups.

**The notification is therefore an actionable return path, not just a status
message:** the local and Remote SSH workflows both bring the originating VS
Code window forward and focus the existing terminal for that Codex session.
This path has been validated end to end against a live Linux Remote SSH host.

Each Router writes a workspace-scoped discovery record under
`~/.remote-notifier/sessions/`. Existing terminals whose inherited port became
stale after a window reload can therefore select the Router whose workspace
contains the hook `cwd`. The legacy `~/.remote-notifier/session.json` record is
still written for compatibility with earlier helpers.

This is a helper extension ("router") for the enhanced main extension built
from the same source tree. It needs to be installed in a given workspace to
allow scripts and tools to trigger notifications from within that workspace.
Triggered notifications are passed to the main extension for presentation via
system or in-app notifications.

Codex hooks use the authenticated `/notify/async` endpoint. The Router returns
`202 Accepted` after validating and queueing the payload, while terminal mapping
and Windows notification presentation continue without consuming the hook's
three-second timeout.

This extension can be installed manually, but the main extension will also
prompt user to install it whenever new workspace is opened which doesn't have it
installed yet (either local or remote).

### Platform Support

All major platforms (Windows 10+, macOS and Linux) are support.

On Windows, a `code-notify.cmd` script is installed automatically and added to
your PATH to allow triggering notifications.

On Linux/macOS, a `code-notify` bash script is installed automatically and added
to your PATH to allow triggering notifications from that workspace.

## How To Use

From the VSIX download directory in Windows PowerShell, the quickest Remote SSH
installation is:

```powershell
code --install-extension .\remote-notifier-codex-1.0.4.vsix --force
code --remote ssh-remote+YOUR_SSH_HOST --install-extension `
  .\remote-notifier-codex-router-1.0.10.vsix --force
```

Replace `YOUR_SSH_HOST` with the `Host` alias from the Windows SSH config. Then
open the Remote SSH window, press `Ctrl+Shift+P`, run
`Developer: Reload Window`, and create a new terminal.

Alternatively, press `Ctrl+Shift+P` and run `Extensions: Install from VSIX...`:

1. Install the main `remote-notifier-codex` VSIX under `Local`.
2. Install this Router VSIX in the intended `Local` or `SSH: <host>` workspace.
3. Run `Developer: Reload Window` and wait for Remote SSH to reconnect.
4. Run `Terminal: Create New Terminal` before starting Codex or `code-notify`.
5. Run `Remote Notifier: Auto-configure notifications in current workspace for...`
   and select `Codex` when Codex lifecycle notifications are required.

The original releases remain available on the
[upstream GitHub project](https://github.com/ripper37/remote-notifier/releases).
This fork uses independent extension IDs and must be packaged separately.

> [!IMPORTANT]
> To use Remote Notifier extension in remote workspaces (e.g. via SSH) you need
> to install this Router extension on each remote workspace separately.

Once installed, both extensions will always start automatically.

### More

Find more information by navigating to the
[Remote Notifier extension page](https://marketplace.visualstudio.com/items?itemName=ddyndo.remote-notifier).

## License

[MIT](LICENSE)
