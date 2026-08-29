#!/usr/bin/env python
from __future__ import annotations

import struct
import sys


def main() -> int:
    if struct.calcsize("P") * 8 != 32:
        print("[FAIL] CYBOS preflight requires 32-bit Python.", file=sys.stderr)
        return 2
    try:
        import win32com.client  # type: ignore
    except Exception as exc:
        print(f"[FAIL] pywin32 unavailable in 32-bit Python: {exc}", file=sys.stderr)
        return 3

    try:
        status = win32com.client.Dispatch("CpUtil.CpCybos")
        connected = int(status.IsConnect)
    except Exception as exc:
        print(f"[FAIL] unable to access CpUtil.CpCybos: {exc}", file=sys.stderr)
        return 4

    if connected == 0:
        print(
            "[FAIL] CYBOS Plus is not connected. Start/login to CYBOS Plus on this Windows session, "
            "confirm the connection indicator, then rerun the backfill.",
            file=sys.stderr,
        )
        return 5

    try:
        remain = int(status.GetLimitRemainCount(1))
        wait_ms = int(getattr(status, "LimitRequestRemainTime", 0))
    except Exception:
        remain = -1
        wait_ms = -1

    print(f"[PASS] CYBOS connected quote_slots={remain} wait_ms={wait_ms}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
