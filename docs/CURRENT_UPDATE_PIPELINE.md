# Current market-data update pipeline

> This file is the session-handoff document for the current updater architecture and operational state.
> Read it together with `README.md` and `docs/PYTHON_UI_BAR_API.md` before changing update logic.
>
> Logic baseline documented here: `fa5162f81b3b3e593e81c89d5791e3de72bd4bfb` and its ancestors.
> Documentation-only commits may follow that baseline.

## 1. Durable architecture

Market data is owned by `market-data-factory` and stored durably in MySQL. CSV files under `.runtime` are transport/staging material only.

The desktop UI must call the repository-root Python API rather than invoking collectors directly:

```text
RUN_MARKET_DATA_UI.bat
  -> 64-bit Python 3.13
  -> market_data_ui.py
  -> market_data_api.py
  -> dataset updater
  -> provider collector / importer
  -> MySQL
  -> status event back to UI
```

For daily/minute bars the concrete path is:

```text
market_data_ui.py
  -> market_data_api.update_data()/update_bars()
  -> node scripts/update-korean-equity-bars.mjs
  -> 32-bit CYBOS collector
  -> .runtime/cybos/bars-update/<type>/*.csv
  -> Node MySQL importer
  -> status()
  -> BAR_EVENT complete
```

`market_data_api.py` routes `market_cap` and `market_index` to their own updater scripts. UI code must not duplicate these routing rules.

## 2. Human entrypoints

### Interactive UI

```text
E:\market-data-factory\RUN_MARKET_DATA_UI.bat
```

The UI supports:

- daily
- minute
- market cap
- market index
- incremental update (`마지막 일자 이후`)
- full-range re-download/upsert (`선택 기간 전체 갱신`)
- status
- progress/log display
- cancellation

### Combined batch update

```text
E:\market-data-factory\UPDATE_MARKET_DATA.bat
```

This calls `npm run data:update`, currently:

```text
data:daily:update
  -> data:minute:update
  -> data:market-cap:update
  -> data:index:update
```

### Direct diagnostic commands

```powershell
npm run data:daily:update -- --end YYYY-MM-DD
npm run data:minute:update -- --end YYYY-MM-DD
npm run bars:update -- --type daily --mode full --start YYYY-MM-DD --end YYYY-MM-DD
npm run bars:status -- --type daily
npm run bars:status -- --type minute
```

Use direct commands for diagnostics or explicit maintenance; normal UI code still goes through `market_data_api.py`.

## 3. Shared daily/minute planner

`scripts/update-korean-equity-bars.mjs` is the shared daily/minute orchestrator.

### Universe

The planner reads every `market_instrument` row where:

```sql
instrument_type = 'EQUITY'
```

Accepted normalized equity codes are six characters matching:

```text
[0-9A-Z]{6}
```

This includes ordinary numeric codes such as `005930` and valid alphanumeric codes such as `0001A0`.

### Incremental mode

For each instrument independently:

```text
from = MAX(existing trading date for that instrument) + 1 calendar day
```

If an instrument has no rows:

- daily: fallback is the global earliest daily date; if the daily table is empty, `2021-01-01`
- minute: fallback is the global earliest minute date; if the minute table is empty, an explicit `--start` is required

The normal updater therefore resumes existing coverage. It is not a substitute for a separately defined long-horizon whole-market minute backfill.

### Full mode

For every EQUITY instrument:

```text
from = explicit --start
end  = explicit --end
```

Rows are upserted; the updater does not delete the existing table first.

### End-date guard

When an end date is not explicitly supplied, the shared updater uses KST:

- before 20:00 KST: previous calendar day is eligible
- at/after 20:00 KST: today is eligible

The provider-specific collector still determines which actual trading dates exist inside the requested period.

## 4. Daily source contract — do not change casually

The canonical daily source contract is:

```text
provider       = CYBOS Plus CpSysDib.StockChart
request mode   = period mode
period type    = daily (D)
exchange       = A  (ALL / integrated KRX + NXT)
adjusted       = true
fields         = date, open, high, low, close, volume, amount
storage        = one MySQL row per instrument/trading_date
```

### `exchange=A` is mandatory for the production daily dataset

Do not change the production daily updater to `K` as a workaround. Production daily bars must include NXT activity.

A live Samsung Electronics probe for `2026-09-04` confirmed distinct venue and integrated bars:

```text
A: open=251000 high=259000 low=251000 close=257000 volume=21429660 amount=5473432000000
K: open=254000 high=259000 low=252500 close=255500 volume=14031862 amount=3586126000000
N: open=251000 high=258750 low=251000 close=257000 volume=7397798  amount=1887305000000
```

`A.volume = K.volume + N.volume` for that probe, and the integrated open/close reflect the wider combined session. K-only daily data would therefore change production semantics.

### Holiday/weekend end-date duplicate behavior

CYBOS period-mode daily requests can return the last actual trading day twice when the requested final calendar date is a holiday/weekend.

Observed request:

```text
code=A005930
from=2021-01-04
to=2026-09-06  # Sunday
exchange=A
```

returned `2026-09-04` twice with every field identical.

Current rule in `cybos_daily_32.py`:

1. same date + every OHLCV/amount field identical -> collapse to one row
2. same date + any field differs -> fail immediately with `DUPLICATE_DATE_DRIFT`
3. data drift is a validation error, not a transport retry condition

Never implement first-row/last-row selection, aggregation, or K-only fallback for differing same-date rows without a new verified source contract.

### Latest trading date probe

Before per-symbol collection, the daily collector queries Samsung Electronics over the requested period and uses the last validated row as `target_end`.

For the Sunday `2026-09-06` run the resulting actual `target_end` was `2026-09-04`. The full requested period is intentional; it is not a pagination workaround.

### Permanent invalid symbols

CYBOS may raise `유효하지 않은 종목코드입니다.` for stale/delisted/provider-invalid master codes.

Current daily behavior:

- recognize this specific permanent symbol error
- do not retry it three times
- mark/log that symbol as `invalid`
- remove any transport-failure state for that attempt
- continue with later symbols
- do not weaken handling of transport errors or data-validation errors

At least `A269620` was directly observed producing the CYBOS invalid-code error during the 2026-09-06 run.

### Daily importer code identity

The importer and CSV filename parser accept normalized six-character alphanumeric codes:

```text
[0-9A-Z]{6}
```

This was fixed because the collector successfully created files such as `0001A0.csv`, but the old importer accepted only `\d{6}.csv` and silently excluded 31 collected files.

## 5. Minute source/update contract

The canonical 1-minute source contract remains:

```text
provider       = CYBOS Plus CpSysDib.StockChart
interval       = exact 1 minute
exchange       = A
adjusted       = true
storage time   = Korea market wall-clock DATETIME
```

The shared UI/updater currently plans against every six-character EQUITY instrument in `market_instrument`, using each instrument's own latest stored date in incremental mode.

For an instrument with no minute rows, normal incremental mode starts from the current minute table's global earliest date. It does not invent a longer historical horizon.

The dedicated command:

```powershell
npm run data:minute:backfill-all
```

is a separate explicit historical/backfill workflow. Keep that concern separate from routine UI incremental maintenance.

Minute collection already treats provider-invalid symbols as permanent symbol-level skips while keeping genuine transport/pagination/data-integrity errors fatal.

## 6. Import and MySQL ownership

Daily and minute staging files are generated under:

```text
.runtime/cybos/bars-update/daily
.runtime/cybos/bars-update/minute
```

The shared updater clears the relevant staging directory at the start of a non-dry run.

After collection:

1. find six-character `[0-9A-Z]{6}.csv` staging files
2. run the dataset importer
3. idempotently upsert into MySQL
4. query status
5. emit `BAR_EVENT complete`

MySQL is the durable SSOT. `.runtime` must be safe to recreate.

## 7. Status semantics

Daily/minute `status` emits:

```text
universe
instrumentsWithData
missingInstruments
earliestDate
latestDate
```

Important interpretation:

- `missingInstruments` means instruments with no row at all in that dataset.
- `missingInstruments=0` does **not** prove every instrument is current through `latestDate`.
- `latestDate` is the global maximum date, not a per-symbol coverage guarantee.

A future coverage audit should compare per-symbol latest dates when that stronger guarantee is required.

## 8. 2026-09-06 daily incident and current checkpoint

### Failures that were diagnosed and corrected

1. `DUPLICATE_DATE:2026-09-04`
   - cause: CYBOS daily period request ending on Sunday `2026-09-06` returned the Friday `2026-09-04` integrated bar twice, exactly identical
   - fix: collapse exact duplicates only; differing duplicates remain fatal

2. `A269620 ... 유효하지 않은 종목코드입니다.`
   - cause: provider-invalid symbol
   - fix: classify as permanent invalid symbol and continue instead of aborting the whole update

3. 31 daily files collected but not imported
   - cause: importer/filename parser assumed numeric-only `\d{6}` codes while the actual universe contains valid alphanumeric six-character codes
   - fix: normalize/accept `[0-9A-Z]{6}` and add regression coverage

### Last observed runtime before the alphanumeric importer fix was rerun

```text
[DAILY IMPORT] 2597/2597 rows=10388 inserted=10388 updated=0
[PASS] korean-equity-daily imported files=2597 rows=10388 inserted=10388 updated=0
BAR_EVENT {"event":"status","type":"daily","instrumentsWithData":2600,"universe":2631,"missingInstruments":31,"earliestDate":"2021-01-04","latestDate":"2026-09-04"}
BAR_EVENT {"event":"complete","type":"daily","mode":"incremental","updatedSymbols":2628}
```

Interpretation:

- collection/update flow completed rather than aborting
- actual latest trading date was `2026-09-04`
- 2628 staging CSV symbols were produced
- the importer processed only 2597 because of the numeric-only filename/code bug
- the exact 31-file difference matched `missingInstruments=31`

The alphanumeric importer fix is in logic baseline `fa5162f81b3b3e593e81c89d5791e3de72bd4bfb`.

**Pending verification:** rerun daily incremental after pulling that commit and confirm whether `missingInstruments` becomes `0`. Do not write documentation claiming `0` until the runtime result proves it.

## 9. Known open/non-data issues

### Duplicate daily progress events

`cybos_daily_32.py` currently contains duplicate progress instrumentation (duplicate `emit_progress` definition/calls), so some `collector_progress` lines are printed twice.

This is an instrumentation defect, not duplicate market data. Keep its cleanup in a separate small change from data-source or importer fixes.

### Python cache files

Local generated `__pycache__` directories have previously appeared as untracked files because Python cache patterns are not yet covered by `.gitignore`. Treat that as separate repository hygiene work.

### Parquet analytical cache

There is currently no Parquet/DuckDB/PyArrow analytical cache in the active repository update path.

If a condition-search acceleration layer is restored later:

- MySQL remains the durable SSOT
- Parquet must be disposable/rebuildable derived data
- do not make normal market-data collection depend on Parquet
- choose partitioning/features based on actual condition-search access patterns

## 10. Change-safety rules for future sessions

Do not solve update failures by changing data semantics.

Specifically:

- do not change production daily `exchange=A` to `K`
- do not reconstruct canonical daily bars from minute data as a silent substitute
- do not weaken duplicate/drift/OHLC validation to make a run pass
- do not convert genuine transport failures into ignored invalid-symbol skips
- do not mix the explicit whole-market minute historical backfill into routine incremental UI maintenance
- do not treat staging CSV or future Parquet files as the durable SSOT
- do not infer full per-symbol freshness from `missingInstruments=0` or the global `latestDate`

When a failure occurs, first classify it as data-contract, product code, test, authority/documentation, environment/transport, or unknown; preserve the existing source contract until evidence proves a contract change is required.

## 11. Verification sequence after updater changes

On the Windows/CYBOS host:

```powershell
Set-Location "E:\market-data-factory"
git pull --ff-only origin main
npm test
```

Then run the narrowest applicable update, for example:

```powershell
npm run data:daily:update -- --end 2026-09-06
```

For normal user operation after verification:

```text
RUN_MARKET_DATA_UI.bat
```

and use the UI's incremental/full controls. The UI should exercise the same corrected root API and shared updater rather than a separate implementation.
