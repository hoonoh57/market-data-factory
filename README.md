# market-data-factory

Shared market-data SSOT and Data Add-on factory.

The repository owns dataset contracts, collectors/updaters, schema migrations, access examples, integrity checks, and the Data Add-on catalog. Actual market data lives in MySQL rather than inside experiment-project folders.

## Normal update entrypoint

For routine maintenance, use the repository-root batch file:

```text
E:\market-data-factory\UPDATE_MARKET_DATA.bat
```

Double-clicking this file, or running it from a command prompt, updates the verified Korean equity daily, selective 1-minute equity, and official KOSPI/KOSDAQ index datasets through the stable `npm run data:update` entrypoint.

Normal verified sequence:

```text
daily update
  -> before 20:00 KST: today's unfinished daily bar is excluded
  -> refresh only completed daily bars
  -> MySQL upsert + health check

minute equity update
  -> before 20:00 KST: today's unfinished session is excluded, but older missing completed sessions are still caught up
  -> at/after 20:00 KST: today's completed session becomes eligible
  -> target universe: current KRX300 + stocks with >=15% close-to-close gain on any of the most recent 20 completed trading days
  -> existing minute symbols: start at each symbol's MAX(trading_date) + 1 day
  -> newly selected minute symbols: recent 6-month backfill ending at the latest completed session
  -> MySQL upsert + health check

market index update
  -> U001=KOSPI, U201=KOSDAQ
  -> same completed-session guard
  -> U001/U201 each resume from own MAX(trading_date) + 1 day
  -> daily + exact end-stamped 1-minute series
  -> MySQL upsert + health check
```

The combined orchestrator was verified on the Windows/CYBOS host on 2026-08-28 with 32-bit Python and an active `CpUtil.CpCybos` connection. `npm run data:update` completed successfully through daily + minute + market-index. Before 20:00 KST, the same run keeps the current unfinished session excluded while still allowing completed historical catch-up.

The batch file pauses at the end so success/failure remains visible. Internal update scripts may change over time; `UPDATE_MARKET_DATA.bat` is the durable human-facing entrypoint.

Equivalent command-line entrypoint:

```powershell
Set-Location "E:\market-data-factory"
npm run data:update
```

## KOSPI/KOSDAQ benchmark add-on

The active `korean-market-index` add-on provides official benchmark candles for:

- `U001`: KOSPI
- `U201`: KOSDAQ

It stores `market_index_daily` and `market_index_minute_1m` with decimal index levels. Its completed-session policy is the same as the equity update boundary: before 20:00 KST today is excluded but older completed gaps remain catch-up eligible; at/after 20:00 KST today becomes eligible.

Live verification on 2026-08-27 passed with daily range `2021-01-04..2026-08-27` and minute range `2026-02-23 09:01:00..2026-08-27 15:45:00`. Machine-readable evidence is in `addons/korean-market-index/VERIFIED_RESULTS.json`.

Standalone commands remain available:

```powershell
npm run data:index:schema
npm run data:index:update
npm run data:index:check
```

## Local MySQL configuration

Create `E:\market-data-factory\.env` and keep the existing split MySQL settings:

```dotenv
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=<real password>
MYSQL_DATABASE=market_data
```

`MYSQL_DATABASE` is optional and defaults to `market_data` when omitted. `MYSQL_URL` is also supported as an optional override for environments that prefer a single connection URL.

`.env` is intentionally ignored by Git and must never be committed. Application code must obtain the connection through `src/db/mysql.mjs`; Data Add-ons must not duplicate credentials or hard-code host/user/password values.

## Bootstrap / verification

```powershell
Set-Location "E:\market-data-factory"
git pull --ff-only origin main
npm install
npm test
npm run db:check
```

## Korean equity daily Data Add-on

Apply its schema once:

```powershell
npm run data:daily:schema
```

The lower-level daily-only command remains available when specifically needed:

```powershell
npm run data:daily:update
```

## Korean equity 1-minute Data Add-on

Apply its schema once:

```powershell
npm run data:minute:schema
```

Standalone update:

```powershell
npm run data:minute:update
```

Its storage universe is deliberately selective and must not be used as a market benchmark.

## Data Add-on rule

Each dataset is a detachable Data Add-on. A Data Add-on owns its source contract, schema/migrations, ingestion/update logic, quality checks, canonical access SQL/examples, and current state. Consumers discover datasets through `catalog/datasets.json` rather than searching old experiment repositories for CSV files or updater scripts.

Git stores the contracts and executable ingestion logic. MySQL stores the durable data. `.runtime` contains only disposable transport/staging material.
