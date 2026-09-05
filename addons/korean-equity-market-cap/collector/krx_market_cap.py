"""Collect monthly Korean equity market-cap snapshots from the official KRX Open API."""

from __future__ import annotations

import argparse
import calendar
import csv
import json
import os
import sys
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


BASE_URL = "https://data-dbg.krx.co.kr/svc/apis/sto"
MARKETS = {"KOSPI": "stk_bydd_trd", "KOSDAQ": "ksq_bydd_trd"}


def emit(event: str, **payload: object) -> None:
    print("BAR_EVENT " + json.dumps({"event": event, "type": "market_cap", **payload}, ensure_ascii=False), flush=True)


def parse_day(value: str) -> date:
    return datetime.strptime(value, "%Y-%m-%d").date()


def month_targets(start: date, end: date) -> list[date]:
    targets: list[date] = []
    year, month = start.year, start.month
    while (year, month) <= (end.year, end.month):
        last = date(year, month, calendar.monthrange(year, month)[1])
        target = min(last, end)
        if target >= start:
            targets.append(target)
        month = month + 1
        if month == 13:
            year, month = year + 1, 1
    return targets


def request_rows(base_url: str, endpoint: str, day: date, auth_key: str) -> list[dict[str, object]]:
    url = f"{base_url.rstrip('/')}/{endpoint}?{urlencode({'basDd': day.strftime('%Y%m%d')})}"
    request = Request(url, headers={"AUTH_KEY": auth_key, "Accept": "application/json", "User-Agent": "market-data-factory/1.0"})
    try:
        with urlopen(request, timeout=30) as response:
            body = response.read().decode("utf-8-sig")
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:300]
        raise RuntimeError(f"KRX Open API HTTP {exc.code}: {detail}") from exc
    except URLError as exc:
        raise RuntimeError(f"KRX Open API 연결 실패: {exc.reason}") from exc
    try:
        payload = json.loads(body)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"KRX Open API가 JSON이 아닌 응답을 반환했습니다: {body[:200]}") from exc
    if isinstance(payload, dict):
        for key in ("OutBlock_1", "output", "data"):
            if isinstance(payload.get(key), list):
                return payload[key]
        for value in payload.values():
            if isinstance(value, list):
                return value
        message = payload.get("message") or payload.get("msg") or payload.get("resultMsg")
        if message:
            raise RuntimeError(f"KRX Open API 오류: {message}")
    return []


def integer(value: object) -> int:
    return int(str(value or "0").replace(",", "").strip() or "0")


def normalize_code(value: object) -> str | None:
    code = str(value or "").strip()
    if len(code) == 6 and code.isalnum():
        return code
    if len(code) == 12 and code.startswith("KR"):
        candidate = code[3:9]
        return candidate if candidate.isalnum() else None
    return None


def collect_snapshot(base_url: str, target: date, auth_key: str, sleep_seconds: float) -> tuple[date, list[dict[str, object]]]:
    for offset in range(8):
        actual = target - timedelta(days=offset)
        combined: list[dict[str, object]] = []
        valid = True
        for market, endpoint in MARKETS.items():
            rows = request_rows(base_url, endpoint, actual, auth_key)
            emit("collector_progress", target=str(target), trading_date=str(actual), market=market, rows=len(rows))
            if not rows:
                valid = False
                break
            combined.extend(rows)
            if sleep_seconds:
                time.sleep(sleep_seconds)
        if valid:
            return actual, combined
    raise RuntimeError(f"{target} 및 직전 7일에서 코스피·코스닥 데이터를 찾지 못했습니다.")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--from", dest="start", required=True)
    parser.add_argument("--to", dest="end", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--sleep", type=float, default=0.15)
    parser.add_argument("--base-url", default=BASE_URL)
    args = parser.parse_args()
    start, end = parse_day(args.start), parse_day(args.end)
    if start > end:
        raise RuntimeError("시작일이 종료일보다 늦습니다.")
    auth_key = os.environ.get("KRX_AUTH_KEY", "").strip()
    if not auth_key:
        raise RuntimeError("KRX_AUTH_KEY가 없습니다. .env에 공식 KRX Open API 인증키를 설정하세요.")

    records: dict[tuple[str, str], tuple[str, str, int, int]] = {}
    targets = month_targets(start, end)
    for index, target in enumerate(targets, 1):
        actual, rows = collect_snapshot(args.base_url, target, auth_key, args.sleep)
        for row in rows:
            code = normalize_code(row.get("ISU_SRT_CD") or row.get("ISU_CD"))
            if not code:
                continue
            trading_day = str(row.get("BAS_DD") or actual.strftime("%Y%m%d"))
            trading_date = f"{trading_day[:4]}-{trading_day[4:6]}-{trading_day[6:8]}"
            listed_shares = integer(row.get("LIST_SHRS"))
            market_cap = integer(row.get("MKTCAP"))
            if listed_shares > 0 and market_cap > 0:
                records[(code, trading_date)] = (code, trading_date, listed_shares, market_cap)
        emit("progress", completed=index, total=len(targets), percent=round(index * 100 / len(targets), 1))

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.writer(stream, lineterminator="\n")
        writer.writerow(["code", "trading_date", "listed_shares", "market_cap"])
        writer.writerows(sorted(records.values(), key=lambda item: (item[1], item[0])))
    emit("collected", rows=len(records), snapshots=len(targets), output=str(output))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr, flush=True)
        raise SystemExit(1)
