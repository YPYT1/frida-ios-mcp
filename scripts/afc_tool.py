#!/usr/bin/env python3
"""AFC side channel for frida-ios-mcp (no fleetcontrol dependency).

Requires: pip install pymobiledevice3

Subcommands print a single JSON object to stdout:
  push           — upload local file to /DCIM/100APPLE/{IMG|VID}_XXXX.ext
  list-untrashed — pull Photos.sqlite(+wal+shm) and list untrashed image/video
  rm-dcim        — delete media files under /DCIM/100APPLE (upload sources only)
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sqlite3
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

AFC_BASE = "/var/mobile/Media"
DCIM_DIR = "/DCIM/100APPLE"
PHOTOS_DB_REMOTE = "PhotoData/Photos.sqlite"
VIDEO_EXT = {".mp4", ".mov", ".m4v"}
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".gif"}
MEDIA_EXT = VIDEO_EXT | IMAGE_EXT

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
        t = threading.Thread(target=loop.run_forever, daemon=True, name="afc-bg")
        t.start()
        _bg_loop = loop
        return loop


def _run(coro: Any) -> Any:
    fut = asyncio.run_coroutine_threadsafe(coro, _get_bg_loop())
    return fut.result()


def fail(stage: str, message: str, **extra: Any) -> None:
    out = {"ok": False, "stage": stage, "error": message, **extra}
    print(json.dumps(out, ensure_ascii=False))
    sys.exit(2)


def ok(**payload: Any) -> None:
    print(json.dumps({"ok": True, **payload}, ensure_ascii=False))


def _import_afc():
    try:
        from pymobiledevice3.lockdown import create_using_usbmux
        from pymobiledevice3.services.afc import AfcService
    except ImportError as e:
        fail(
            "afc",
            f"pymobiledevice3 not installed in {sys.executable}: {e}",
            recovery=[
                "pip install pymobiledevice3  (into the same interpreter)",
                "set FRIDA_MCP_PYTHON to a Python that has pymobiledevice3",
                "Windows example: set FRIDA_MCP_PYTHON=C:\\Users\\You\\AppData\\Local\\Programs\\Python\\Python312\\python.exe",
            ],
            python=sys.executable,
        )
    return create_using_usbmux, AfcService


def cmd_preflight(_args: argparse.Namespace) -> None:
    """Fast env check only — no USB. Exit 0/2 within milliseconds if import fails."""
    try:
        import pymobiledevice3  # noqa: F401
    except ImportError as e:
        fail(
            "afc",
            f"pymobiledevice3 not installed in {sys.executable}: {e}",
            recovery=[
                "pip install pymobiledevice3  (into the same interpreter)",
                "set FRIDA_MCP_PYTHON to a Python that has pymobiledevice3",
                "Windows example: set FRIDA_MCP_PYTHON=C:\\Users\\You\\AppData\\Local\\Programs\\Python\\Python312\\python.exe",
            ],
            python=sys.executable,
        )
    ok(preflight=True, python=sys.executable, pymobiledevice3=True)


async def _with_afc(udid: str, fn):
    create_using_usbmux, AfcService = _import_afc()
    lockdown = await create_using_usbmux(serial=udid.lower())
    try:
        async with AfcService(lockdown) as afc:
            return await fn(afc)
    finally:
        close = getattr(lockdown, "close", None)
        if callable(close):
            try:
                await close()
            except Exception:
                pass


def remote_name(local: Path, media_type: str) -> str:
    prefix = "VID" if media_type == "video" else "IMG"
    digits = "".join(c for c in f"{time.time():.0f}" if c.isdigit())
    seq = int(digits[-4:]) if len(digits) >= 4 else int(time.time()) % 10000
    return f"{DCIM_DIR}/{prefix}_{seq:04d}{local.suffix}"


def cmd_push(args: argparse.Namespace) -> None:
    source = Path(args.local).expanduser().resolve()
    media_type = args.media_type.strip().lower()
    if not source.is_file():
        fail("upload", f"local file not found: {source}")
    if media_type not in ("video", "image"):
        fail("upload", f"mediaType must be image|video, got {media_type}")
    suf = source.suffix.lower()
    if suf not in MEDIA_EXT:
        fail("upload", f"unsupported extension: {suf or '<none>'}")
    if media_type == "video" and suf not in VIDEO_EXT:
        fail("upload", f"video type but extension is {suf}")
    if media_type == "image" and suf not in IMAGE_EXT:
        fail("upload", f"image type but extension is {suf}")

    remote_path = remote_name(source, media_type)
    size = source.stat().st_size

    async def do(afc):
        await afc.makedirs(DCIM_DIR)
        await afc.push(str(source), remote_path)

    try:
        _run(_with_afc(args.udid, do))
    except SystemExit:
        raise
    except Exception as e:
        fail("upload", f"AFC push failed: {type(e).__name__}: {e}")

    ok(
        remotePath=remote_path,
        devicePath=AFC_BASE + remote_path,
        sizeBytes=size,
        mediaType=media_type,
        localPath=str(source),
        udid=args.udid.lower(),
    )


def _query_untrashed(db_path: Path) -> list[dict[str, Any]]:
    # Aligned with fleetcontrol IOSPhotoImportService._query_untrashed_media_assets
    # ZKIND: 0=photo, 1/2=video-ish; keep filename OR as fallback.
    sql = """
        select ZUUID, ZFILENAME, ZDIRECTORY, Z_PK, ZKIND
        from ZASSET
        where ifnull(ZTRASHEDSTATE, 0) = 0
          and ZUUID is not null
          and (
            ZKIND in (0, 1, 2)
            or upper(ifnull(ZFILENAME, '')) like '%.MP4'
            or upper(ifnull(ZFILENAME, '')) like '%.MOV'
            or upper(ifnull(ZFILENAME, '')) like '%.M4V'
            or upper(ifnull(ZFILENAME, '')) like '%.JPG'
            or upper(ifnull(ZFILENAME, '')) like '%.JPEG'
            or upper(ifnull(ZFILENAME, '')) like '%.PNG'
            or upper(ifnull(ZFILENAME, '')) like '%.HEIC'
            or upper(ifnull(ZFILENAME, '')) like '%.HEIF'
            or upper(ifnull(ZFILENAME, '')) like '%.GIF'
          )
        order by ZDATECREATED asc, Z_PK asc
    """
    conn = sqlite3.connect(str(db_path))
    try:
        rows = conn.execute(sql).fetchall()
    finally:
        conn.close()
    assets = []
    for zuuid, filename, directory, pk, zkind in rows:
        name = (filename or "").upper()
        # fleetcontrol: ZKIND in (1, 2) OR video extensions → video
        is_video = (
            zkind in (1, 2)
            or name.endswith(".MP4")
            or name.endswith(".MOV")
            or name.endswith(".M4V")
        )
        assets.append(
            {
                "uuid": zuuid,
                "localIdentifier": f"{zuuid}/L0/001",
                "filename": filename,
                "directory": directory,
                "pk": pk,
                "mediaType": "video" if is_video else "image",
                "zkind": zkind,
            }
        )
    return assets


def cmd_list_untrashed(args: argparse.Namespace) -> None:
    with tempfile.TemporaryDirectory(prefix="frida_mcp_photos_") as tmp:
        db_path = Path(tmp) / "Photos.sqlite"

        async def do(afc):
            for suffix in ("", "-wal", "-shm"):
                remote = f"{PHOTOS_DB_REMOTE}{suffix}"
                local = f"{db_path}{suffix}"
                try:
                    await afc.pull(remote, local, progress_bar=False)
                except Exception:
                    if suffix == "":
                        raise

        try:
            _run(_with_afc(args.udid, do))
        except SystemExit:
            raise
        except Exception as e:
            fail("afc", f"pull Photos.sqlite failed: {type(e).__name__}: {e}")

        try:
            assets = _query_untrashed(db_path)
        except Exception as e:
            fail("verify", f"sqlite query failed: {type(e).__name__}: {e}")

    ok(
        udid=args.udid.lower(),
        count=len(assets),
        assets=assets,
        note="Untrashed only (ZTRASHEDSTATE=0). Recently Deleted not listed.",
    )


def cmd_rm_dcim(args: argparse.Namespace) -> None:
    deleted: list[str] = []

    async def do(afc):
        try:
            entries = await afc.listdir(DCIM_DIR)
        except Exception:
            return
        for name in entries:
            if Path(name).suffix.lower() not in MEDIA_EXT:
                continue
            path = f"{DCIM_DIR}/{name}"
            try:
                await afc.rm(path)
                deleted.append(path)
            except Exception:
                pass

    try:
        _run(_with_afc(args.udid, do))
    except SystemExit:
        raise
    except Exception as e:
        fail("afc", f"rm DCIM failed: {type(e).__name__}: {e}")

    ok(udid=args.udid.lower(), deleted=deleted, deletedCount=len(deleted))


def main() -> None:
    p = argparse.ArgumentParser(description="frida-ios-mcp AFC helper")
    sub = p.add_subparsers(dest="cmd", required=True)

    pf = sub.add_parser("preflight", help="Check pymobiledevice3 import only (no USB)")
    pf.set_defaults(func=cmd_preflight)

    sp = sub.add_parser("push")
    sp.add_argument("--udid", required=True)
    sp.add_argument("--local", required=True)
    sp.add_argument("--media-type", required=True, choices=["image", "video"])
    sp.set_defaults(func=cmd_push)

    sl = sub.add_parser("list-untrashed")
    sl.add_argument("--udid", required=True)
    sl.set_defaults(func=cmd_list_untrashed)

    sr = sub.add_parser("rm-dcim")
    sr.add_argument("--udid", required=True)
    sr.set_defaults(func=cmd_rm_dcim)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
