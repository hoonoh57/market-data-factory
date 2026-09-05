"""Stable 64-bit Python/UI API for Korean equity daily and minute bars."""
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
from pathlib import Path
from threading import Event
from typing import Any, Callable, Literal

BarType = Literal["daily", "minute", "market_cap", "market_index"]
UpdateMode = Literal["full", "incremental"]
ProgressCallback = Callable[[dict[str, Any]], None]
ROOT = Path(__file__).resolve().parent


class MarketDataError(RuntimeError):
    pass


def _stop_process(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return
    try:
        if os.name == "nt":
            os.kill(process.pid, signal.CTRL_BREAK_EVENT)
        else:
            process.terminate()
        process.wait(timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        process.kill()


def _run(
    args: list[str],
    progress_callback: ProgressCallback | None = None,
    cancel_event: Event | None = None,
) -> dict[str, Any]:
    data_type = args[args.index("--type") + 1]
    action = args[args.index("--command") + 1]
    if data_type in ("daily", "minute"):
        command = ["node", str(ROOT / "scripts" / "update-korean-equity-bars.mjs"), *args]
    elif data_type == "market_cap":
        forwarded = [item for i, item in enumerate(args) if item != "--type" and (i == 0 or args[i - 1] != "--type")]
        command = ["node", str(ROOT / "scripts" / "update-korean-equity-market-cap.mjs"), *forwarded]
    elif data_type == "market_index":
        if action == "status":
            command = ["node", str(ROOT / "scripts" / "check-korean-market-index.mjs")]
        else:
            command = ["node", str(ROOT / "scripts" / "update-korean-market-index.mjs"), "--skip-daily-refresh"]
            for flag in ("--mode", "--start", "--end"):
                if flag in args:
                    command.extend([flag, args[args.index(flag) + 1]])
    else:
        raise ValueError(f"unsupported data_type: {data_type}")
    creationflags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
    child_env = os.environ.copy()
    child_env.setdefault("MARKET_DATA_PYTHON64", sys.executable)
    child_env["PYTHONUTF8"] = "1"
    child_env["PYTHONIOENCODING"] = "utf-8"
    process = subprocess.Popen(
        command,
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
        creationflags=creationflags,
        env=child_env,
    )
    last_event: dict[str, Any] = {}
    assert process.stdout is not None
    for raw_line in process.stdout:
        if cancel_event and cancel_event.is_set():
            _stop_process(process)
            raise MarketDataError("사용자가 업데이트를 중지했습니다.")
        line = raw_line.rstrip()
        if line:
            print(line, flush=True)
        if not line.startswith("BAR_EVENT "):
            if progress_callback and line:
                progress_callback({"event": "log", "type": data_type, "message": line})
            continue
        try:
            event = json.loads(line[len("BAR_EVENT "):])
        except json.JSONDecodeError:
            continue
        last_event = event
        if progress_callback:
            progress_callback(event)
        if cancel_event and cancel_event.is_set():
            _stop_process(process)
            raise MarketDataError("사용자가 업데이트를 중지했습니다.")
    return_code = process.wait()
    if return_code:
        raise MarketDataError(last_event.get("message", f"bar updater exited with code {return_code}"))
    if last_event:
        return last_event
    final_event = {
        "event": "status" if action == "status" else "complete",
        "type": data_type,
        "command": action,
        "message": "상태 확인 완료" if action == "status" else "업데이트 완료",
    }
    if progress_callback:
        progress_callback(final_event)
    return final_event


def update_bars(
    data_type: BarType,
    mode: UpdateMode = "incremental",
    start_date: str | None = None,
    end_date: str | None = None,
    progress_callback: ProgressCallback | None = None,
    cancel_event: Event | None = None,
    *,
    dry_run: bool = False,
) -> dict[str, Any]:
    """Download and upsert all EQUITY instruments in market_instrument.

    full: start_date..end_date is downloaded again and upserted without deleting rows.
    incremental: each instrument continues after its own latest stored trading date.
    """
    if data_type not in ("daily", "minute", "market_cap", "market_index"):
        raise ValueError("unsupported data_type")
    if mode not in ("full", "incremental"):
        raise ValueError("mode must be 'full' or 'incremental'")
    if mode == "full" and not start_date:
        raise ValueError("start_date is required for full mode")
    args = ["--command", "update", "--type", data_type, "--mode", mode]
    if start_date:
        args.extend(["--start", start_date])
    if end_date:
        args.extend(["--end", end_date])
    if dry_run:
        args.append("--dry-run")
        if data_type in ("market_cap", "market_index"):
            event = {"event": "plan", "type": data_type, "mode": mode, "start": start_date, "end": end_date, "dryRun": True}
            if progress_callback:
                progress_callback(event)
            return event
    return _run(args, progress_callback, cancel_event)


update_data = update_bars


def get_status(data_type: BarType, progress_callback: ProgressCallback | None = None) -> dict[str, Any]:
    """Return row count, covered instruments, missing instruments, and date range."""
    if data_type not in ("daily", "minute", "market_cap", "market_index"):
        raise ValueError("unsupported data_type")
    return _run(["--command", "status", "--type", data_type], progress_callback)
