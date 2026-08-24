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

FIELDS = (0, 1, 2, 3, 4, 5, 8, 9)
CSV_FIELDS = ("timestamp", "open", "high", "low", "close", "volume", "amount")


class CollectorError(RuntimeError):
    pass


def parse_day(value: str) -> date:
    return datetime.strptime(str(value).strip(), "%Y-%m-%d").date()


def ymd(value: date) -> int:
    return int(value.strftime("%Y%m%d"))


def normalize_code(value: str) -> str:
    text = str(value).strip().upper()
    if text.startswith("A"):
        text = text[1:]
    if len(text) != 6 or not text.isalnum():
        raise CollectorError(f"Invalid stock code: {value}")
    return text


def parse_hhmm(value: Any) -> str:
    raw = int(value)
    text = str(raw).zfill(6 if raw > 2359 else 4)
    hh = int(text[:2])
    mm = int(text[2:4])
    if hh > 23 or mm > 59:
        raise CollectorError(f"Invalid CYBOS minute time: {value}")
    return f"{hh:02d}:{mm:02d}"


def validate_row(row: dict[str, Any]) -> None:
    for field in ("open", "high", "low", "close", "volume", "amount"):
        value = row[field]
        if isinstance(value, bool) or not isinstance(value, int):
            raise CollectorError(f"NON_INTEGER_{field.upper()}:{row['timestamp']}")
    if min(row["open"], row["high"], row["low"], row["close"]) <= 0:
        raise CollectorError(f"NON_POSITIVE_PRICE:{row['timestamp']}")
    if row["volume"] < 0 or row["amount"] < 0:
        raise CollectorError(f"NEGATIVE_QUANTITY:{row['timestamp']}")
    if row["high"] < max(row["open"], row["low"], row["close"]):
        raise CollectorError(f"HIGH_BELOW_OHLC_MAX:{row['timestamp']}")
    if row["low"] > min(row["open"], row["high"], row["close"]):
        raise CollectorError(f"LOW_ABOVE_OHLC_MIN:{row['timestamp']}")


class CybosMinute:
    def __init__(self, max_attempts: int) -> None:
        if struct.calcsize("P") * 8 != 32:
            raise CollectorError("CYBOS minute collector must run under 32-bit Python.")
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

    def range_rows(self, code: str, start_day: date, end_day: date, *, exchange: str, adjusted: bool) -> list[dict[str, Any]]:
        symbol = "A" + normalize_code(code)
        last_error: Exception | None = None
        for attempt in range(1, self.max_attempts + 1):
            try:
                chart = self.win32.Dispatch("CpSysDib.StockChart")
                chart.SetInputValue(0, symbol)
                chart.SetInputValue(1, ord("1"))
                chart.SetInputValue(2, ymd(end_day))
                chart.SetInputValue(3, ymd(start_day))
                chart.SetInputValue(5, FIELDS)
                chart.SetInputValue(6, ord("m"))
                chart.SetInputValue(7, 1)
                chart.SetInputValue(9, ord("1" if adjusted else "0"))
                chart.SetInputValue(10, ord("1"))
                chart.SetInputValue(11, ord("Y"))
                chart.SetInputValue(12, ord(exchange))

                rows: list[dict[str, Any]] = []
                previous_signature: tuple[Any, ...] | None = None
                while True:
                    self.wait_quote_slot()
                    chart.BlockRequest()
                    status = int(chart.GetDibStatus())
                    message = str(chart.GetDibMsg1()).strip()
                    if status != 0:
                        raise CollectorError(f"{symbol} status={status} message={message}")
                    count = int(chart.GetHeaderValue(3))
                    page: list[dict[str, Any]] = []
                    for index in range(count):
                        day = datetime.strptime(str(int(chart.GetDataValue(0, index))), "%Y%m%d").date()
                        if day < start_day or day > end_day:
                            continue
                        timestamp = f"{day.isoformat()}T{parse_hhmm(chart.GetDataValue(1, index))}"
                        row = {
                            "timestamp": timestamp,
                            "open": chart.GetDataValue(2, index),
                            "high": chart.GetDataValue(3, index),
                            "low": chart.GetDataValue(4, index),
                            "close": chart.GetDataValue(5, index),
                            "volume": chart.GetDataValue(6, index),
                            "amount": chart.GetDataValue(7, index),
                        }
                        validate_row(row)
                        page.append(row)
                    signature = (count, page[0]["timestamp"] if page else None, page[-1]["timestamp"] if page else None)
                    if bool(chart.Continue) and count == 0:
                        raise CollectorError(f"PAGINATION_EMPTY_CONTINUE:{symbol}")
                    if bool(chart.Continue) and signature == previous_signature:
                        raise CollectorError(f"PAGINATION_STALLED:{symbol}")
                    previous_signature = signature
                    rows.extend(page)
                    if not bool(chart.Continue):
                        break
                by_stamp: dict[str, dict[str, Any]] = {}
                for row in rows:
                    if row["timestamp"] in by_stamp and by_stamp[row["timestamp"]] != row:
                        raise CollectorError(f"DUPLICATE_DRIFT:{symbol}:{row['timestamp']}")
                    by_stamp[row["timestamp"]] = row
                return [by_stamp[key] for key in sorted(by_stamp)]
            except Exception as exc:
                last_error = exc
                if attempt < self.max_attempts:
                    time.sleep(min(3.0, 0.4 * (2 ** (attempt - 1))))
        raise CollectorError(f"{symbol} failed after {self.max_attempts} attempts: {last_error}")


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    with temp.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=CSV_FIELDS, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
    os.replace(temp, path)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbols", required=True, help="comma-separated six-character stock codes")
    parser.add_argument("--from", dest="date_from", required=True)
    parser.add_argument("--to", dest="date_to", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--exchange", default="A")
    parser.add_argument("--adjusted", default="true")
    parser.add_argument("--max-attempts", type=int, default=3)
    args = parser.parse_args()

    start_day = parse_day(args.date_from)
    end_day = parse_day(args.date_to)
    if start_day > end_day:
        raise CollectorError("--from cannot be after --to")
    codes = list(dict.fromkeys(normalize_code(item) for item in args.symbols.split(",") if item.strip()))
    if not codes:
        raise CollectorError("At least one symbol is required.")

    output = Path(args.output).resolve()
    collector = CybosMinute(args.max_attempts)
    files = 0
    rows_total = 0
    for code in codes:
        rows = collector.range_rows(code, start_day, end_day, exchange=args.exchange, adjusted=str(args.adjusted).lower() == "true")
        if not rows:
            continue
        write_csv(output / f"{code}.csv", rows)
        files += 1
        rows_total += len(rows)
    print(f"[PASS] cybos minute collected files={files} rows={rows_total} range={start_day.isoformat()}..{end_day.isoformat()}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"[FAIL] {type(exc).__name__}: {exc}", file=sys.stderr)
        raise SystemExit(1)
