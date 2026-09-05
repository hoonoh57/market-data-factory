# korean-equity-minute-1m

Detachable Data Add-on for adjusted Korean equity exact 1-minute OHLCV + traded amount.

> Current runtime/updater handoff: [`../../docs/CURRENT_UPDATE_PIPELINE.md`](../../docs/CURRENT_UPDATE_PIPELINE.md)

## Purpose

Provide one durable MySQL-backed 1-minute bar contract for exact intraday research, MFE/MAE, entry/exit timing, opening behavior, and Exact Chart Audit without depending on legacy experiment-project CSV paths.

## Source contract

- provider: CYBOS Plus `CpSysDib.StockChart`
- interval: exact 1 minute
- exchange selector: `A`
- adjusted-price setting: `true`
- source fields: timestamp, open, high, low, close, volume, amount
- timestamp meaning: local Korea market wall-clock minute (`YYYY-MM-DDTHH:MM`), stored in MySQL as `DATETIME` without timezone conversion
- exact-time rule: no nearest-time repair and no synthetic timestamp repair

## MySQL contract

Primary data table: `korean_equity_minute_1m`

Instrument identity table: shared `market_instrument`

Ingestion evidence table: shared `data_ingestion_run`

Health view: `korean_equity_minute_1m_health`

Apply `schema.sql` before importing.

## Verified migration evidence

Verified on 2026-08-24 KST against the local MySQL SSOT:

- imported files: 545
- imported rows: 30,799,935
- inserted rows: 30,799,935
- updated rows: 0
- instrument count: 545
- earliest bar timestamp: 2026-02-23 08:01:00 KST wall clock
- latest bar timestamp: 2026-08-21 20:00:00 KST wall clock
- health check: PASS

## Historical incremental evidence

A prior dynamic-universe updater was verified on 2026-08-27 KST with 760 instruments. That evidence remains useful as historical migration/coverage evidence, but **it is no longer the current normal shared updater policy**.

The active `data:minute:update` command now uses `scripts/update-korean-equity-bars.mjs`, the same shared planner used by the Python UI.

## Normal access

Use `access.sql` as canonical SQL examples. Consumers should depend on this table contract or a stable gateway, not on CYBOS, old experiment folders, or frozen research-selection files.

## Current incremental update contract

Normal command:

```powershell
npm run data:minute:update
```

The UI reaches the same updater through:

```text
RUN_MARKET_DATA_UI.bat
  -> market_data_ui.py
  -> market_data_api.py
  -> scripts/update-korean-equity-bars.mjs
```

Current shared behavior:

1. The target universe is every `market_instrument` row with `instrument_type='EQUITY'` whose normalized code matches `[0-9A-Z]{6}`.
2. When no explicit end is supplied, before 20:00 KST the previous calendar day is the request upper bound; at/after 20:00 KST today is eligible.
3. Each instrument already present in `korean_equity_minute_1m` resumes from its own `MAX(trading_date) + 1 calendar day`.
4. An instrument with no minute rows starts from the global earliest date currently present in the minute table.
5. If the minute table itself is empty, the first shared update requires an explicit start date.
6. CYBOS naturally returns only actual trading-session rows inside the requested period.
7. Collection uses `exchange=A`, `adjusted=true`, exact 1-minute bars, and the 32-bit CYBOS collector.
8. Provider-invalid stock codes are treated as permanent symbol-level skips rather than retryable transport failures.
9. Genuine transport, pagination, and data-integrity failures remain fatal/error conditions.
10. Staged CSV is idempotently upserted into MySQL, status is queried, and progress/status is emitted as `BAR_EVENT` JSON lines.

This is routine coverage maintenance. It does not silently create a new long historical retention horizon for symbols that were previously absent.

## Separate whole-market historical backfill

The explicit command:

```powershell
npm run data:minute:backfill-all
```

is a separate historical/backfill workflow and must remain separate from routine UI incremental maintenance.

Do not change the normal shared updater merely to achieve a different all-symbol historical research horizon. Define and verify that horizon in the explicit backfill workflow instead.

## Full-range UI/API mode

`market_data_api.update_bars(..., mode='full', start_date=..., end_date=...)` requests the explicit period for every EQUITY instrument and upserts the returned bars without deleting existing rows first.

Use full mode for an intentional bounded repair/re-download, not as an implicit replacement for the dedicated historical whole-market backfill policy.

## Migration/update flow

```text
MySQL market_instrument EQUITY universe
  -> shared planner
  -> CYBOS 32-bit exact 1m collector
  -> validated staging CSV
  -> Node MySQL importer
  -> korean_equity_minute_1m
  -> status
```

The CSV staging area is transport material only. MySQL is the durable SSOT.

## Status interpretation

Minute status returns:

```text
universe
instrumentsWithData
missingInstruments
earliestDate
latestDate
```

Because the minute table can be very large, status deliberately avoids a full row-count scan.

`missingInstruments=0` means every EQUITY instrument has at least one minute row. It does not prove every instrument is current through the dataset-global `latestDate`.

## Analytical-cache boundary

There is currently no Parquet/DuckDB/PyArrow cache in the active update path.

If condition-search acceleration is restored later, Parquet should be a disposable/rebuildable analytical derivative of the MySQL SSOT. Normal minute collection and MySQL durability must not depend on that cache.

## Detachment

Removing this Add-on removes its minute schema/collector/import/access contract only. It must not alter the daily dataset or research semantics.

## Open evidence gaps

- historical delisted/unlisted universe coverage
- independent certification of corporate-action semantics beyond `adjusted=true`
- a verified long-horizon whole-market minute retention target is separate from routine incremental maintenance
- per-symbol freshness through the global latest date requires a stronger coverage audit than the simple status summary
