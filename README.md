<p align="center">
  <img src="https://img.shields.io/badge/DSH-plugin-4c8dff" alt="DSH plugin">
  <img src="https://img.shields.io/badge/OneBot-v11-2ea44f" alt="OneBot v11">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT">
</p>

# QQ 机器人 · DSH 插件

把 **DeepSeek Harness（DSH）** 接进 QQ：在 QQ 里私聊你的机器人，让它在这台电脑上真正干活——查磁盘、读写文件、跑命令、开程序、截图、把文件发回给你。

权限全部在 DSH 客户端里管：三档权限、工具开关、可写目录、可发送目录，改完即时生效。

> 插件本体是 Host 插件（Node.js），不依赖任何第三方 npm 包；WebSocket、OneBot 客户端、配置页均为自带实现。

---

## 两种接入方式

| 方式 | 谁收发 QQ | 谁干活 | 适合谁 |
| --- | --- | --- | --- |
| **direct（DSH 全管）** | 本插件（OneBot v11 反向 WS） | DSH | 只想要一个机器人 |
| **astrbot（混合）** | AstrBot（人设 / 记忆 / 聊天） | DSH | 已经有 AstrBot 机器人，舍不得她的人设 |

两种方式共用同一套权限与设置页，随时可切。

---

## 安装

### 1. 安装插件

把本目录放到任意位置，然后任选一种：

- **图形界面**：DSH → 左侧栏「插件」→ 添加插件 → 选择本目录；
- **命令**：`plugin_manager install_bundle`，目标填本目录的绝对路径。

装好后在「插件」页能看到 **QQ 机器人**，点进行上的设置按钮即可打开设置页。

### 2. 接上 QQ（direct 方式）

1. 安装 [NapCat](https://napcat.napcat.wiki/) 或 [LLOneBot](https://llonebot.com/)，登录一个**专门的小号**；
2. 在 NapCat 里添加「WebSocket 客户端」（反向 WS）：
   - 地址：`ws://127.0.0.1:6700/`
   - 消息格式：`array`（推荐）或 `string`
   - Token：填设置页里那个 token（没填就留空）
3. 保存后，设置页顶部状态条变绿即表示已连接。

### 3. 接上 QQ（astrbot 混合方式）

1. 保持现有 AstrBot 不变；
2. 把 `astrbot_plugin_dsh_bridge/` 整个目录复制到 `AstrBot/data/plugins/`，或在 AstrBot 插件页上传 zip；
3. 打开 `astrbot_plugin_dsh_bridge/main.py`，改三行：
   ```python
   DSH_BRIDGE_URL = "http://127.0.0.1:6700/bridge"
   DSH_TOKEN = ""          # 与 DSH 设置页里的 token 一致
   OWNER_QQ = "你的QQ号"
   ```
4. 在 AstrBot 里重载插件；
5. DSH 设置页把「接入方式」切到 **astrbot**。

之后私聊正常聊天由 AstrBot 回复；当 AstrBot 的模型判断「这句话要动手」时，会自动把任务交给 DSH 执行，再把结果发回 QQ。

---

## 设置页

DSH → 左侧栏「插件」→ **QQ 机器人** → 设置。

| 区块 | 内容 |
| --- | --- |
| 状态条 | 是否已连上 QQ、当前权限档、监听地址 |
| 周边程序 | 自动探测 NapCat WebUI（6099）与 AstrBot WebUI（6185），一键跳转 |
| 第 1 步 把 QQ 接过来 | 启用、端口、Token、接入方式 |
| 第 2 步 谁能指挥它 | owner QQ 白名单（只有这些号能下指令） |
| 第 3 步 它能干什么 | 权限三档、工作目录、四个工具开关、发文件目录白名单 |
| 高级 | 模型、系统提示补充、审批转发 |

### 权限三档

| 档位 | 沙箱 | 危险操作 |
| --- | --- | --- |
| 只看不动 | `read-only` | 每次询问 |
| 正常工作 | `workspace-write`（仅工作目录可写） | 每次询问 |
| 完全放开 | `danger-full-access` | 不再询问 |

选「询问」时，危险操作会转发到 owner 的 QQ：回 `/allow <编号>` 放行，回 `/deny <编号>` 拒绝，超时自动拒绝。

---

## QQ 里的指令

| 指令 | 作用 |
| --- | --- |
| `/help` | 看用法 |
| `/status` | 看当前权限、工作区、会话 |
| `/reset` | 忘掉这轮对话，重新开始 |
| `/stop` | 打断正在执行的任务 |
| `/allow <编号>` / `/deny <编号>` | 批准 / 拒绝一次危险操作 |
| `!dsh <任务>` | 不经过模型判断，直接让 DSH 执行 |

只支持私聊与文本消息；图片、语音、群聊暂不支持。

---

## 安全建议

- 用**专门的小号**，不要用主号；
- owner 白名单只放自己；
- 默认选「正常工作」，需要时再临时放开；
- 「发文件」只允许白名单目录，避免把整个磁盘发出去；
- 插件默认只监听 `127.0.0.1`，不要改成 `0.0.0.0`，除非你清楚后果。

---

## 目录结构

```
dsh-qqbot/
├── index.js                 # Host 插件：WS 服务端、OneBot、agent 桥接、设置接口
├── client.js                # 设置页（React，经 DSH 插槽渲染）
├── lib/onebot.js            # OneBot v11 客户端与消息解析
├── lib/websocket.js         # 自带 RFC6455 WebSocket 服务端
├── vendor/                  # schemastery + cosmokit（MIT，见各自 LICENSE）
├── astrbot_plugin_dsh_bridge/  # AstrBot 侧转发插件（Python）
├── docs/教程.md              # 手把手教程
└── docs/DETAIL.md           # 架构与实现细节
```

## 许可

MIT。`vendor/` 下的两个库来自 `@deepseek-ai` 生态，各自保留 MIT LICENSE。
