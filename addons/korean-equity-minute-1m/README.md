# korean-equity-minute-1m

Detachable Data Add-on for adjusted Korean equity exact 1-minute OHLCV + traded amount.

## Purpose

Provide one durable MySQL-backed 1-minute bar contract for exact intraday research, MFE/MAE, entry/exit timing, opening behavior, and Exact Chart Audit without depending on legacy experiment-project CSV paths.

## Source contract

- recovered provider: CYBOS Plus `CpSysDib.StockChart`
- interval: exact 1 minute
- recovered exchange selector: `A`
- recovered adjusted-price setting: `true`
- source fields: timestamp, open, high, low, close, volume, amount
- timestamp meaning: local Korea market wall-clock minute (`YYYY-MM-DDTHH:MM`), stored in MySQL as `DATETIME` without timezone conversion
- exact-time rule: no nearest-time repair and no synthetic timestamp repair

## MySQL contract

Primary data table: `korean_equity_minute_1m`

Instrument identity table: shared `market_instrument`

Ingestion evidence table: shared `data_ingestion_run`

Health view: `korean_equity_minute_1m_health`

Apply `schema.sql` before importing.

## Normal access

Use `access.sql` as canonical SQL examples. Consumers should depend on this table contract or a stable gateway, not on CYBOS, legacy research selection files, or CSV paths.

## Migration flow

```text
legacy 1m CSV archive
  -> validation/parser
  -> idempotent MySQL upsert
  -> korean_equity_minute_1m
  -> health check
```

The legacy CSV archive is migration input only. MySQL becomes the durable SSOT after verified import.

## Collector status

The recovered legacy minute updater is not promoted as the canonical Data Add-on updater yet because it is coupled to a historical 545-symbol research selection, stock-master hash, and NXT source-acceptance probe. Those research-selection semantics must not become a generic data-infrastructure contract. A generic minute collector should reuse only the provider/validation primitives and receive its symbol universe through a neutral data contract.

## Detachment

Removing this Add-on removes its minute schema/import/access contract only. It must not alter the daily dataset or research semantics.

## Open evidence gaps

- first full archive migration and coverage measurement
- generic incremental collector detached from historical research selection
- historical delisted/unlisted universe coverage
- independent certification of corporate-action semantics beyond recovered `adjusted=true`
