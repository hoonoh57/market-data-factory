#!/usr/bin/env python
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import struct
import sys
import time
from datetime import date, datetime, time as dtime, timedelta, timezone
from pathlib import Path
from typing import Any

KST = timezone(timedelta(hours=9))
FIELDS = (0, 2, 3, 4, 5, 8, 9)
CSV_FIELDS = ("date", "open", "high", "low", "close", "volume", "amount")
SAMSUNG = "A005930"


class DownloadError(RuntimeError):
    pass


class DataValidationError(RuntimeError):
    pass


def parse_day(value: str, *, today: date) -> date:
    text = str(value).strip()
    if text.lower() == "today":
        return today
    return datetime.strptime(text, "%Y-%m-%d").date()


def ymd(value: date) -> int:
    return int(value.strftime("%Y%m%d"))


def iso_from_ymd(value: Any) -> str:
    return datetime.strptime(str(int(value)), "%Y%m%d").date().isoformat()


def requested_end_guard(requested: date, now_kst: datetime) -> tuple[date, str | None]:
    today = now_kst.date()
    requested = min(requested, today)
    if requested == today and now_kst.time() < dtime(20, 0):
        return today - timedelta(days=1), "TODAY_NOT_COMPLETE_BEFORE_20_KST"
    return requested, None


def atomic_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(text, encoding="utf-8", newline="")
    os.replace(temp, path)


def atomic_json(path: Path, value: Any) -> None:
    atomic_text(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def emit_progress(completed: int, total: int, code: str, status: str, **extra: Any) -> None:
    payload = {
        "event": "collector_progress", "type": "daily", "completed": completed,
        "total": total, "percent": round(completed * 100 / total, 1) if total else 100.0,
        "code": code, "status": status, **extra,
    }
    print("BAR_EVENT " + json.dumps(payload, ensure_ascii=False), flush=True)


def emit_progress(completed: int, total: int, code: str, status: str, **extra: Any) -> None:
    payload = {
        "event": "collector_progress", "type": "daily", "completed": completed,
        "total": total, "percent": round(completed * 100 / total, 1) if total else 100.0,
        "code": code, "status": status, **extra,
    }
    print("BAR_EVENT " + json.dumps(payload, ensure_ascii=False), flush=True)


def read_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def definition_id(request: dict[str, Any]) -> str:
    payload = {
        "dataset": "daily",
        "exchange": request.get("exchange", "A"),
        "adjusted": bool(request.get("adjusted", True)),
        "fields": list(CSV_FIELDS),
        "source": "CpSysDib.StockChart",
    }
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def next_day(value: str) -> date:
    return datetime.strptime(value, "%Y-%m-%d").date() + timedelta(days=1)


class Cybos:
    def __init__(self, max_attempts: int) -> None:
        if struct.calcsize("P") * 8 != 32:
            raise DownloadError("CYBOS collector must run under 32-bit Python.")
        try:
            import win32com.client  # type: ignore
        except Exception as exc:
            raise DownloadError("pywin32 is required in the 32-bit Python environment.") from exc
        self.win32 = win32com.client
        self.status = self.win32.Dispatch("CpUtil.CpCybos")
        self.code_mgr = self.win32.Dispatch("CpUtil.CpCodeMgr")
        self.max_attempts = max(1, int(max_attempts))
        if int(self.status.IsConnect) == 0:
            raise DownloadError("CYBOS Plus is not connected.")

    def wait_quote_slot(self) -> None:
        try:
            remain = int(self.status.GetLimitRemainCount(1))
        except Exception:
            return
        if remain > 1:
            return
        wait_ms = max(100, int(getattr(self.status, "LimitRequestRemainTime", 1000)))
        time.sleep(wait_ms / 1000.0 + 0.05)

    def regular_stock_universe(self) -> list[dict[str, str]]:
        rows: list[dict[str, str]] = []
        for market_id, market_name in ((1, "KOSPI"), (2, "KOSDAQ")):
            for raw_code in self.code_mgr.GetStockListByMarket(market_id):
                code = str(raw_code)
                if int(self.code_mgr.GetStockSectionKind(code)) != 1:
                    continue
                try:
                    if bool(self.code_mgr.IsSPAC(code)):
                        continue
                except Exception as exc:
                    raise DownloadError("CpCodeMgr.IsSPAC is required; refusing name-based SPAC filtering.") from exc
                rows.append({"code": code, "name": str(self.code_mgr.CodeToName(code)).strip(), "market": market_name})
        rows.sort(key=lambda row: row["code"])
        return rows

    def daily_rows(self, code: str, start: date, end: date, *, exchange: str, adjusted: bool) -> list[dict[str, Any]]:
        if start > end:
            return []
        last_error: Exception | None = None
        for attempt in range(1, self.max_attempts + 1):
            try:
                self.wait_quote_slot()
                chart = self.win32.Dispatch("CpSysDib.StockChart")
                chart.SetInputValue(0, code)
                chart.SetInputValue(1, ord("1"))
                chart.SetInputValue(2, ymd(end))
                chart.SetInputValue(3, ymd(start))
                chart.SetInputValue(5, FIELDS)
                chart.SetInputValue(6, ord("D"))
                chart.SetInputValue(9, ord("1" if adjusted else "0"))
                chart.SetInputValue(12, ord(exchange))
                chart.BlockRequest()
                status = int(chart.GetDibStatus())
                message = str(chart.GetDibMsg1()).strip()
                if status != 0:
                    raise DownloadError(f"{code} CYBOS status={status} message={message}")
                count = int(chart.GetHeaderValue(3))
                rows: list[dict[str, Any]] = []
                for index in range(count):
                    row = {
                        "date": iso_from_ymd(chart.GetDataValue(0, index)),
                        "open": chart.GetDataValue(1, index),
                        "high": chart.GetDataValue(2, index),
                        "low": chart.GetDataValue(3, index),
                        "close": chart.GetDataValue(4, index),
                        "volume": chart.GetDataValue(5, index),
                        "amount": chart.GetDataValue(6, index),
                    }
                    if start.isoformat() <= row["date"] <= end.isoformat():
                        rows.append(row)
                rows.sort(key=lambda row: row["date"])
                return rows
            except Exception as exc:
                last_error = exc
                if attempt < self.max_attempts:
                    time.sleep(min(3.0, 0.4 * (2 ** (attempt - 1))))
        raise DownloadError(f"{code} download failed after {self.max_attempts} attempts: {last_error}")


def validate_rows(rows: list[dict[str, Any]], *, allow_empty: bool) -> None:
    if not rows:
        if allow_empty:
            return
        raise DataValidationError("NO_DATA")
    previous = ""
    seen: set[str] = set()
    for row in rows:
        day = str(row.get("date", ""))
        datetime.strptime(day, "%Y-%m-%d")
        if day in seen:
            raise DataValidationError(f"DUPLICATE_DATE:{day}")
        if previous and day <= previous:
            raise DataValidationError(f"DATE_ORDER:{previous}:{day}")
        seen.add(day)
        previous = day
        for field in ("open", "high", "low", "close", "volume", "amount"):
            value = row.get(field)
            if isinstance(value, bool) or not isinstance(value, int):
                raise DataValidationError(f"NON_INTEGER_{field.upper()}:{day}:{type(value).__name__}")
        if min(row["open"], row["high"], row["low"], row["close"]) <= 0:
            raise DataValidationError(f"NON_POSITIVE_PRICE:{day}")
        if row["volume"] < 0 or row["amount"] < 0:
            raise DataValidationError(f"NEGATIVE_QUANTITY:{day}")
        if row["high"] < max(row["open"], row["low"], row["close"]):
            raise DataValidationError(f"HIGH_BELOW_OHLC_MAX:{day}")
        if row["low"] > min(row["open"], row["high"], row["close"]):
            raise DataValidationError(f"LOW_ABOVE_OHLC_MIN:{day}")


def read_csv_rows(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            rows.append({
                "date": row["date"],
                "open": int(row["open"]),
                "high": int(row["high"]),
                "low": int(row["low"]),
                "close": int(row["close"]),
                "volume": int(row["volume"]),
                "amount": int(row["amount"]),
            })
    validate_rows(rows, allow_empty=True)
    return rows


def merge_rows(existing: list[dict[str, Any]], incoming: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_day = {row["date"]: row for row in existing}
    for row in incoming:
        current = by_day.get(row["date"])
        if current is not None and current != row:
            raise DataValidationError(f"OVERLAP_DRIFT:{row['date']}")
        by_day[row["date"]] = row
    merged = [by_day[key] for key in sorted(by_day)]
    validate_rows(merged, allow_empty=False)
    return merged


def write_csv_rows(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    with temp.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=CSV_FIELDS)
        writer.writeheader()
        writer.writerows(rows)
    os.replace(temp, path)


def write_universe(path: Path, rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    with temp.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=("code", "name", "market"))
        writer.writeheader()
        writer.writerows(rows)
    os.replace(temp, path)


def archive_accepted(path: Path, rejected_dir: Path) -> None:
    if not path.exists():
        return
    rejected_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(KST).strftime("%Y%m%d-%H%M%S")
    os.replace(path, rejected_dir / f"{path.stem}.{stamp}.csv")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True)
    parser.add_argument("--plan", action="store_true")
    parser.add_argument("--symbols", default="")
    args = parser.parse_args()

    request_path = Path(args.request).resolve()
    request = json.loads(request_path.read_text(encoding="utf-8"))
    if request.get("dataset") != "daily":
        raise DownloadError("This collector accepts dataset='daily' only.")

    now_kst = datetime.now(KST)
    start = parse_day(request.get("dateFrom", "2021-01-01"), today=now_kst.date())
    requested_end = parse_day(request.get("dateTo", "today"), today=now_kst.date())
    guarded_end, guard_reason = requested_end_guard(requested_end, now_kst)
    output_dir = Path(request.get("outputDir", ".runtime/cybos/daily")).resolve()
    if args.plan:
        print(f"[PASS] cybos daily plan from={start} requested_to={requested_end} eligible_to={guarded_end} guard={guard_reason or 'none'} output={output_dir}")
        return 0
    if start > guarded_end:
        print(f"[PASS] cybos daily no completed date in range from={start} to={guarded_end}")
        return 0

    cybos = Cybos(max_attempts=int(request.get("maxAttempts", 3)))
    output_dir.mkdir(parents=True, exist_ok=True)
    universe = cybos.regular_stock_universe()
    write_universe(output_dir / "universe.csv", universe)

    # This probe only discovers the latest completed trading date. Querying the
    # full historical range is unnecessary and can trigger duplicate-date output
    # from a long-period StockChart ALL-market request. Keep the actual data
    # collection range unchanged and bounded only for this calendar probe.
    probe_start = max(start, guarded_end - timedelta(days=45))
    samsung_rows = cybos.daily_rows(SAMSUNG, probe_start, guarded_end, exchange=str(request.get("exchange", "A")), adjusted=bool(request.get("adjusted", True)))
    validate_rows(samsung_rows, allow_empty=True)
    if not samsung_rows:
        print(f"[PASS] cybos daily no completed trading bar from={probe_start} to={guarded_end}")
        return 0
    target_end = datetime.strptime(samsung_rows[-1]["date"], "%Y-%m-%d").date()

    requested_symbols = [item.strip() for item in args.symbols.split(",") if item.strip()]
    if requested_symbols:
        by_code = {row["code"]: row for row in universe}
        selected = set(requested_symbols)
        # The DB instrument table is the requested source of truth. Keep stale or
        # delisted codes in the plan and let CYBOS report whether they are usable.
        universe = [by_code.get(code, {"code": code, "name": "", "market": ""}) for code in sorted(selected)]

    state_path = output_dir / ".state.json"
    expected_definition = definition_id(request)
    state = read_json(state_path, {
        "version": 1,
        "definitionId": expected_definition,
        "completedThrough": {},
        "transportFailures": {},
        "rejected": {},
    })
    if state.get("definitionId") != expected_definition:
        raise DownloadError("Existing daily state has a different data definition; refusing to mix datasets.")

    accepted = 0
    skipped = 0
    transport_failures: list[tuple[str, str]] = []
    rejected_dir = output_dir / "rejected"

    total = len(universe)
    print(f"[DAILY] start symbols={total} target_end={target_end.isoformat()}", flush=True)
    for index, item in enumerate(universe, start=1):
        code = item["code"]
        if code in state["rejected"]:
            skipped += 1
            print(f"[DAILY] {index}/{total} code={code} status=previously_rejected", flush=True)
            emit_progress(index, total, code, "previously_rejected")
            emit_progress(index, total, code, "previously_rejected")
            continue
        file_code = code[1:] if code.startswith("A") else code
        path = output_dir / f"{file_code}.csv"
        existing = read_csv_rows(path)
        completed = state["completedThrough"].get(code)
        symbol_start = next_day(completed) if completed else (next_day(existing[-1]["date"]) if existing else start)
        if symbol_start > target_end:
            skipped += 1
            print(f"[DAILY] {index}/{total} code={code} status=current", flush=True)
            emit_progress(index, total, code, "current")
            emit_progress(index, total, code, "current")
            continue
        try:
            print(
                f"[DAILY] {index}/{total} code={code} range={symbol_start.isoformat()}..{target_end.isoformat()} status=downloading",
                flush=True,
            )
            incoming = cybos.daily_rows(code, symbol_start, target_end, exchange=str(request.get("exchange", "A")), adjusted=bool(request.get("adjusted", True)))
            validate_rows(incoming, allow_empty=True)
            merged = merge_rows(existing, incoming) if incoming else existing
            if merged:
                write_csv_rows(path, merged)
            state["completedThrough"][code] = target_end.isoformat()
            state["transportFailures"].pop(code, None)
            atomic_json(state_path, state)
            accepted += 1
            print(f"[DAILY] {index}/{total} code={code} rows={len(incoming)} status=done", flush=True)
            emit_progress(index, total, code, "done", rows=len(incoming))
            emit_progress(index, total, code, "done", rows=len(incoming))
        except DataValidationError as exc:
            archive_accepted(path, rejected_dir)
            state["rejected"][code] = {"reason": str(exc), "at": datetime.now(KST).isoformat()}
            state["completedThrough"].pop(code, None)
            state["transportFailures"].pop(code, None)
            atomic_json(state_path, state)
            print(f"[DAILY] {index}/{total} code={code} status=rejected error={exc}", file=sys.stderr, flush=True)
            emit_progress(index, total, code, "rejected", error=str(exc))
            emit_progress(index, total, code, "rejected", error=str(exc))
        except Exception as exc:
            reason = str(exc)
            state["transportFailures"][code] = {"reason": reason, "at": datetime.now(KST).isoformat()}
            atomic_json(state_path, state)
            transport_failures.append((code, reason))
            print(f"[DAILY] {index}/{total} code={code} status=failed error={reason}", file=sys.stderr, flush=True)
            emit_progress(index, total, code, "failed", error=reason)
            emit_progress(index, total, code, "failed", error=reason)

    atomic_json(output_dir / "rejected.json", state["rejected"])
    atomic_json(output_dir / "manifest.json", {
        "generatedAt": datetime.now(KST).isoformat(),
        "definitionId": expected_definition,
        "requestedFrom": start.isoformat(),
        "requestedTo": requested_end.isoformat(),
        "completedEligibleTo": guarded_end.isoformat(),
        "latestTradingDate": target_end.isoformat(),
        "exchange": request.get("exchange", "A"),
        "adjusted": bool(request.get("adjusted", True)),
        "universeCount": len(universe),
        "acceptedThisRun": accepted,
        "skippedThisRun": skipped,
        "rejectedCount": len(state["rejected"]),
        "pendingTransportFailures": len(state["transportFailures"]),
    })

    if transport_failures:
        print("[FAIL] CYBOS daily download incomplete; rerun the same command to resume.", file=sys.stderr)
        return 2
    print(f"[PASS] cybos daily accepted={accepted} skipped={skipped} rejected={len(state['rejected'])} latest={target_end.isoformat()}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"[FAIL] {type(exc).__name__}: {exc}", file=sys.stderr)
        raise SystemExit(1)
