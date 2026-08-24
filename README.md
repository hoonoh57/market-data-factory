# market-data-factory

Shared market-data SSOT and Data Add-on factory.

The repository owns dataset contracts, collectors/updaters, schema migrations, access examples, integrity checks, and the Data Add-on catalog. Actual market data lives in MySQL rather than inside experiment-project folders.

## Normal update entrypoint

For routine maintenance, use the repository-root batch file:

```text
E:\market-data-factory\UPDATE_MARKET_DATA.bat
```

Double-clicking this file, or running it from a command prompt, updates both Korean equity daily data and 1-minute data through the stable `npm run data:update` entrypoint.

Normal sequence:

```text
daily update
  -> refresh completed daily bars
  -> MySQL upsert + health check

minute update
  -> before 20:00 KST: current trading session is skipped safely
  -> after a completed session: KRX300 + stocks up >=15% versus previous close
  -> new minute symbols: recent 6-month backfill
  -> existing minute symbols: incremental update
  -> MySQL upsert + health check
```

The batch file pauses at the end so success/failure remains visible. Internal update scripts may change over time; `UPDATE_MARKET_DATA.bat` is the durable human-facing entrypoint.

Equivalent command-line entrypoint:

```powershell
Set-Location "E:\market-data-factory"
npm run data:update
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
