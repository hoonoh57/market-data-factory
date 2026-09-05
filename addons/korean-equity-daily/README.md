# korean-equity-daily

Detachable Data Add-on for adjusted Korean equity daily OHLCV + traded amount.

> Current runtime/updater handoff: [`../../docs/CURRENT_UPDATE_PIPELINE.md`](../../docs/CURRENT_UPDATE_PIPELINE.md)

## Purpose

Provide one durable MySQL-backed daily-bar contract for research projects so they do not rediscover old CSV folders or rebuild download/update logic.

## Source contract

- provider: CYBOS Plus `CpSysDib.StockChart`
- instrument scope: regular KOSPI/KOSDAQ equities plus the shared MySQL EQUITY maintenance universe
- normalized code format in the shared updater/importer: `[0-9A-Z]{6}`
- SPAC: excluded by provider metadata, not name heuristics, when building the current CYBOS regular-stock universe
- request mode: period mode
- period type: daily (`D`)
- exchange selector: `A` = integrated ALL market; production daily must include KRX + NXT activity
- adjusted price: `true`
- source fields: date, open, high, low, close, volume, amount
- current recovered collection start: 2021-01-01
- completed-session guard: requests for `today` stop at the previous day before 20:00 KST

### Production `A` contract

Do not change this dataset to `exchange=K` to work around provider behavior.

A live Samsung Electronics probe for `2026-09-04` showed:

```text
A: open=251000 high=259000 low=251000 close=257000 volume=21429660 amount=5473432000000
K: open=254000 high=259000 low=252500 close=255500 volume=14031862 amount=3586126000000
N: open=251000 high=258750 low=251000 close=257000 volume=7397798  amount=1887305000000
```

For that probe, `A.volume = K.volume + N.volume`. The production contract therefore intentionally preserves the integrated `A` bar.

## Daily period-request edge cases

### Holiday/weekend requested end

CYBOS can return the last actual trading day twice when the requested period end is a holiday/weekend.

Observed example:

```text
A005930
2021-01-04 .. 2026-09-06
exchange=A
```

returned `2026-09-04` twice with every OHLCV/amount field identical.

Collector rule:

- exact same-date duplicate with every field identical -> collapse to one row
- same date with any differing field -> `DUPLICATE_DATE_DRIFT` and fail
- data drift is not retried as a transport error

Do not replace this rule with first/last selection, aggregation, or a KRX-only fallback.

### Latest actual trading date

The collector uses Samsung Electronics as a trading-calendar probe over the requested period and sets `target_end` to the last validated returned date.

For a request ending Sunday `2026-09-06`, the actual `target_end` was Friday `2026-09-04`.

### Provider-invalid symbols

CYBOS may reject stale/delisted/provider-invalid stock-master codes with `유효하지 않은 종목코드입니다.`.

Current behavior:

- classify that exact class as permanent symbol error
- do not waste three retries
- report `status=invalid`
- continue later symbols
- keep genuine transport failures and data-integrity failures on the error path

`A269620` was directly observed producing this provider-invalid error during the 2026-09-06 run.

## MySQL contract

Primary data table: `korean_equity_daily`

Instrument identity table: `market_instrument`

Ingestion evidence table: `data_ingestion_run`

Health view: `korean_equity_daily_health`

Apply `schema.sql` before importing.

## Import contract

Staged file names and normalized universe codes accept six-character alphanumeric equity codes:

```text
[0-9A-Z]{6}
```

This is required because valid collected files include names such as `0001A0.csv` and `0004V0.csv`.

The importer used to accept only numeric `\d{6}` file names, which caused 31 successfully collected alphanumeric daily files to be silently excluded from import. The parser/importer contract was corrected in logic baseline `fa5162f81b3b3e593e81c89d5791e3de72bd4bfb` with a regression test.

## Verified historical coverage

User-local MySQL migration and health verification on 2026-08-24 established:

- status: `ACTIVE`
- instruments: 2,599
- rows: 3,299,454
- trading-date range: 2021-01-04 through 2026-08-21
- initial migration: 3,299,454 inserted / 0 updated

Machine-readable historical evidence is in `VERIFIED_RESULTS.json`.

## 2026-09-06 operational checkpoint

After correcting exact duplicate handling and permanent invalid-symbol handling, an incremental run reached normal completion with:

```text
[DAILY IMPORT] 2597/2597 rows=10388 inserted=10388 updated=0
[PASS] korean-equity-daily imported files=2597 rows=10388 inserted=10388 updated=0
BAR_EVENT {"event":"status","type":"daily","instrumentsWithData":2600,"universe":2631,"missingInstruments":31,"earliestDate":"2021-01-04","latestDate":"2026-09-04"}
BAR_EVENT {"event":"complete","type":"daily","mode":"incremental","updatedSymbols":2628}
```

That runtime result was captured **before** the alphanumeric importer fix was rerun. The exact `2628 - 2597 = 31` difference matched the 31 missing instruments and led to the numeric-only importer diagnosis.

Pending runtime verification after `fa5162f`:

- rerun daily incremental
- confirm the 31 alphanumeric staging files are imported
- confirm actual `missingInstruments` result

Do not claim `missingInstruments=0` until that rerun proves it.

## Normal access

Use `access.sql` as canonical SQL examples. Consumers should depend on this table contract or a stable gateway, not on CYBOS, collector internals, or CSV paths.

## Update flow

Normal UI path:

```text
RUN_MARKET_DATA_UI.bat
  -> market_data_ui.py
  -> market_data_api.py
  -> scripts/update-korean-equity-bars.mjs
  -> CYBOS 32-bit daily collector
  -> validated staging CSV
  -> Node MySQL importer
  -> korean_equity_daily
  -> status event
```

Standalone incremental command:

```powershell
npm run data:daily:update
```

The staging CSV is transport material, not the long-term SSOT. MySQL is the durable data SSOT.

## Status interpretation

`missingInstruments` counts EQUITY instruments with no daily row at all. It does not prove that every instrument is current through the global `latestDate`.

A stronger freshness guarantee requires a per-symbol latest-date coverage audit.

## Known instrumentation issue

The daily collector currently emits some `collector_progress` events twice because duplicate progress instrumentation remains in the file. This is a logging/UI instrumentation defect, not duplicate stored market data. Fix it separately from source/import logic.

## Detachment

Removing this Add-on removes its schema/collector/import/access contract only. It must not change unrelated datasets or research semantics.

## Open evidence gaps

- historical delisted/unlisted universe coverage is not yet proven
- corporate-action semantics beyond recovered `adjusted=true` provider setting are not independently certified
- per-symbol freshness through the global latest date is not yet represented by the simple status summary
