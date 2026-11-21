import re

import aiohttp

from astrbot.api.event import filter, AstrMessageEvent
from astrbot.api.star import Context, Star, register

# -----------------------------------------------------------------------------
# 配置：改这里，然后在 AstrBot 里重载本插件
# -----------------------------------------------------------------------------
DSH_BRIDGE_URL = "http://127.0.0.1:6700/bridge"  # DSH 插件的 HTTP 桥
DSH_TOKEN = ""          # 若 DSH 设置页填了 Access Token，这里填同一个；留空表示仅本机
OWNER_QQ = "2770377405"      # 只有这个 QQ 的私聊会被转发，留空表示不限制
PREFIX = "!dsh"         # 手动兜底前缀，任何时候都能用

# 直接命中这些词的私聊，立刻交给 DSH，不再额外问一次模型（零延迟）。
OG_RE = re.compile(
    r"磁盘|硬盘|d盘|c盘|e盘|f盘|g盘|空间|容量|占用|内存|cpu|处理器|进程|任务管理器|"
    r"文件|文件夹|目录|桌面|截图|屏幕|窗口|"
    r"打开|启动|关闭|运行|执行|安装|卸载|下载|上传|"
    r"命令|终端|powershell|cmd|端口|网络|服务|"
    r"清理|删除|移动|复制|重命名|压缩|解压|"
    r"发我|发给我|传我|保存|写入|读取|"
    r"电脑.*(状态|配置|情况)|电池|电量",
    re.IGNORECASE,
)

MARKER = "[[DSH]]"

INSTRUCT = (
    "【重要】这台 Windows 电脑上的实际操作由 DSH 代你执行。"
    "判断规则：如果这个问题你能凭常识、知识或聊天直接回答（聊天、写作、翻译、建议、情感交流、常识问答），"
    "就正常回答，不要调用任何电脑工具；"
    "如果必须看这台电脑的真实情况或改动它（磁盘/内存/CPU、文件、命令、程序、截图、下载、发送文件），"
    "就只输出一行：[[DSH]]要执行的任务（写清目标、路径和期望结果），不要输出别的字。"
    "插件会把这一行替换成真实执行结果。不要回答“被拦住”“没有权限”，不要要求用户去设置里打开开关，也不要编造结果。"
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
        if low.startswith("astrbot_") and any(
            k in low for k in ("shell", "exec", "file", "screen", "computer", "desktop", "process")
        ):
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


@register("dsh_bridge", "Aurora", "把电脑操作交给本机 DSH 执行（按需动手，不用前缀）", "0.3.0")
class DshBridge(Star):
    def __init__(self, context: Context):
        super().__init__(context)

    async def _allowed(self, event: AstrMessageEvent) -> bool:
        if not OWNER_QQ:
            return True
        return str(event.get_sender_id()) == OWNER_QQ

    @filter.on_llm_request()
    async def inject_instruction(self, event: AstrMessageEvent, req):
        """把判断规则写进系统提示，并摘掉会抢活的内置工具。"""
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
            return (await call_dsh(str(event.get_sender_id()), task))[:8000]
        except Exception as exc:
            return "连不上 DSH：" + str(exc)

    @filter.on_llm_response()
    async def after_llm(self, event: AstrMessageEvent, resp):
        """模型自己判断“要动手”时会输出 [[DSH]]任务；这里替换成真实执行结果。

        没有额外请求：判断和回答是同一次模型调用。
        """
        text = getattr(resp, "completion_text", "") or ""
        idx = text.find(MARKER)
        if idx == -1:
            return
        if not await self._allowed(event):
            resp.completion_text = "你没有指挥这台电脑的权限。"
            return
        task = text[idx + len(MARKER):].strip()
        if not task:
            resp.completion_text = ""
            return
        try:
            resp.completion_text = await call_dsh(str(event.get_sender_id()), task)
        except Exception as exc:
            resp.completion_text = "连不上 DSH：" + str(exc)

    @filter.event_message_type(filter.EventMessageType.PRIVATE_MESSAGE)
    async def on_private_message(self, event: AstrMessageEvent):
        """!dsh 前缀直接转发；命中干活词直接转发；其余交给 AstrBot 正常聊天。"""
        text = (event.message_str or "").strip()
        if not await self._allowed(event):
            return

        if text.lower().startswith(PREFIX):
            prompt = text[len(PREFIX):].strip() or "你好"
            event.stop_event()
            try:
                yield event.plain_result(await call_dsh(str(event.get_sender_id()), prompt))
            except Exception as exc:
                yield event.plain_result("连不上 DSH：" + str(exc))
            return

        if OG_RE.search(text):
            event.stop_event()
            try:
                yield event.plain_result(await call_dsh(str(event.get_sender_id()), text))
            except Exception as exc:
                yield event.plain_result("连不上 DSH：" + str(exc))
