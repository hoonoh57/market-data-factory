# market-data-factory

> Python UI에서 일봉·분봉을 호출할 때는 기존 collector/importer를 조합하지 말고
> 루트의 `market_data_api.py`만 사용한다. 전체 갱신, 증분 갱신, 상태조회와
> 진행 이벤트 규격은 [`docs/PYTHON_UI_BAR_API.md`](docs/PYTHON_UI_BAR_API.md)에 정의되어 있다.
>
> 현재 실제 updater 구조, 2026-09-06 일봉 장애 교정 내용, 검증 대기 항목 및 변경 금지사항은
> [`docs/CURRENT_UPDATE_PIPELINE.md`](docs/CURRENT_UPDATE_PIPELINE.md)를 세션 시작 시 먼저 확인한다.

Shared market-data SSOT and Data Add-on factory.

The repository owns dataset contracts, collectors/updaters, schema migrations, access examples, integrity checks, and the Data Add-on catalog. Actual market data lives in MySQL rather than inside experiment-project folders.

## Interactive UI entrypoint

For normal interactive operation, use:

```text
E:\market-data-factory\RUN_MARKET_DATA_UI.bat
```

The batch launches the 64-bit Python UI. The UI calls only `market_data_api.py`; daily/minute requests are routed through the shared Node bar updater and the 32-bit CYBOS collectors.

Current UI choices are daily, minute, market cap, market index, incremental update, full-range re-download/upsert, status, progress, logs, and cancellation.

## Combined batch update entrypoint

For non-interactive routine maintenance, use:

```text
E:\market-data-factory\UPDATE_MARKET_DATA.bat
```

This invokes the stable `npm run data:update` chain:

```text
daily
  -> minute
  -> market cap
  -> market index
```

Current daily/minute shared planner behavior:

```text
universe
  -> every market_instrument row with instrument_type='EQUITY'
  -> normalized six-character code [0-9A-Z]{6}

incremental
  -> each symbol resumes from its own MAX(stored trading date) + 1 calendar day
  -> daily symbol with no rows falls back to global earliest daily date, or 2021-01-01 if empty
  -> minute symbol with no rows falls back to global earliest minute date
  -> if the minute table itself is empty, an explicit start date is required

full
  -> explicit start..end for every EQUITY instrument
  -> existing rows are upserted rather than deleted first

completed-session boundary
  -> when no explicit end is supplied, before 20:00 KST uses the previous calendar day
  -> at/after 20:00 KST today becomes eligible
  -> provider data determines which actual trading dates exist inside that period
```

Daily production bars use CYBOS `CpSysDib.StockChart`, period-mode daily requests, `exchange=A` (integrated KRX+NXT), and `adjusted=true`. Do not change the production daily dataset to KRX-only as an error workaround.

The dedicated all-symbol minute historical backfill command remains separate from normal incremental maintenance:

```powershell
npm run data:minute:backfill-all
```

The batch file pauses at the end so success/failure remains visible. Internal update scripts may change over time; the root UI/API and package entrypoints are the durable interfaces.

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
KRX_AUTH_KEY=<KRX Open API authentication key>
```

`MYSQL_DATABASE` is optional and defaults to `market_data` when omitted. `MYSQL_URL` is also supported as an optional override for environments that prefer a single connection URL.

`.env` is intentionally ignored by Git and must never be committed. Application code must obtain the connection through `src/db/mysql.mjs`; Data Add-ons must not duplicate credentials or hard-code host/user/password values.

`KRX_AUTH_KEY` is required only for market-cap collection. The collector uses the official KRX Open API and does not use a KRX website ID/password or `pykrx`. The KOSPI and KOSDAQ daily-trading API services must be approved for the key.

## Bootstrap / verification

```powershell
Set-Location "E:\market-data-factory"
git pull --ff-only origin main
npm install
npm test
npm run db:check
```

After updater changes, run the narrowest applicable real-data command on the Windows/CYBOS host before declaring the runtime state verified.

## Korean equity daily Data Add-on

Apply its schema once:

```powershell
npm run data:daily:schema
```

The lower-level daily-only command remains available when specifically needed:

```powershell
npm run data:daily:update
```

Current source/edge-case details are documented in `addons/korean-equity-daily/README.md` and `docs/CURRENT_UPDATE_PIPELINE.md`.

## Korean equity 1-minute Data Add-on

Apply its schema once:

```powershell
npm run data:minute:schema
```

Standalone incremental update:

```powershell
npm run data:minute:update
```

Normal shared UI/update maintenance and explicit long-horizon whole-market backfill are separate concerns. See `addons/korean-equity-minute-1m/README.md`.

## Status semantics

Daily/minute status exposes `universe`, `instrumentsWithData`, `missingInstruments`, `earliestDate`, and `latestDate`.

`missingInstruments=0` only means every EQUITY instrument has at least one row. It does not prove that every instrument is current through the global `latestDate`; use a per-symbol coverage audit when that stronger guarantee is required.

## Storage ownership

MySQL is the durable market-data SSOT.

`.runtime` contains disposable collector/importer transport material only. There is currently no active Parquet analytical-cache layer in the update path. If one is restored for condition-search acceleration, it must remain rebuildable derived data rather than a second SSOT.

## Data Add-on rule

Each dataset is a detachable Data Add-on. A Data Add-on owns its source contract, schema/migrations, ingestion/update logic, quality checks, canonical access SQL/examples, and current state. Consumers discover datasets through `catalog/datasets.json` rather than searching old experiment repositories for CSV files or updater scripts.

Git stores the contracts and executable ingestion logic. MySQL stores the durable data. `.runtime` contains only disposable transport/staging material.
