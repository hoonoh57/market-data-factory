# market-data-factory

Shared market-data SSOT and Data Add-on factory.

The repository owns dataset contracts, collectors/updaters, schema migrations, access examples, integrity checks, and the Data Add-on catalog. Actual market data lives in MySQL rather than inside experiment-project folders.

## Normal update entrypoint

For routine maintenance, use the repository-root batch file:

```text
E:\market-data-factory\UPDATE_MARKET_DATA.bat
```

Double-clicking this file, or running it from a command prompt, updates the currently verified Korean equity daily and 1-minute datasets through the stable `npm run data:update` entrypoint.

Normal verified sequence:

```text
daily update
  -> before 20:00 KST: today's unfinished daily bar is excluded
  -> refresh only completed daily bars
  -> MySQL upsert + health check

minute update
  -> before 20:00 KST: today's unfinished session is excluded, but older missing completed sessions are still caught up
  -> at/after 20:00 KST: today's completed session becomes eligible
  -> target universe: current KRX300 + stocks with >=15% close-to-close gain on any of the most recent 20 completed trading days
  -> existing minute symbols: start at each symbol's MAX(trading_date) + 1 day
  -> newly selected minute symbols: recent 6-month backfill ending at the latest completed session
  -> MySQL upsert + health check
```

The batch file pauses at the end so success/failure remains visible. Internal update scripts may change over time; `UPDATE_MARKET_DATA.bat` is the durable human-facing entrypoint.

Equivalent command-line entrypoint:

```powershell
Set-Location "E:\market-data-factory"
npm run data:update
```

## KOSPI/KOSDAQ benchmark add-on

The `korean-market-index` add-on provides official benchmark candles for:

- `U001`: KOSPI
- `U201`: KOSDAQ

It stores both `market_index_daily` and `market_index_minute_1m` with decimal index levels. Its completed-session policy is the same as the equity minute updater: before 20:00 KST today is excluded but older completed gaps remain catch-up eligible; at/after 20:00 KST today becomes eligible.

The add-on is implemented but remains live-verification pending. It is intentionally **not yet wired into `npm run data:update`** until its first Windows/CYBOS backfill and health check pass.

First verification sequence:

```powershell
Set-Location "E:\market-data-factory"
git pull --ff-only origin main
npm test
npm run data:index:schema
npm run data:index:update
npm run data:index:check
```

On first population, index daily history starts from the earliest date in `korean_equity_daily`; index 1-minute history starts from the earliest date in `korean_equity_minute_1m`. After that, U001 and U201 each resume from their own `MAX(trading_date) + 1 day`.

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

## First Data Add-on: korean-equity-daily

The first detachable Data Add-on recovers the existing CYBOS adjusted daily-bar pipeline and promotes MySQL to the durable SSOT.

Apply its schema once:

```powershell
npm run data:daily:schema
```

Migrate the existing legacy archive once, without copying it into this repository:

```powershell
npm run data:daily:import -- --source "E:\2026\opus\typescript\kiwoom-autotrade-cleanroom-wysiwyg\data\cybos\daily"
npm run data:daily:check
```

After the initial migration, normal incremental updates are owned here. Prefer `UPDATE_MARKET_DATA.bat` for routine operation. The lower-level daily-only command remains available when specifically needed:

```powershell
npm run data:daily:update
```

`data:daily:update` runs the recovered 32-bit CYBOS collector into ignored `.runtime` staging, imports/upserts those validated rows into MySQL, then runs the dataset health check. Set `CYBOS_PYTHON32` if the 32-bit Python executable is not `E:\Python310-32\python.exe`. Set `CYBOS_DAILY_STAGING_DIR` only when an alternate transient staging location is required.

The canonical table/query contract is documented under `addons/korean-equity-daily/`. Consumers should use MySQL or a stable gateway and must not depend on the transient staging path or CYBOS internals.

## Data Add-on rule

Each dataset is a detachable Data Add-on. A Data Add-on owns its source contract, schema/migrations, ingestion/update logic, quality checks, canonical access SQL/examples, and current state. Consumers discover datasets through `catalog/datasets.json` rather than searching old experiment repositories for CSV files or updater scripts.

Git stores the contracts and executable ingestion logic. MySQL stores the durable data. `.runtime` contains only disposable transport/staging material.
