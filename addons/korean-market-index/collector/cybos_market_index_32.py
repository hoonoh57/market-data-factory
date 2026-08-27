#!/usr/bin/env python
from __future__ import annotations

import argparse
import csv
import os
import struct
import sys
import time
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

INDEX_CODES = ("U001", "U201")
DAILY_FIELDS = (0, 2, 3, 4, 5, 8)
MINUTE_FIELDS = (0, 1, 2, 3, 4, 5, 8)
DAILY_CSV_FIELDS = ("date", "open", "high", "low", "close", "volume")
MINUTE_CSV_FIELDS = ("timestamp", "open", "high", "low", "close", "volume")


class CollectorError(RuntimeError):
    pass


def parse_day(value: str) -> date:
    return datetime.strptime(str(value).strip(), "%Y-%m-%d").date()


def ymd(value: date) -> int:
    return int(value.strftime("%Y%m%d"))


def normalize_index_code(value: str) -> str:
    text = str(value).strip().upper()
    if text not in INDEX_CODES:
        raise CollectorError(f"Unsupported market index code: {value}")
    return text


def parse_hhmm(value: Any) -> str:
    raw = int(value)
    text = str(raw).zfill(6 if raw > 2359 else 4)
    hh = int(text[:2])
    mm = int(text[2:4])
    if hh > 23 or mm > 59:
        raise CollectorError(f"Invalid CYBOS minute time: {value}")
    return f"{hh:02d}:{mm:02d}"


def decimal_text(value: Any, label: str) -> str:
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError) as exc:
        raise CollectorError(f"Invalid decimal {label}: {value}") from exc
    if not parsed.is_finite() or parsed <= 0:
        raise CollectorError(f"Non-positive index level {label}: {value}")
    text = format(parsed, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text or "0"


def volume_int(value: Any, label: str) -> int:
    try:
        parsed = int(value)
    except Exception as exc:
        raise CollectorError(f"Invalid volume {label}: {value}") from exc
    if parsed < 0:
        raise CollectorError(f"Negative volume {label}: {value}")
    return parsed


def validate_ohlc(row: dict[str, Any]) -> None:
    values = {name: Decimal(str(row[name])) for name in ("open", "high", "low", "close")}
    if values["high"] < max(values.values()):
        raise CollectorError(f"HIGH_BELOW_OHLC_MAX:{row.get('timestamp') or row.get('date')}")
    if values["low"] > min(values.values()):
        raise CollectorError(f"LOW_ABOVE_OHLC_MIN:{row.get('timestamp') or row.get('date')}")


class CybosMarketIndex:
    def __init__(self, max_attempts: int) -> None:
        if struct.calcsize("P") * 8 != 32:
            raise CollectorError("CYBOS market index collector must run under 32-bit Python.")
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

    def range_rows(self, code: str, start_day: date, end_day: date, mode: str) -> list[dict[str, Any]]:
        index_code = normalize_index_code(code)
        minute_mode = mode == "minute"
        fields = MINUTE_FIELDS if minute_mode else DAILY_FIELDS
        chart_type = "m" if minute_mode else "D"
        last_error: Exception | None = None

        for attempt in range(1, self.max_attempts + 1):
            try:
                chart = self.win32.Dispatch("CpSysDib.StockChart")
                chart.SetInputValue(0, index_code)
                chart.SetInputValue(1, ord("1"))
                chart.SetInputValue(2, ymd(end_day))
                chart.SetInputValue(3, ymd(start_day))
                chart.SetInputValue(5, fields)
                chart.SetInputValue(6, ord(chart_type))
                if minute_mode:
                    chart.SetInputValue(7, 1)
                chart.SetInputValue(9, ord("0"))
                chart.SetInputValue(10, ord("1"))
                chart.SetInputValue(11, ord("Y"))

                rows: list[dict[str, Any]] = []
                previous_signature: tuple[Any, ...] | None = None
                while True:
                    self.wait_quote_slot()
                    chart.BlockRequest()
                    status = int(chart.GetDibStatus())
                    message = str(chart.GetDibMsg1()).strip()
                    if status != 0:
                        raise CollectorError(f"{index_code} status={status} message={message}")
                    count = int(chart.GetHeaderValue(3))
                    page: list[dict[str, Any]] = []
                    for index in range(count):
                        day = datetime.strptime(str(int(chart.GetDataValue(0, index))), "%Y%m%d").date()
                        if day < start_day or day > end_day:
                            continue
                        if minute_mode:
                            stamp = f"{day.isoformat()}T{parse_hhmm(chart.GetDataValue(1, index))}"
                            offset = 2
                            row = {
                                "timestamp": stamp,
                                "open": decimal_text(chart.GetDataValue(offset + 0, index), f"{index_code}:{stamp}:open"),
                                "high": decimal_text(chart.GetDataValue(offset + 1, index), f"{index_code}:{stamp}:high"),
                                "low": decimal_text(chart.GetDataValue(offset + 2, index), f"{index_code}:{stamp}:low"),
                                "close": decimal_text(chart.GetDataValue(offset + 3, index), f"{index_code}:{stamp}:close"),
                                "volume": volume_int(chart.GetDataValue(offset + 4, index), f"{index_code}:{stamp}:volume"),
                            }
                        else:
                            stamp = day.isoformat()
                            offset = 1
                            row = {
                                "date": stamp,
                                "open": decimal_text(chart.GetDataValue(offset + 0, index), f"{index_code}:{stamp}:open"),
                                "high": decimal_text(chart.GetDataValue(offset + 1, index), f"{index_code}:{stamp}:high"),
                                "low": decimal_text(chart.GetDataValue(offset + 2, index), f"{index_code}:{stamp}:low"),
                                "close": decimal_text(chart.GetDataValue(offset + 3, index), f"{index_code}:{stamp}:close"),
                                "volume": volume_int(chart.GetDataValue(offset + 4, index), f"{index_code}:{stamp}:volume"),
                            }
                        validate_ohlc(row)
                        page.append(row)

                    signature = (
                        count,
                        (page[0].get("timestamp") or page[0].get("date")) if page else None,
                        (page[-1].get("timestamp") or page[-1].get("date")) if page else None,
                    )
                    if bool(chart.Continue) and count == 0:
                        raise CollectorError(f"PAGINATION_EMPTY_CONTINUE:{index_code}:{mode}")
                    if bool(chart.Continue) and signature == previous_signature:
                        raise CollectorError(f"PAGINATION_STALLED:{index_code}:{mode}")
                    previous_signature = signature
                    rows.extend(page)
                    if not bool(chart.Continue):
                        break

                key_name = "timestamp" if minute_mode else "date"
                by_key: dict[str, dict[str, Any]] = {}
                for row in rows:
                    key = str(row[key_name])
                    if key in by_key and by_key[key] != row:
                        raise CollectorError(f"DUPLICATE_DRIFT:{index_code}:{mode}:{key}")
                    by_key[key] = row
                return [by_key[key] for key in sorted(by_key)]
            except Exception as exc:
                last_error = exc
                if attempt < self.max_attempts:
                    time.sleep(min(3.0, 0.4 * (2 ** (attempt - 1))))
        raise CollectorError(f"{index_code} {mode} failed after {self.max_attempts} attempts: {last_error}")


def write_csv(path: Path, rows: list[dict[str, Any]], mode: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    fields = MINUTE_CSV_FIELDS if mode == "minute" else DAILY_CSV_FIELDS
    with temp.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
    os.replace(temp, path)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbols", default=",".join(INDEX_CODES))
    parser.add_argument("--mode", choices=("daily", "minute"), required=True)
    parser.add_argument("--from", dest="date_from", required=True)
    parser.add_argument("--to", dest="date_to", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--max-attempts", type=int, default=3)
    args = parser.parse_args()

    start_day = parse_day(args.date_from)
    end_day = parse_day(args.date_to)
    if start_day > end_day:
        raise CollectorError("--from cannot be after --to")
    codes = list(dict.fromkeys(normalize_index_code(item) for item in args.symbols.split(",") if item.strip()))
    if not codes:
        raise CollectorError("At least one market index code is required.")

    output = Path(args.output).resolve()
    collector = CybosMarketIndex(args.max_attempts)
    files = 0
    rows_total = 0
    for code in codes:
        rows = collector.range_rows(code, start_day, end_day, args.mode)
        if not rows:
            continue
        write_csv(output / f"{code}.csv", rows, args.mode)
        files += 1
        rows_total += len(rows)
    print(
        f"[PASS] cybos market index {args.mode} collected files={files} rows={rows_total} "
        f"range={start_day.isoformat()}..{end_day.isoformat()}"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"[FAIL] {type(exc).__name__}: {exc}", file=sys.stderr)
        raise SystemExit(1)
