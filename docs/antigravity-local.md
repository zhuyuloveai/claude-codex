# Antigravity CLI → Codex App（本机）

此分支合并 `fuergaosi233/claude-codex` 的 `main` 提交
`b77103b7fa8b05c655f123df9ab1fd08e26c7a7f`（2026-10-27），保留 Chrys ACP，
增加官方 `agy acp` 后端。当前验收版本为 Antigravity CLI 1.5.11。

## 本机链路

```text
Codex App → SSH antigravity-local → codex shim → Unix socket
                                               ↓
                         桌面登录会话中的 LaunchAgent
                                               ↓
                       app-server adapter → agy acp
```

macOS 的真实验收发现：桌面会话可复用登录，SSH 会话直接启动 `agy acp` 则返回
`Authentication required`。因此由 GUI LaunchAgent 持有后端，SSH 只做 socket 转发。
不提取或复制 Google 凭据。CLI 使用其自身已缓存的登录。

SSH 使用独立密钥，authorized_keys 限制来源为 loopback，并将该密钥的命令路由至
Antigravity 环境。其他 SSH 连接仍使用原来的 Chrys 路由，普通本地 Codex 不受影响。

## 安装与更新

需要 Node.js 24+、官方 Antigravity CLI、已完成的 CLI 登录，以及启用的本机 Remote Login。

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run build
bash scripts/install-antigravity-local.sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.antigravity.codex-adapter.plist
ssh -o BatchMode=yes antigravity-local 'codex --version'
```

安装脚本会备份修改前的 `.ssh/config`、`authorized_keys` 和 `.zshenv`；已有密钥不重建。
升级时先短暂冻结已注册的 LaunchAgent，再检查 SQLite：有运行任务就恢复原进程并退出，
没有运行任务才备份数据库、保存旧 `dist` 并部署，完成后自动重启。失败退出也会恢复被冻结的进程。
不要在安装失败后额外手动运行 `launchctl kickstart -k`，否则会绕过运行任务检查。

不要把旧版 Chrys 的 `CHRYS_CODEX_COMPAT_VERSION=0.155.1` 传到新后端；新 shim
沿用上游默认 `0.163.0-alpha.10.2`。仅提高版本号不能替代协议兼容验证。

## App 中添加连接

在 Settings → Connections → SSH 添加：

| 字段 | 本机值 |
|---|---|
| Display name | Antigravity Local |
| Hostname | antigravity-local（已写入 SSH config） |
| User（如单独要求） | zhuyu |
| Port | 22 |
| Identity file | /Users/zhuyu/.ssh/antigravity_codex |

如果表单只接受 user@host，可填 `zhuyu@antigravity-local`。不要选择 Chrys 的密钥。
添加后，新建任务选择此连接，模型名称以 `Antigravity ·` 开头。

当前环境的 Computer Use 工具禁止控制 Codex App，因此连接的 UI 注册及可视验收必须由用户完成。
脚本验收覆盖 App 使用的 SSH bootstrap、Unix socket、WebSocket proxy 和 app-server JSON-RPC，
不能替代这一步 UI 验收。

## 能力及边界（2026-11-19）

### 已实现

- 真实模型目录及从低到高的思考等级；ACP 文本、思考、工具、命令／文件审批、diff、
  恢复、取消和 steering。模型 ID 带 `antigravity/`，避免 GPT-OSS 被误路由到 Codex。
- App 动态工具通过每轮独立的 Unix socket MCP 桥往返 `item/tool/call`。目录 0700、
  socket 0600；中断会取消调用并清理 relay。长工具名使用带哈希的短名，对 App 保留原名。
  App 必须实际向连接注册工具；工具不会凭空出现，旧聊天可能需要新建聊天才能获得注册。
- 目标工具 `get_goal/create_goal/update_goal` 接入现有目标预算与续跑机制。
- 同一适配器的聊天协作：list/read/start/prompt/wait/stop；写入和停止仅限该聊天创建的子聊天。
  独立聊天可以并发运行，最多并发数沿用上游设置。它不等于原生 Agent 子代理卡片。
- `request_user_input` 桥接 App 的澄清问题卡片；ACP elicitation 继续走 App 表单回调。
- stdio MCP 直传；HTTP MCP 的工具分页发现、调用、配置 headers 通过本地桥转发，调用前经过
  App 审批，支持取消。没有实现新的 OAuth 登录流程，需使用已经配置好的认证。
- 分叉／回退使用 **App 保留的历史重建独立 Antigravity 会话**，不会加载父会话。
  每轮记录回放检查点。不是隐藏模型状态的原生克隆，也不自动回滚工作区文件。
  回放上限 2 MB，超限明确报错而不是悄悄丢弃历史。
- 手动压缩：先生成摘要，再建立新会话承载摘要；两步成功后才切换会话 ID。
  失败保留原会话。自动压缩依据当前进程已收到的 ACP `usage_update.used`，在后续轮次前触发；
  未收到占用数据、服务刚重启或该 CLI 不报告时不会猜测触发。压缩不是原生隐藏状态压缩。
- 工作区记忆：适配器独立 SQLite 表中的笔记，支持 `memory_read/memory_update`、版本冲突检查、
  32 KiB 限制、App 的启用／停用与清空。功能默认仍需用户在 App 开启；不会自动合并历史聊天。
  此开关只控制适配器笔记，不会修改 Antigravity 自身的原生记忆和设置。
- `session_changes` 提供聊天已记录的逐轮文件 patch，支持 paths/turns/stat；它不是重新计算的
  当前工作区净 diff，命令产生的修改可能没有对应 patch。
- 运行中模型／思考等级更新发送 ACP config 请求，并以 CLI 实际确认或拒绝为准。
  不支持的等级明确报错。ACP plan 映射为 App 计划步骤。
- Base64 图片和 HTTP(S) URL 图片；URL 下载限制 20 MB、30 秒、图片 MIME。
  输出 schema 用 Ajv 验证 JSON 结构后再发布，不符合时失败；这不是原生 constrained decoding，
  不承诺所有 `format` 语义验证。
- App 已读／未读状态持久化，并以 revision 防止覆盖用户未见的新活动。
- 本会话允许保存在适配器内存，仍向 Antigravity 发送 `allow_once`，不写永久许可。
  明确 deny 规则优先于审批；只覆盖 ACP 向适配器询问的调用，不冒充 OS 沙箱。
- 正式 CLI `--add-dir` 支持额外工作目录。

### 平台接口仍未开放，不能假装完整等价

本机 `agy acp` 1.5.11 实际协商返回 load/resume/close/list/additionalDirectories，
图片 true、音频 false，没有原生 fork、后台任务管理或 compact capability。
因此以下仍有边界：

- 原生后台终端／子代理的完整事件、跨轮常驻、单独停止和 Codex 子代理面板；
  可用独立聊天协作代替一部分，但不声称是同一种功能。
- Codex 的 OS sandbox、网络隔离、自动审批 reviewer，以及 Claude hooks/agents 的逐项兼容。
  Antigravity 自己的工具、skills、hooks 仍由它自己的配置决定。
- 音频／实时语音、OpenAI 账户和配额、原生云任务、远程控制／passkey。
- HTTP MCP 的 OAuth 登录、全部 resources/prompts 与流式 progress。
- App 没有注入的桌面工具、插件授权和其他 host 的会话管理。
  本地 fallback 只能管理本适配器数据库中的聊天。

官方 ACP 文档：<https://antigravity.google/docs/cli/acp/>。
不能仅凭上游 Claude 后端的 capability matrix 将这些项目算成 Antigravity 支持。

### 验证

- `scripts/smoke-antigravity-tools.mjs`：真实模型调用动态工具和 goal 工具；
  `/tmp/agy-tools-smoke-GFoVbJ/report.json`。
- `scripts/smoke-antigravity-features.mjs`：真实 app-server 动态工具往返、同后端 thread_list、
  分叉隔离、回退不记得被删除内容、压缩后恢复、已读状态；
  `/tmp/agy-features-smoke-Nroopg/report.json`。
- `scripts/smoke-antigravity-ssh.mjs`：已部署服务真实 SSH、2 次审批、文件 diff、取消；
  `/tmp/agy-ssh-smoke-QkmI8S/report.json`。
- `scripts/smoke-antigravity-ssh-tools.mjs`：已部署服务的 SSH 动态工具反向调用；
  `/tmp/agy-ssh-smoke-a8r5PP/tool-report.json`。
- 最终全量回归 846 项通过，0 失败；build/typecheck/check 均通过（check 仍有现有及新增的非阻断提示）。
- fixture 测试覆盖 MCP 错误／取消／权限、HTTP headers、长工具名、回放、压缩、运行中设置、
  schema、URL 图片、记忆版本隔离、已读冲突及升级拒绝运行任务。
- 当前环境禁止通过电脑操作工具控制 Codex App。协议和真实模型验收不能替代每个 UI 面板的
  人工验收；没有声称全量 App GUI 已通过。

## 本机路径

| 用途 | 路径 |
|---|---|
| 适配器发布目录 | `~/.local/share/antigravity-codex-adapter` |
| shim / SSH 路由 / 环境 | `~/.local/antigravity-codex/` |
| 独立 CODEX_HOME | `~/.antigravity-codex/` |
| 数据库和模型目录 | `~/.antigravity-codex/adapter/` |
| 服务日志 | `~/.antigravity-codex/launch-agent.log` |
| LaunchAgent | `~/Library/LaunchAgents/ai.antigravity.codex-adapter.plist` |

## 验证

```bash
npm run typecheck
npm run check
TMPDIR=/tmp npm test
CODEX_REAL=/path/to/official/codex npm run check:rust-protocol-fixtures
cargo test --workspace
TMPDIR=/tmp npm run smoke:antigravity
node scripts/smoke-antigravity-ssh.mjs
TMPDIR=/tmp CHRYS_CODEX_EXECUTABLE="$HOME/.local/bin/chrys" npm run smoke:chrys
```

`smoke:antigravity` 在临时 Git 工作区验证两轮对话、适配器重启后的上下文记忆、审批、文件修改和 diff。
SSH smoke 验证已部署的真实后端，测试任务成功后归档。报告留在脚本打印的临时目录。
macOS 使用 `TMPDIR=/tmp` 可避免上游两项错误信息断言因系统临时路径过长而失败。

本机 2026-11-18 验收：

- 全量 831 项测试通过；之后补充辅助任务模型路由回归，相关 43 项通过；最终 ACP/当前 App 回归 10 项通过。
- Chrys 真实三轮 smoke 通过。
- Antigravity stdio smoke：9 个模型组、重启恢复记忆、审批、文件与 diff 均通过。
- Antigravity SSH smoke：9 个模型组、审批、文件、diff、按 ID 读取历史条目和真实任务中断均通过。
- Rust workspace 的 3 项测试通过。
- Rust 协议 fixture 与本机官方 CLI `0.169.0-alpha.11.1` 匹配。
- App GUI 注册/展示验收仍待用户完成。

## 停止服务

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/ai.antigravity.codex-adapter.plist
```

这只停止 Antigravity 后端。完整撤销时移除 SSH config 与 `.zshenv` 中标记为
`antigravity codex` 的区块和对应 authorized_keys 行；不要覆盖此后新增的其他配置。
旧 Chrys 发布目录和连接保持原样。
