# korean-equity-minute-1m

Detachable Data Add-on for adjusted Korean equity exact 1-minute OHLCV + traded amount.

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

The dataset is ACTIVE for its verified coverage. This does not imply whole-market or survivorship-safe historical coverage.

## Normal access

Use `access.sql` as canonical SQL examples. Consumers should depend on this table contract or a stable gateway, not on CYBOS, old experiment folders, or frozen research-selection files.

## Incremental update contract

Normal command:

```powershell
npm run data:minute:update
```

Default behavior:

1. Before 20:00 KST, the command safely skips because the current market session is incomplete.
2. After the completed session, it first refreshes `korean-equity-daily` so the selection uses the latest completed daily bars.
3. It fetches the canonical stock master and selects the current KRX300 300-member basket.
4. It computes all stocks whose latest completed daily close is at least 15% above the previous trading day's close.
5. The minute target universe is `KRX300 UNION daily +15% movers`.
6. For a target already present in `korean_equity_minute_1m`, collection starts after that instrument's own latest stored trading date.
7. For a newly selected target, collection backfills six months ending at the completed session date.
8. Staged CSV is validated and idempotently upserted into MySQL, then the minute health check runs.

This dynamic universe is a data-maintenance coverage policy. It is not a frozen research cohort and must not be treated as research evidence by itself.

## Migration flow

```text
legacy 1m CSV archive
  -> validation/parser
  -> idempotent MySQL upsert
  -> korean_equity_minute_1m
  -> health check
```

The legacy CSV archive is migration input only. MySQL is now the durable SSOT for the verified imported coverage.

## Detachment

Removing this Add-on removes its minute schema/collector/import/access contract only. It must not alter the daily dataset or research semantics.

## Open evidence gaps

- live verification of the new incremental update command after a completed market session
- historical delisted/unlisted universe coverage
- independent certification of corporate-action semantics beyond `adjusted=true`
