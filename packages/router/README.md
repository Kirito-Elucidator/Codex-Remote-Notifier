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
For Codex 0.145+, it installs a private transparent shim for newly created
integrated terminals. Supported `codex`, `codex resume`, and `codex fork`
invocations run a same-lifetime sidecar that forwards app-server
JSONL/WebSocket traffic unchanged and extracts only a notification whitelist.
An in-TUI `/resume` picker gets an isolated temporary app-server connection, so
it remains available while the active chat stays connected. Unsupported
invocations and Codex 0.144.3 fail open to lightweight attention hooks. Run the
auto-configure command and select Codex; the fallback helper is installed at
`~/.local/bin/codex-attention-hook`. Use
`Remote Notifier: Remove Codex notification configuration` to remove the hooks,
helper, and shim PATH injection owned by this extension. Completed
turn notifications show the renamed session when available, otherwise they
show the answer preview.

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

The sidecar and Hook helper use the authenticated `/codex/events` endpoint. The
Router validates a minimal `CodexProtocolEvent | CodexHookEvent` and returns
`202 Accepted` immediately. Protocol state handling, bounded transcript-tail
fallback parsing, terminal mapping, and Windows notification presentation then
continue asynchronously. The helper has an internal deadline of about 1.35
seconds and never reads transcripts, indexes, or SQLite.

Exact monitoring emits notifications for completed turns, structured plans,
off-to-on safety buffering, every distinct input/approval/MCP request id, and
every official error occurrence, including retryable errors. Later occurrences
with identical text notify again. Only transport replay of the same occurrence
id and a final turn confirmation with no new visible error are collapsed.
Protocol sessions are authoritative, so corresponding Hook presentation is
ignored instead of double-presented; transcript monitoring remains available
as a terminal-error fallback.

Terminal errors are classified from the structured `codexErrorInfo` value,
forwarded HTTP status, and a bounded set of standard fallback messages. This
covers quota, context, authentication, transport/DNS/TLS/proxy failures, model
service failures, unsupported models, invalid requests/configuration, output
length, session recovery, state conflicts, and sandbox/policy failures. Provider
JSON envelopes are reduced to their nested message and status, and credential
shapes are redacted before presentation.

Hook Stop fallback polls the bounded transcript tail for up to about 0.75
seconds after the endpoint has already returned `202`, preventing a
late-persisted terminal error from being reported as completion. Codex does not
invoke Stop hooks for every terminal failure, so `UserPromptSubmit` also starts
an event-driven transcript append monitor that parses only structured
`task_complete.error` records. During a Router reload, the sidecar retains its
sanitized event queue and allows up to five seconds for final delivery before
shutdown.

On Windows, the generated shim prefers the real `node.exe` available to the
integrated terminal. It does not launch the Codex TUI through VS Code's
Electron host, preserving ConPTY/TTY handles and avoiding
`stdin is not a terminal`.

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
code --install-extension .\remote-notifier-codex-1.0.5.vsix --force
code --remote ssh-remote+YOUR_SSH_HOST --install-extension `
  .\remote-notifier-codex-router-1.0.22.vsix --force
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
