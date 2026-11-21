# dsh-qqbot 接入细节

## 架构

```
QQ 用户 ──私聊──▶ QQ 客户端 ──▶ OneBot 实现（NapCat）
                                   │ 反向 WebSocket（本插件监听）
                                   ▼
                          dsh-qqbot (Host 插件)
                            ├─ 白名单校验
                            ├─ 指令解析（/help /status /reset /stop /allow /deny）
                            ├─ ctx.agents.create/resume ──▶ DSH Agent（会话 qqbot_<QQ>）
                            ├─ session/event 收集 assistant 文本 ──▶ send_private_msg
                            ├─ approval/request ──▶ 转发 QQ 等待批准
                            └─ qq_send_file 工具 ──▶ upload_private_file
```

## 配置项

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `host` | `127.0.0.1` | 监听地址 |
| `port` | `6700` | 反向 WS 端口 |
| `accessToken` | 空 | OneBot token；填了必须匹配 |
| `owners` | `[]` | 有权限的 QQ 号 |
| `extraAllowed` | `[]` | 额外允许的 QQ 号（同权，谨慎） |
| `workspace` | 空 | bot 工作目录，空则用 DSH 进程 cwd |
| `permissionMode` | `standard` | `safe` / `standard` / `full` |
| `allowShell` | `true` | 是否允许 bash/pwsh |
| `allowDesktop` | `true` | 是否允许桌面操作 |
| `allowBrowser` | `true` | 是否允许浏览器工具 |
| `allowFileSend` | `true` | 是否注册 `qq_send_file` |
| `sendRoots` | `[]` | 额外允许发送的目录 |
| `approvalForward` | `true` | 危险操作是否转发 QQ 审批 |
| `approvalTimeoutSec` | `180` | 审批超时秒数 |
| `maxReplyChars` | `1800` | 单条回复上限 |
| `systemPromptExtra` | 空 | 追加系统提示词 |

## 权限如何真正生效

1. **沙箱**：`setSandboxMode(agent.session, mode)` 写一条 `sandbox/mode` 事件，
   之后的文件 / 命令调用按该模式执行（`read-only` / `workspace-write` /
   `danger-full-access`）。`workspace-write` 的边界是 bot 会话的 cwd（即
   `workspace`）。
2. **审批**：`ctx.approval.setPolicy(agent, 'ask' | 'never')`。`ask` 时每次危险工具
   调用走 `approval/request` waterfall；本插件监听后转发到 QQ，等待 `/allow` 或
   `/deny`，超时按 `rejected`。`never` 时 DSH 直接拒绝，不产生审批请求。
3. **工具面**：`agent.ctx.tools.restrict({ deny })` 只隐藏**全局工具**中真实存在的
   名字（不存在的名字会被 DSH 拒绝，所以先 `tools.get(name, agent)` 过滤）。插件
   自己注册的 `qq_send_file` 不受 restrict 影响，由 `allowFileSend` 决定是否注册。
4. **文件发送**：`resolveSendPath` 把相对路径解析到 `workspace`，并校验最终路径位于
   `workspace` 或 `sendRoots` 之内；越界直接抛错。

## 会话与上下文

- 会话 id 固定为 `qqbot_<QQ号>`，每个号独立。
- 插件重启后会先 `agents.resume({ resumeSessionId })`，失败才 `create`，所以上下文
  尽量保留。
- `/reset` 会 `dispose()` 当前会话（删除会话记录），下一次消息重新 `create`。

## 常见问题

**插件日志显示 listening，但 NapCat 连不上**

- 端口被占用：换一个 `port`
- NapCat 里填的是正向 WS 而不是反向 WS
- 填了 `accessToken` 但 NapCat 没带 token（或相反）

**bot 不回消息**

- `owners` 没填或填错（必须是字符串数组）
- 插件被禁用；或插件加载报错（看 DSH 日志里的 `[qqbot]`）
- 当前 agent 正在跑长任务，回复会在 `turn/end` 后统一发送

**权限改了没生效**

- 改配置会重启插件；已存在的旧会话权限不会热更新。发 `/reset` 或重启 DSH 后重新
  创建会话即可。

**发送文件失败**

- 文件必须在 `workspace` 或 `sendRoots` 内
- 超过 100MB 会被拒绝（QQ 侧限制更严格）
- OneBot 实现的 `upload_private_file` 需要文件路径对 NapCat 可见；同机运行没问题

## 后续扩展

- OneBot v11 HTTP webhook / 正向 WS 适配器
- 群聊（@机器人）支持
- 多用户分级（owner / 只读访客）
- 把 `permissionMode` 做成客户端自定义设置页（目前用插件 Config 表单）
