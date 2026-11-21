import aiohttp

from astrbot.api.event import filter, AstrMessageEvent
from astrbot.api.star import Context, Star, register

# -----------------------------------------------------------------------------
# 配置：改这里，然后在 AstrBot 里重载本插件
# -----------------------------------------------------------------------------
DSH_BRIDGE_URL = "http://127.0.0.1:6700/bridge"  # DSH 插件的 HTTP 桥
DSH_TOKEN = ""          # 若 DSH 设置页填了 Access Token，这里填同一个；留空表示仅本机
OWNER_QQ = "2770377405"      # 只有这个 QQ 的私聊会被转发，留空表示不限制
PREFIX = "!dsh"         # 可选的后备指令前缀；正常模式下不用它
ROUTER_PROMPT = (
    "你是路由器。判断用户这句话是否要求在这台电脑上动手做事——"
    "例如查看磁盘/内存/CPU、读写文件、执行命令、开关程序、截图、下载、安装、"
    "整理桌面、发送文件等。只是聊天、提问、要建议、写作、翻译、情感交流，都不算。\n"
    "只回答一个词：YES 或 NO。"
)
INSTRUCT = (
    "【重要】这台 Windows 电脑上的实际操作，全部由 dsh_computer 工具代你执行。"
    "你拥有本机的完整权限：查看磁盘、读写文件、执行命令、开关程序、截图、发文件、操作浏览器，"
    "都可以直接调用 dsh_computer 完成，不需要任何额外授权。"
    "当用户提出本机操作需求时，必须立即调用 dsh_computer（task 写清楚目标、路径和期望结果），"
    "不要回答“被拦住”“没有权限”，不要要求用户去设置里打开任何开关，也不要编造执行结果。"
    "工具返回结果后，用你自己的口吻把结果告诉用户。"
)

# 这些内置工具会和 dsh_computer 抢活干，也会让模型误以为自己没有权限；每次请求前从工具集里摘掉。
_COMPETING_TOOL_KEYWORDS = (
    "shell",
    "exec",
    "file",
    "screen",
    "computer",
    "desktop",
    "process",
)


def _strip_competing_tools(req) -> None:
    toolset = getattr(req, "func_tool", None)
    tools = getattr(toolset, "tools", None) if toolset is not None else None
    if not tools:
        return
    drop = []
    for tool in list(tools):
        name = getattr(tool, "name", "") or ""
        if name == "dsh_computer":
            continue
        low = name.lower()
        if low.startswith("astrbot_") and any(k in low for k in _COMPETING_TOOL_KEYWORDS):
            drop.append(name)
    for name in drop:
        try:
            toolset.remove_tool(name)
        except Exception:
            pass


async def call_dsh(user_id: str, text: str) -> str:
    payload = {"user_id": user_id, "text": text}
    if DSH_TOKEN:
        payload["token"] = DSH_TOKEN
    timeout = aiohttp.ClientTimeout(total=620)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.post(DSH_BRIDGE_URL, json=payload) as resp:
            data = await resp.json(content_type=None)
    if not data.get("ok"):
        return "DSH 拒绝了这次请求：" + str(data.get("error") or data)
    replies = data.get("replies") or []
    if not replies:
        return "（这一轮 DSH 没有返回文字）"
    return "\n".join(replies)


@register("dsh_bridge", "Aurora", "把电脑操作交给本机 DSH 执行（函数调用，无需前缀）", "0.2.0")
class DshBridge(Star):
    def __init__(self, context: Context):
        super().__init__(context)

    async def _allowed(self, event: AstrMessageEvent) -> bool:
        if not OWNER_QQ:
            return True
        return str(event.get_sender_id()) == OWNER_QQ

    @filter.on_llm_request()
    async def inject_instruction(self, event: AstrMessageEvent, req):
        """把“可以用 DSH 操作电脑”写进系统提示，并摘掉会抢活的内置工具。"""
        try:
            req.system_prompt += "\n\n" + INSTRUCT
        except Exception:
            pass
        try:
            _strip_competing_tools(req)
        except Exception:
            pass

    @filter.llm_tool(name="dsh_computer")
    async def dsh_computer(self, event: AstrMessageEvent, task: str):
        """把需要在这台电脑上执行的任务交给 DSH 电脑助手执行。

        Args:
            task(string): 要在这台电脑上完成的事情，写清楚目标、路径和期望结果。
        """
        if not await self._allowed(event):
            return "你没有指挥这台电脑的权限。"
        try:
            result = await call_dsh(str(event.get_sender_id()), task)
        except Exception as exc:
            return "连不上 DSH：" + str(exc)
        return result[:8000]

    async def _needs_hands(self, event: AstrMessageEvent) -> bool:
        """让当前对话模型先判断题：这句话要不要动电脑。

        用一个独立的、纯文本的小请求来判断，不依赖模型的函数调用能力
        （有些中转 provider 不会透传 tools 字段）。
        """
        text = (event.message_str or "").strip()
        if not text:
            return False
        try:
            provider = self.context.get_using_provider(event.unified_msg_origin)
        except Exception:
            provider = None
        if provider is None:
            return False
        prompt = ROUTER_PROMPT + "\n\n用户这句话：" + text
        try:
            resp = await provider.text_chat(
                prompt=prompt,
                session_id=event.unified_msg_origin,
            )
            answer = (resp.completion_text or "").strip().lower()
        except Exception:
            return False
        return answer.startswith("yes") or answer.startswith("是")

    @filter.event_message_type(filter.EventMessageType.PRIVATE_MESSAGE)
    async def on_private_message(self, event: AstrMessageEvent):
        """!dsh 前缀直接转发；其余私聊先让模型判断要不要动手。"""
        text = (event.message_str or "").strip()

        if text.lower().startswith(PREFIX):
            if not await self._allowed(event):
                event.stop_event()
                yield event.plain_result("你没有指挥这台电脑的权限。")
                return
            prompt = text[len(PREFIX):].strip() or "你好"
            event.stop_event()
            try:
                result = await call_dsh(str(event.get_sender_id()), prompt)
            except Exception as exc:
                yield event.plain_result("连不上 DSH：" + str(exc))
                return
            yield event.plain_result(result)
            return

        # 不用指令：由模型判断“这件事要不要动手”
        if not await self._allowed(event):
            return
        if not await self._needs_hands(event):
            return
        event.stop_event()
        try:
            result = await call_dsh(str(event.get_sender_id()), text)
        except Exception as exc:
            yield event.plain_result("连不上 DSH：" + str(exc))
            return
        yield event.plain_result(result)
