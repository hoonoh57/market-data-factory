#!/usr/bin/env python
from __future__ import annotations

import argparse
import csv
import os
import struct
import sys
import time
from datetime import date, datetime
from pathlib import Path
from typing import Any

MEMBERSHIP_FIELDS = ("snapshot_date", "theme_code", "theme_name", "code", "name")


class CollectorError(RuntimeError):
    pass


def parse_day(value: str) -> date:
    return datetime.strptime(str(value).strip(), "%Y-%m-%d").date()


def clean_text(value: Any) -> str:
    return str(value or "").strip()


def clean_code(value: Any) -> str:
    text = clean_text(value).upper()
    return text[1:] if len(text) == 7 and text.startswith("A") and text[1:].isdigit() else text


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    with temp.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=MEMBERSHIP_FIELDS, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
    os.replace(temp, path)


class CybosThemeSnapshot:
    """Collect current theme membership only.

    CpSvr8561 / CpSvr8561T expose current theme definitions and membership but
    have no historical-date input. The caller therefore supplies snapshot_date
    only as the observation date; it is never sent to CYBOS as a history query.
    """

    def __init__(self, max_attempts: int = 3) -> None:
        if struct.calcsize("P") * 8 != 32:
            raise CollectorError("CYBOS theme collector must run under 32-bit Python.")
        try:
            import win32com.client  # type: ignore
        except Exception as exc:
            raise CollectorError("pywin32 is required in the 32-bit Python environment.") from exc
        self.win32 = win32com.client
        self.status = self.win32.Dispatch("CpUtil.CpCybos")
        self.max_attempts = max(1, int(max_attempts))
        if int(self.status.IsConnect) == 0:
            raise CollectorError("CYBOS Plus is not connected.")

    def wait_quote_slot(self) -> None:
        try:
            remain = int(self.status.GetLimitRemainCount(1))
        except Exception:
            return
        if remain > 1:
            return
        wait_ms = max(100, int(getattr(self.status, "LimitRequestRemainTime", 1000)))
        time.sleep(wait_ms / 1000.0 + 0.05)

    def _block_request(self, obj, label: str) -> None:
        last_error: Exception | None = None
        for attempt in range(1, self.max_attempts + 1):
            try:
                self.wait_quote_slot()
                obj.BlockRequest()
                status = int(obj.GetDibStatus())
                message = clean_text(obj.GetDibMsg1())
                if status != 0:
                    raise CollectorError(f"{label} status={status} message={message}")
                return
            except Exception as exc:
                last_error = exc
                if attempt < self.max_attempts:
                    time.sleep(min(3.0, 0.4 * (2 ** (attempt - 1))))
        raise CollectorError(f"{label} failed after {self.max_attempts} attempts: {last_error}")

    def themes(self) -> list[tuple[int, str]]:
        obj = self.win32.Dispatch("CpDib.CpSvr8561")
        self._block_request(obj, "CpSvr8561")
        count = int(obj.GetHeaderValue(0))
        result: list[tuple[int, str]] = []
        seen: set[int] = set()
        for index in range(count):
            theme_code = int(obj.GetDataValue(0, index))
            theme_name = clean_text(obj.GetDataValue(2, index))
            if theme_code in seen:
                raise CollectorError(f"duplicate theme code: {theme_code}")
            seen.add(theme_code)
            result.append((theme_code, theme_name))
        return result

    def members(self, theme_code: int) -> list[tuple[str, str]]:
        obj = self.win32.Dispatch("CpDib.CpSvr8561T")
        obj.SetInputValue(0, int(theme_code))
        result: list[tuple[str, str]] = []
        seen: set[str] = set()
        previous_signature: tuple[int, str, str] | None = None
        while True:
            self._block_request(obj, f"CpSvr8561T:{theme_code}")
            count = int(obj.GetHeaderValue(1))
            page: list[tuple[str, str]] = []
            for index in range(count):
                code = clean_code(obj.GetDataValue(0, index))
                name = clean_text(obj.GetDataValue(1, index))
                if not code:
                    continue
                page.append((code, name))
            signature = (count, page[0][0] if page else "", page[-1][0] if page else "")
            can_continue = bool(obj.Continue)
            if can_continue and count == 0:
                raise CollectorError(f"PAGINATION_EMPTY_CONTINUE:{theme_code}")
            if can_continue and signature == previous_signature:
                raise CollectorError(f"PAGINATION_STALLED:{theme_code}")
            previous_signature = signature
            for code, name in page:
                if code in seen:
                    continue
                seen.add(code)
                result.append((code, name))
            if not can_continue:
                break
        return result

    def collect(self, snapshot_date: date) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        themes = self.themes()
        for theme_code, theme_name in themes:
            for code, name in self.members(theme_code):
                rows.append({
                    "snapshot_date": snapshot_date.isoformat(),
                    "theme_code": theme_code,
                    "theme_name": theme_name,
                    "code": code,
                    "name": name,
                })
        rows.sort(key=lambda row: (int(row["theme_code"]), str(row["code"])))
        return rows


def main() -> int:
    parser = argparse.ArgumentParser(description="Collect current CYBOS theme membership as a point-in-time snapshot.")
    parser.add_argument("--snapshot-date", default=date.today().isoformat())
    parser.add_argument("--output", required=True)
    parser.add_argument("--max-attempts", type=int, default=3)
    args = parser.parse_args()

    snapshot_date = parse_day(args.snapshot_date)
    collector = CybosThemeSnapshot(args.max_attempts)
    rows = collector.collect(snapshot_date)
    if not rows:
        raise CollectorError("CYBOS returned no theme membership rows")
    output = Path(args.output).resolve()
    write_csv(output, rows)
    themes = len({int(row["theme_code"]) for row in rows})
    stocks = len({str(row["code"]) for row in rows})
    print(
        f"[PASS] CYBOS theme PIT snapshot date={snapshot_date.isoformat()} "
        f"themes={themes} uniqueStocks={stocks} memberships={len(rows)} output={output}"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"[FAIL] {type(exc).__name__}: {exc}", file=sys.stderr)
        raise SystemExit(1)
