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

The minute timestamp is stored as Korea market wall-clock `DATETIME` without timezone conversion, matching the repository's Korean equity minute convention.

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

`--skip-daily-refresh` is supported for an orchestrator that already refreshed completed equity daily data.

## First-time bootstrap

```powershell
npm run data:index:schema
npm run data:index:update
```

The first run can be substantially longer because it backfills daily history and the available 1-minute research horizon for both indexes.

## Research use

For `[1516]`-style forward performance comparison, use the benchmark matching the stock's market when that mapping is known. Compare from the same completed intraday timestamp as the stock entry, then evaluate the same 5/10/20/60 future trading-day horizons. Do not substitute the selectively stored equity-minute universe as the market benchmark.

## Verification state

Implementation is present, but the add-on remains **LIVE VERIFICATION PENDING** until schema application, unit tests, CYBOS backfill, import, and health checks pass on the Windows/CYBOS host.
