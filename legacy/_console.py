#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""控制台输出的编码安全网。

**为什么需要这个文件**：Windows 中文版的控制台代码页是 cp936（GBK）。
脚本输出**被重定向或走管道**时（`python x.py > log.txt`、
`subprocess.run(capture_output=True)`），Python 不再走 WriteConsoleW，
而是按 cp936 编码 —— 这时 print 一个 GBK 里没有的字符（`✓` `✗` `⚠` `✅` …）
会直接抛 `UnicodeEncodeError`，**把整段输出打断**。

实测：`doctor.py` 用 subprocess 捕获 `zcode_patcher.py` 的输出时，
汇总表在 `✓ 用量页去截断补丁` 那一行崩掉，用户看到的是半张表 + traceback，
还会误以为是补丁本身失败。交互式控制台走 WriteConsoleW，所以这个坑**只在管道里露头**。

两条防线：
  * `safe_stdio()` —— 把 stdout/stderr 设成「编不出的字符替换掉」，**永不崩**；
  * `ok_mark()` / `bad_mark()` / `glyph()` —— 先问编码能不能表示，不能就换 ASCII 备选，
    输出依然可读（`√`/`×` 在 cp936 里是有的，所以中文 Windows 上本来就能正常显示）。
"""

from __future__ import annotations

import os
import sys

#: cp936 里没有、但项目里用到的符号 → ASCII 备选
_ASCII_FALLBACK = {
    "✓": "v", "✗": "x", "⚠": "!", "✅": "+", "❌": "x",
    "↻": "~", "↺": "~", "▾": "v", "⧗": "~", "▬": "-",
    "⇔": "<=>", "✦": "*", "◌": "o", "✕": "x",
}


def safe_stdio() -> None:
    """让 stdout/stderr 永远不会因编码问题抛异常。幂等，可重复调用。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except Exception:
            pass


def _encodable(ch: str) -> bool:
    enc = getattr(sys.stdout, "encoding", None) or "ascii"
    try:
        ch.encode(enc)
    except (UnicodeEncodeError, LookupError):
        return False
    return True


def glyph(uni: str, ascii_alt: str | None = None) -> str:
    """返回当前 stdout 编得出来的符号；编不出来就用 ASCII 备选。"""
    if _encodable(uni):
        return uni
    if ascii_alt is not None:
        return ascii_alt
    return _ASCII_FALLBACK.get(uni, "?")


def ok_mark() -> str:
    """成功标记（cp936 可编码，中文 Windows 上能正常显示）。"""
    return glyph("√", "v")


def bad_mark() -> str:
    """失败标记。"""
    return glyph("×", "x")


def warn_mark() -> str:
    """警示标记（⚠ 在 cp936 里没有，会自动降级成 `!`）。"""
    return glyph("⚠", "!")


#: Windows: 不为子进程分配控制台（也就不会弹出窗口）
CREATE_NO_WINDOW = 0x08000000


def no_window_kwargs() -> dict:
    """返回「别弹控制台窗口」的 Popen/run 参数；非 Windows 返回空 dict。

    **为什么必须有**：本插件的 SessionStart 钩子用 `--detach` 把 sync.py 拉成
    `DETACHED_PROCESS | CREATE_NO_WINDOW` 的后台 worker —— 也就是**没有控制台**。
    Windows 的语义是：**无控制台的父进程创建 console 子进程时，系统会新建一个控制台并显示出来**。
    于是 worker 里每一次 `subprocess.run([python, zcode_patcher.py, …])` 都会闪出一个 cmd 窗口；
    而 `run_sync()` 会为每个开关调一次 `check_state()` —— 一个会话能弹 8 个以上。

    实测（本机，探针 EnumWindows 统计可见控制台窗口）：无控制台父进程
      * 不传 creationflags → 期间出现 **2 个**可见控制台窗口
      * 传 CREATE_NO_WINDOW → **0 个**
    注意 `capture_output=True` **挡不住**这个窗口：它管的是管道，不是控制台分配。
    """
    if os.name != "nt":
        return {}
    return {"creationflags": CREATE_NO_WINDOW}
