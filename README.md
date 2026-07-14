# Remote Notifier Codex

[简体中文](#简体中文) | [English](#english)

<p align="center">
  <img src="https://raw.githubusercontent.com/ripper37/remote-notifier/master/assets/example_notification.png" height="146" alt="Remote Notifier notification example">
</p>

## 简体中文

> 一个面向 Codex CLI 工作流的 Remote Notifier 非官方增强分支。

> **核心使用场景：Codex 可以运行在 Remote SSH 连接的 Linux 服务器上，但“任务完成”、
> “等待回答”、“计划完成”和“等待授权”等提醒会通过 VS Code Router 回传，并显示在你正在使用的
> 本机 Windows 10/11 上。即使 VS Code 被浏览器或其他窗口遮挡，也能收到持续显示的 Windows
> 系统通知，不需要一直盯着远端终端。同时也支持完全在本机使用：Codex、Router 和通知扩展
> 都运行在同一台 Windows 电脑上，无需配置 SSH。**

### Fork 与致谢

本项目 fork 自 [ripper37/remote-notifier](https://github.com/ripper37/remote-notifier)，
当前增强工作基于上游 `v1.0.1`。项目保留了上游的 MIT 许可证、完整 Git 历史，
以及本机 Presenter + 工作区 Router 的核心架构。

特别感谢原作者 [Damian Dyńdo (@ripper37)](https://github.com/ripper37) 创建并开源
Remote Notifier。其跨本机、Remote SSH、WSL 和容器的通知路由设计，为本 fork 的
Codex 特化提供了可靠基础。

本 fork 由社区独立维护，与原作者及 OpenAI 均无隶属关系。上游项目的原始功能和
完整说明请参阅[原仓库](https://github.com/ripper37/remote-notifier)。

### 本 Fork 的 Codex 特化增强

本 fork 不修改 Codex 本体，而是在用户级安装 Hook，将需要注意的生命周期事件通过
Remote Notifier 显示为本机系统通知。

| Codex 场景        | 通知标题     | 触发条件                                    |
| ----------------- | ------------ | ------------------------------------------- |
| 普通回答结束      | `[任务完成]` | Default 模式中的 `Stop`                     |
| 等待用户回答      | `[等待回答]` | `PreToolUse(request_user_input)`            |
| Plan 模式暂时停止 | `[计划继续]` | Plan 模式停止，但尚未产生完整结构化计划     |
| 完整计划生成      | `[计划完成]` | 检测到结构化 Plan item 或 `<proposed_plan>` |
| 等待工具授权      | `[等待授权]` | `PermissionRequest`                         |

此外还增加了以下能力：

- 根据 `session_id` 从 Codex 状态数据库或 `session_index.jsonl` 读取重命名后的会话名。
- 通知正文显示主机名、会话名和回答摘要；未重命名时直接显示回答摘要。
- 可配置摘要长度，默认截取前 16 个可见字符，并正确处理中文和组合字符。
- 从 transcript 中识别结构化计划，避免把完整计划误判成普通任务完成。
- Codex 事件按 session、turn 和事件类型去重，不受通用突发通知限流影响。
- Hook 最多运行 3 秒；任何通知失败都以成功状态退出，不阻塞 Codex，也不改变授权结果。
- Windows 上使用原生 reminder 场景，通知会保留到用户点击或关闭为止。
- 点击通知可以唤回并聚焦 VS Code。
- 主扩展和 Router 使用独立扩展 ID，避免被 Marketplace 上游版本自动覆盖。
- Hook 仅执行本地脚本和本地路由，不增加模型上下文，也不消耗额外模型 token。

### 当前状态

- Windows 10/11 本机工作流已经完成自动化测试和手动验证。
- 通知点击目前会唤回 VS Code，但尚不会精确选中产生通知的既有集成终端。
- 精确终端跳转已列入后续计划，并且不会通过创建新对话来实现。
- Remote SSH 沿用上游 Router 架构，目前应视为实验性能力，仍需完成多窗口人工验证。

### 工作原理

Remote Notifier Codex 包含两个 VS Code 扩展和一个轻量 Hook：

```text
Codex CLI
  -> ~/.local/bin/codex-attention-hook
  -> 工作区侧 Remote Notifier Codex Router
  -> 本机侧 Remote Notifier Codex
  -> Windows 系统通知
```

- **Remote Notifier Codex**：UI 扩展，在本机显示 VS Code 或系统通知。
- **Remote Notifier Codex (Router)**：工作区扩展，在本地或远端接收 Hook 请求并路由通知。
- **codex-attention-hook**：Python helper，读取 Codex Hook JSON、解析会话信息并发送通知。

上游提供的 `code-notify` CLI、HTTP 通知接口、图标映射、自定义声音以及
Claude Code/Gemini CLI 自动配置仍然保留。

### 环境要求

- Windows 10/11 用于本机系统通知。
- VS Code `1.85.0` 或更高版本。
- Node.js 20+ 与 npm 10+，仅在参与项目开发时需要。
- Codex CLI `0.144.3` 或更高版本。
- Remote SSH 场景中的远端 Linux 需要 Python 3。

### 用户安装

本项目是 **VS Code 扩展**，不是 npm 命令行包。目前尚未发布到 VS Code Marketplace，
因此其他用户应安装构建好的 VSIX，而不是执行 `npm install`：

1. 从本仓库的 [GitHub Releases](https://github.com/Kirito-Elucidator/codex-remote-notifier/releases)
   下载同一版本中的两个文件：
   - `remote-notifier-codex-*.vsix`
   - `remote-notifier-codex-router-*.vsix`
2. 在 VS Code 命令面板中执行 `Extensions: Install from VSIX...`，依次安装两个文件。
3. 执行 `Developer: Reload Window`。

也可以在 Windows 终端中安装本地 VSIX。请先进入两个 VSIX 文件所在的下载目录，
再运行以下命令：

```powershell
code --install-extension .\remote-notifier-codex-1.0.2.vsix
code --install-extension .\remote-notifier-codex-router-1.0.8.vsix
```

安装位置取决于使用场景：

| 场景       | Remote Notifier Codex（Presenter） | Codex Router                    |
| ---------- | ---------------------------------- | ------------------------------- |
| 纯本机使用 | 安装在 `Local`                     | 安装在 `Local`                  |
| Remote SSH | 安装在本机 Windows 的 `Local`      | 安装在 `SSH: <服务器名>` 的远端 |

Remote SSH 场景下，Router 和 Hook 在服务器侧接收 Codex 事件；Presenter 留在本机 Windows，
负责显示系统通知。两端缺少任意一个扩展都无法完成服务器到 Windows 的通知链路。

### 配置 Codex 通知

1. 执行 `Remote Notifier: Auto-configure notifications in current workspace for...`。
2. 选择 `Codex`。
3. Codex 首次检测到新 Hook 时，核对命令路径后进行一次信任审核。

Router 会把 helper 安装到：

```text
~/.local/bin/codex-attention-hook
```

并在 `$CODEX_HOME/hooks.json` 中幂等添加 `Stop`、`PreToolUse` 和
`PermissionRequest` Hook。默认 `CODEX_HOME` 为 `~/.codex`。

### 通知正文

已重命名的会话：

```text
主机名 · 会话名 · 回答前 16 个可见字符
```

未重命名的会话：

```text
主机名 · 回答前 16 个可见字符
```

### 主要设置

| 设置                                          | 默认值   | 说明                                   |
| --------------------------------------------- | -------- | -------------------------------------- |
| `remoteNotifier.systemNotifications`          | `always` | Codex 增强构建默认始终使用系统通知     |
| `remoteNotifier.codexPersistentNotifications` | `true`   | Windows Codex 通知持续显示到点击或关闭 |
| `remoteNotifier.codexPreviewLength`           | `16`     | 会话名和回答摘要的最大可见字符数       |
| `remoteNotifier.notificationSound`            | `true`   | 是否播放系统通知声音                   |
| `remoteNotifier.notificationSoundPath`        | `""`     | 可选的自定义声音路径                   |
| `remoteNotifier.iconMappings`                 | `{}`     | 将通知图标键映射到本地图片路径         |

### 常用命令

| 命令                                                                        | 用途                                  |
| --------------------------------------------------------------------------- | ------------------------------------- |
| `Remote Notifier: Auto-configure notifications in current workspace for...` | 安装或更新 Codex Hook                 |
| `Remote Notifier: Remove Codex notification hooks`                          | 干净移除本 fork 管理的 Hook 和 helper |
| `Remote Notifier: Test system notifications`                                | 测试系统通知                          |
| `Remote Notifier: Test VS Code notifications`                               | 测试 VS Code 内通知                   |
| `Remote Notifier: Show Session Info`                                        | 查看 Router 地址和脱敏 token          |

### 通用通知功能

仍可使用上游的 `code-notify` 命令发送任意通知：

```bash
code-notify "Build completed"
code-notify "Build" "Completed successfully"
code-notify -i ICON_CI -d system "CI" "Pipeline passed"
```

Router 只监听 `127.0.0.1`，使用随机 bearer token 验证请求。会话信息保存在
`~/.remote-notifier/session.json`，不会经过外部通知服务。

### 开发与验证

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run package
```

当前测试基线为 214 项通过、1 项跳过。

### 许可证

本项目遵循 [MIT License](LICENSE)。再次感谢
[ripper37/remote-notifier](https://github.com/ripper37/remote-notifier) 原作者及贡献者的工作。

---

## English

> An unofficial Remote Notifier fork specialized for Codex CLI workflows.

> **Primary use case: Codex may run on a Linux server through VS Code Remote
> SSH, while task-completed, answer-needed, plan-completed, and permission
> notifications are routed back to the local Windows 10/11 desktop. Persistent
> Windows notifications remain visible even when a browser or another window
> covers VS Code, so the remote terminal does not require constant attention.
> The extension also supports a fully local setup, with Codex, the Router, and
> notifications all running on the same Windows machine without SSH.**

### Fork and Acknowledgements

This project is forked from
[ripper37/remote-notifier](https://github.com/ripper37/remote-notifier), with the
current enhancements based on upstream `v1.0.1`. It preserves the upstream MIT
license, complete Git history, and the local Presenter + workspace Router
architecture.

Special thanks to
[Damian Dyńdo (@ripper37)](https://github.com/ripper37) for creating and
open-sourcing Remote Notifier. Its routing design across local workspaces,
Remote SSH, WSL, and containers provides the foundation for the Codex-specific
features in this fork.

This is an independently maintained community fork and is not affiliated with
the upstream author or OpenAI. See the
[upstream repository](https://github.com/ripper37/remote-notifier) for the
original project and documentation.

### Codex-Specific Features Added by This Fork

This fork does not modify Codex. It installs user-level hooks that route
attention-worthy lifecycle events through Remote Notifier.

| Codex scenario                   | Notification | Trigger                                            |
| -------------------------------- | ------------ | -------------------------------------------------- |
| Normal response completed        | `[任务完成]` | `Stop` in Default mode                             |
| Waiting for an answer            | `[等待回答]` | `PreToolUse(request_user_input)`                   |
| Plan paused without a final plan | `[计划继续]` | `Stop` in Plan mode without a structured plan      |
| Complete plan produced           | `[计划完成]` | Structured Plan item or `<proposed_plan>` detected |
| Waiting for tool permission      | `[等待授权]` | `PermissionRequest`                                |

Additional enhancements include:

- Resolving renamed Codex sessions from the state database or
  `session_index.jsonl` using `session_id`.
- Showing the host, renamed session, and final-answer preview in each
  notification, with a direct answer preview for unnamed sessions.
- Configurable Unicode-aware preview truncation, defaulting to 16 visible
  characters.
- Transcript-based structured Plan detection.
- Deduplication by session, turn, and event without the generic burst limit.
- A three-second hook timeout with fail-open behavior so notification failures
  never block Codex or affect permission decisions.
- Persistent Windows reminder notifications that remain until opened or
  dismissed.
- Notification clicks that restore and focus VS Code.
- Independent extension IDs that cannot be overwritten by the Marketplace
  versions.
- Local-only hook processing with no additional model context or token usage.

### Current Status

- The Windows 10/11 local workflow has automated coverage and manual testing.
- Notification clicks currently focus VS Code but do not yet select the exact
  existing integrated terminal that produced the event.
- Exact terminal navigation is planned and will not create a new conversation.
- Remote SSH retains the upstream Router architecture but remains experimental
  until multi-window manual validation is complete.

### Architecture

```text
Codex CLI
  -> ~/.local/bin/codex-attention-hook
  -> Remote Notifier Codex Router in the workspace
  -> Remote Notifier Codex on the local UI side
  -> Windows system notification
```

- **Remote Notifier Codex** is the local UI extension that presents VS Code or
  operating-system notifications.
- **Remote Notifier Codex (Router)** runs with the workspace, locally or
  remotely, and routes hook requests.
- **codex-attention-hook** is a Python helper that parses Codex hook JSON,
  resolves session metadata, and sends the notification.

The upstream `code-notify` CLI, HTTP endpoint, icon mappings, custom sounds,
and Claude Code/Gemini CLI auto-configuration remain available.

### Requirements

- Windows 10/11 for local system notifications.
- VS Code 1.85.0 or later.
- Node.js 20+ and npm 10+ only for project development.
- Codex CLI 0.144.3 or later.
- Python 3 on a remote Linux host when using Remote SSH.

### User Installation

This project contains **VS Code extensions**, not npm command-line packages.
It has not yet been published to the VS Code Marketplace, so users should
install built VSIX packages rather than run `npm install`:

1. Download both files from the same entry under
   [GitHub Releases](https://github.com/Kirito-Elucidator/codex-remote-notifier/releases):
   - `remote-notifier-codex-*.vsix`
   - `remote-notifier-codex-router-*.vsix`
2. Run `Extensions: Install from VSIX...` in VS Code for each file.
3. Run `Developer: Reload Window`.

The local VSIX files can also be installed from a Windows terminal. First,
change to the download directory containing both VSIX files, then run:

```powershell
code --install-extension .\remote-notifier-codex-1.0.2.vsix
code --install-extension .\remote-notifier-codex-router-1.0.8.vsix
```

Install each extension in the appropriate location:

| Scenario   | Remote Notifier Codex (Presenter) | Codex Router                |
| ---------- | --------------------------------- | --------------------------- |
| Local only | Install under `Local`             | Install under `Local`       |
| Remote SSH | Install under Windows `Local`     | Install under `SSH: <host>` |

With Remote SSH, the Router and hook receive Codex events on the server, while
the Presenter remains on the Windows machine and displays the system
notification. Both sides are required for the server-to-Windows path.

### Configure Codex Notifications

1. Run `Remote Notifier: Auto-configure notifications in current workspace for...`.
2. Select `Codex`.
3. Review and trust the hook once when Codex first detects it.

The Router installs the helper at:

```text
~/.local/bin/codex-attention-hook
```

It idempotently adds `Stop`, `PreToolUse`, and `PermissionRequest` hooks to
`$CODEX_HOME/hooks.json`. `CODEX_HOME` defaults to `~/.codex`.

### Notification Body

Renamed session:

```text
host · session name · first 16 visible characters of the answer
```

Unnamed session:

```text
host · first 16 visible characters of the answer
```

### Main Settings

| Setting                                       | Default  | Description                                                        |
| --------------------------------------------- | -------- | ------------------------------------------------------------------ |
| `remoteNotifier.systemNotifications`          | `always` | Always use system notifications in this enhanced build             |
| `remoteNotifier.codexPersistentNotifications` | `true`   | Keep Windows Codex notifications visible until opened or dismissed |
| `remoteNotifier.codexPreviewLength`           | `16`     | Maximum visible characters for session names and answer previews   |
| `remoteNotifier.notificationSound`            | `true`   | Play the system notification sound                                 |
| `remoteNotifier.notificationSoundPath`        | `""`     | Optional custom sound path                                         |
| `remoteNotifier.iconMappings`                 | `{}`     | Map notification icon keys to local image paths                    |

### Commands

| Command                                                                     | Purpose                                        |
| --------------------------------------------------------------------------- | ---------------------------------------------- |
| `Remote Notifier: Auto-configure notifications in current workspace for...` | Install or update Codex hooks                  |
| `Remote Notifier: Remove Codex notification hooks`                          | Remove hooks and the helper owned by this fork |
| `Remote Notifier: Test system notifications`                                | Test operating-system notifications            |
| `Remote Notifier: Test VS Code notifications`                               | Test in-app notifications                      |
| `Remote Notifier: Show Session Info`                                        | Show the Router URL and masked token           |

### Generic Notifications

The upstream `code-notify` command remains available:

```bash
code-notify "Build completed"
code-notify "Build" "Completed successfully"
code-notify -i ICON_CI -d system "CI" "Pipeline passed"
```

The Router binds only to `127.0.0.1` and authenticates requests with a random
bearer token. Session information remains in `~/.remote-notifier/session.json`
and is not sent through an external notification service.

### Development and Verification

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run package
```

The current test baseline is 214 passing and 1 skipped.

### License

This project is distributed under the [MIT License](LICENSE). Thanks again to
the authors and contributors of
[ripper37/remote-notifier](https://github.com/ripper37/remote-notifier).
