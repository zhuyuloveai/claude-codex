# Chrys Codex Adapter

把 Chrys ACP 二进制包装成 Codex `app-server`，供 Codex 桌面应用通过 Remote SSH 使用。
Codex App 本身无需修改，原生 `Control this Mac` 仍使用官方 Codex CLI。

```text
Codex App
├── Control this Mac ──▶ 官方 Codex CLI
└── Chrys Local (SSH) ──▶ codex shim ──▶ Chrys Codex Adapter ──▶ chrys acp
```

## 已实现能力

- Codex `initialize`、模型目录以及配置协议
- 任务创建、列表、读取、恢复、归档和持久化
- Chrys ACP `session/new`、`session/load`、`session/prompt` 和 `session/cancel`
- 文本、推理、工具调用和用量的实时事件
- 命令与文件修改审批
- Chrys `_chrys/request_input` 到 Codex 原生问题卡片
- 文件修改和 `turn/diff/updated`
- stdio、WebSocket、Unix socket 和 `app-server proxy`

## 要求

- macOS 或 Linux
- Node.js 24+
- 已安装并可运行的 Chrys 二进制
- Codex 桌面应用
- 一个用于 Chrys 的 SSH 用户。推荐独立用户，避免其 `codex` shim 影响原生 CLI。

## 构建与真实验证

```bash
npm install
npm run build
npm run smoke:chrys
```

`smoke:chrys` 会调用真实 Chrys，验证模型目录、两轮会话恢复、审批、文件创建和 diff。

## 安装到 Chrys SSH 用户

如果还没有专用用户，在 macOS **系统设置 → 用户与群组**中新建标准用户 `chrys-agent`，再到
**系统设置 → 通用 → 共享 → 远程登录**允许该用户登录。为 Codex App 创建独立密钥：

```bash
ssh-keygen -t ed25519 -f "$HOME/.ssh/chrys_codex" -C chrys-codex
ssh-copy-id -i "$HOME/.ssh/chrys_codex.pub" chrys-agent@127.0.0.1
ssh -i "$HOME/.ssh/chrys_codex" chrys-agent@127.0.0.1 'echo ssh-ok'
```

把 Chrys 二进制和本工程放到该用户可访问的位置，并确认在该用户中执行 `chrys --version`
成功。以下命令均在专用用户下执行：

```bash
cd /path/to/chrys-codex-adapter
npm install
npm run install:ssh-user
```

安装位置默认为：

```text
~/.local/share/chrys-codex-adapter/dist/src/adapter.mjs
~/bin/codex
~/.chrys-codex/
```

确保 SSH 非交互登录也能找到 `~/bin/codex` 和 Chrys。macOS 默认 shell为 zsh 时，可在该用户的
`~/.zshenv` 中设置：

```bash
export PATH="$HOME/bin:$HOME/.local/bin:$PATH"
export CHRYS_CODEX_ADAPTER="$HOME/.local/share/chrys-codex-adapter/dist/src/adapter.mjs"
export CHRYS_CODEX_EXECUTABLE="$HOME/.local/bin/chrys"
```

从另一终端验证：

```bash
ssh chrys-agent@127.0.0.1 'command -v codex; codex --version; command -v chrys'
```

期望 `codex --version` 类似：

```text
codex-cli 0.142.3 (chrys-codex)
```

## Codex App 配置

打开 **Settings → Connections → SSH → Add**：

```text
Display name: Chrys Local
Hostname: chrys-agent@127.0.0.1
SSH port: 22
Identity: Chrys 专用 SSH 密钥
```

保存后，在创建任务时选择 `Chrys Local`。原生任务继续选择 `Control this Mac`。

这个连接窗口只配置 SSH 主机和身份，不提供 Agent 或可执行文件路径。Codex App 登录后会直接执行
`codex --version` 和 `codex app-server ...`，因此适配器通过专用用户的 `PATH` 让 `~/bin/codex`
被优先找到；这也是使用独立 SSH 用户的原因。

## Shim 行为

专用用户的 `~/bin/codex` 只接管 Codex App 需要的入口：

- `codex --version`：返回兼容版本。
- `codex app-server ...`：启动本适配器，包括 `proxy` 模式。
- 其他命令：设置 `CODEX_REAL` 时转发给真实 Codex CLI，否则明确失败。

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `CHRYS_CODEX_EXECUTABLE` | `chrys` | Chrys 二进制路径 |
| `CHRYS_CODEX_AGENT` | `Code` | Chrys 主 Agent 名称 |
| `CHRYS_CODEX_HOME` | `~/.chrys-codex` | 任务数据库、socket 和日志目录 |
| `CHRYS_CODEX_ADAPTER` | 安装目录下的 `adapter.mjs` | shim 使用的适配器入口 |
| `CHRYS_CODEX_NODE` | `node` | Node.js 24+ 可执行文件 |
| `CHRYS_CODEX_COMPAT_VERSION` | `0.142.3` | shim 对 Codex App 报告的兼容版本 |
| `CODEX_REAL` | 未设置 | 非 app-server 命令的官方 Codex CLI 回退路径 |

## 开发验证

```bash
npm run typecheck
npm test
npm run smoke:chrys
```

协议兼容层派生自 MIT 许可的 `fuergaosi233/claude-codex`，具体见 `NOTICE` 和 `LICENSE`。
