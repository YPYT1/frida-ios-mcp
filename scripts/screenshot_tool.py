#!/usr/bin/env python3
"""Device screenshot via pymobiledevice3 ScreenshotService (lockdown — not Accessibility / Frida).

Subcommands print one JSON line to stdout:
  preflight — import check only (no USB)
  take      — capture screen; returns base64 JPEG (or PNG if Pillow missing)
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import io
import json
import sys
import threading
from typing import Any

_bg_loop: asyncio.AbstractEventLoop | None = None
_bg_lock = threading.Lock()


def _get_bg_loop() -> asyncio.AbstractEventLoop:
    global _bg_loop
    if _bg_loop is not None and _bg_loop.is_running():
        return _bg_loop
    with _bg_lock:
        if _bg_loop is not None and _bg_loop.is_running():
            return _bg_loop
        loop = asyncio.new_event_loop()
        t = threading.Thread(target=loop.run_forever, daemon=True, name="shot-bg")
        t.start()
        _bg_loop = loop
        return loop


def _run(coro: Any) -> Any:
    fut = asyncio.run_coroutine_threadsafe(coro, _get_bg_loop())
    return fut.result()


def fail(stage: str, message: str, **extra: Any) -> None:
    print(json.dumps({"ok": False, "stage": stage, "error": message, **extra}, ensure_ascii=False))
    sys.exit(2)


def ok(**payload: Any) -> None:
    print(json.dumps({"ok": True, **payload}, ensure_ascii=False))


def _pymobile_recovery() -> list[str]:
    return [
        "pip install pymobiledevice3  (into the same interpreter)",
        "set FRIDA_MCP_PYTHON to a Python that has pymobiledevice3",
        "Windows example: set FRIDA_MCP_PYTHON=C:\\Users\\You\\AppData\\Local\\Programs\\Python\\Python312\\python.exe",
        "Developer image may need mounting for ScreenshotService",
    ]


def cmd_preflight(_args: argparse.Namespace) -> None:
    try:
        import pymobiledevice3  # noqa: F401
    except ImportError as e:
        fail(
            "screenshot",
            f"pymobiledevice3 not installed in {sys.executable}: {e}",
            recovery=_pymobile_recovery(),
            python=sys.executable,
        )
    ok(preflight=True, python=sys.executable, pymobiledevice3=True)


def _compress(raw: bytes, quality: int) -> tuple[bytes, str]:
    try:
        from PIL import Image

        image = Image.open(io.BytesIO(raw))
        # Downscale very large frames to keep MCP payloads sane
        max_edge = 1280
        w, h = image.size
        scale = min(1.0, max_edge / max(w, h))
        if scale < 1.0:
            image = image.resize((int(w * scale), int(h * scale)))
        buf = io.BytesIO()
        image.convert("RGB").save(buf, format="JPEG", quality=quality)
        return buf.getvalue(), "image/jpeg"
    except Exception:
        # Raw from ScreenshotService is typically PNG
        mime = "image/png" if raw[:8] == b"\x89PNG\r\n\x1a\n" else "application/octet-stream"
        return raw, mime


async def _take(udid: str | None, quality: int) -> dict[str, Any]:
    from pymobiledevice3.lockdown import create_using_usbmux
    from pymobiledevice3.services.screenshot import ScreenshotService

    kwargs: dict[str, Any] = {}
    if udid:
        kwargs["serial"] = udid.lower()
    lockdown = await create_using_usbmux(**kwargs)
    try:
        async with ScreenshotService(lockdown) as svc:
            raw = await svc.take_screenshot()
    finally:
        close = getattr(lockdown, "close", None)
        if callable(close):
            try:
                await close()
            except Exception:
                pass

    data, mime = _compress(raw, quality)
    return {
        "mimeType": mime,
        "bytes": len(data),
        "base64": base64.b64encode(data).decode("ascii"),
        "note": "Pixel assist via lockdown ScreenshotService — not Accessibility. Prefer screen_snapshot for tap refs.",
    }


def cmd_take(args: argparse.Namespace) -> None:
    try:
        payload = _run(_take(args.udid, args.quality))
    except Exception as e:
        fail(
            "screenshot",
            str(e),
            recovery=_pymobile_recovery()
            + [
                "unlock device",
                "mount developer image if ScreenshotService unavailable",
            ],
        )
    ok(**payload)


def main() -> None:
    p = argparse.ArgumentParser(description="frida-mcp device screenshot")
    sub = p.add_subparsers(dest="cmd", required=True)

    pre = sub.add_parser("preflight")
    pre.set_defaults(func=cmd_preflight)

    take = sub.add_parser("take")
    take.add_argument("--udid", default=None)
    take.add_argument("--quality", type=int, default=70)
    take.set_defaults(func=cmd_take)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
