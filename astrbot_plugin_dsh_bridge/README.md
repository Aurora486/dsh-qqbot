# astrbot_plugin_dsh_bridge

把 AstrBot 的「本机操作」交给 DSH（DeepSeek Harness）执行：AstrBot 继续负责 QQ 收发和人设，DSH 负责真正在这台电脑上干活。

## 前置条件

1. 已安装并启用 `dsh-qqbot` 插件（DSH 桌面端）。
2. DSH 插件的 HTTP 桥在 `http://127.0.0.1:6700/bridge` 监听（默认开启）。
3. AstrBot 4.29+。

## 配置

打开本插件的 `main.py`，改顶部三个常量：

| 常量 | 说明 |
| --- | --- |
| `DSH_BRIDGE_URL` | DSH 桥地址，默认 `http://127.0.0.1:6700/bridge` |
| `DSH_TOKEN` | 若 DSH 设置页填了 Access Token，这里填同一个；留空表示仅本机 |
| `OWNER_QQ` | 只有这个 QQ 的私聊会被转发，留空表示不限制 |

改完在 AstrBot 插件管理里点「重载」。

## 用法

- **推荐（无前缀）**：直接对机器人说「帮我看看 D 盘还有多少空间」。模型会调用 `dsh_computer` 工具，由 DSH 执行并返回结果，AstrBot 负责回话。
- **后备（带前缀）**：消息以 `!dsh` 开头时跳过 LLM，直接转发，例如 `!dsh 看看 D 盘空间`。

插件注入的系统提示要求模型把本机操作全部交给 `dsh_computer`，并在每次请求前摘掉 AstrBot 自带的 `astrbot_execute_shell` 等电脑工具，避免两边抢活或模型误报「没有权限」。

## 故障排查

- 回复「连不上 DSH」：确认 DSH 桌面端在运行、`dsh-qqbot` 已启用、`http://127.0.0.1:6700/` 能打开。
- 回复「DSH 拒绝了这次请求」：检查 DSH 设置页的 owner 名单是否包含你的 QQ。
- 模型仍然说没有权限：确认本插件版本为 v0.2.0 及以上，并在 AstrBot 里重载。
