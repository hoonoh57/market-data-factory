# korean-market-index

Detachable Data Add-on for official Korean market benchmark series used by research and performance comparison.

## Scope

Canonical index codes:

- `U001`: KOSPI
- `U201`: KOSDAQ

Provider: CYBOS Plus `CpSysDib.StockChart`.

The add-on stores both daily and exact 1-minute index candles. Index levels are stored as decimals rather than coerced to stock-price integers.

## MySQL contract

Daily table: `market_index_daily`

1-minute table: `market_index_minute_1m`

Health views:

- `market_index_daily_health`
- `market_index_minute_1m_health`

The minute timestamp is stored as Korea market wall-clock `DATETIME` without timezone conversion. Live data begins at `09:01` and is operated as end-stamped minute data for completed-bar alignment.

## Incremental update contract

Normal standalone command after first schema application:

```powershell
npm run data:index:update
```

Rules:

1. Before 20:00 KST, today's unfinished session is excluded; older missing completed sessions remain eligible for catch-up.
2. At or after 20:00 KST, today's completed session becomes eligible.
3. The effective session end is the latest completed `korean_equity_daily.trading_date` on or before the eligible calendar date.
4. On first population, index daily history starts from the earliest date present in `korean_equity_daily`.
5. On first population, index 1-minute history starts from the earliest date present in `korean_equity_minute_1m`.
6. After initial population, each index resumes independently from its own `MAX(trading_date) + 1 day`.
7. Import is idempotent via primary-key upsert, followed by a health check.

`--skip-daily-refresh` is supported for the repository-wide orchestrator after completed equity daily data has already been refreshed.

## First-time bootstrap

```powershell
npm run data:index:schema
npm run data:index:update
```

## Research use

For `[1516]`-style forward performance comparison, use the benchmark matching the stock's market. Compare from the same completed intraday timestamp as the stock entry, then evaluate the same 5/10/20/60 future trading-day horizons. Do not substitute the selectively stored equity-minute universe as the market benchmark.

## Verification state

**LIVE VERIFIED / ACTIVE** on 2026-08-27:

- unit tests: 26/26 PASS
- schema application: PASS
- updater: PASS with session `2026-08-27`, `U001,U201`
- daily rows: `2,770`, range `2021-01-04..2026-08-27`
- minute rows: `99,998`, range `2026-02-23 09:01:00..2026-08-27 15:45:00`
- health check: PASS

Machine-readable evidence is stored in `VERIFIED_RESULTS.json`.
