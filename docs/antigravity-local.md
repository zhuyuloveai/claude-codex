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
升级会保存旧 `dist`，保留数据库。服务已注册时，部署完成且无任务运行后使用：

```bash
launchctl kickstart -k gui/$(id -u)/ai.antigravity.codex-adapter
```

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

## 能力及边界

- 支持真实模型目录、模型/思考等级设置、文本/思考流、工具调用、命令与文件审批、文件 diff、
  session/load 跨进程恢复、取消；ACP steering 有协议测试覆盖。
- 模型 ID 在 Codex 侧使用 `antigravity/` 前缀，避免 GPT-OSS 被上游误路由到原生 Codex。
  不伪装客户端身份。当前账号实际返回 9 个模型组；真实推理验收使用 Gemini 3.8 Flash，
  其他模型的可用性仍由 Antigravity 服务决定。
- App 标题/辅助任务携带 OpenAI 模型名时仍保留 Antigravity 后端。
- App `thread/items/read` 按当前随附 CLI 协议返回持久化条目；已读状态延续上游的
  `method not found` 降级行为，不假装已经持久化已读标记。
- `allow for session` 至多映射一次允许，不把临时审批变成 Antigravity 永久规则。
- history fork/rewind 暂不支持；明确报错，避免误用父会话而污染历史。
- 仅转换 stdio MCP 配置；HTTP MCP、Codex 专属动态工具/goal/后台子任务协议未完成桥接。
- Antigravity 的 mode/permission 行为不等价于完整 Codex sandbox。Plan 选择映射到 ACP plan mode。
  不使用 `--dangerously-skip-permissions`。

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
