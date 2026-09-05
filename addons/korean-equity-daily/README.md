# korean-equity-daily

Detachable Data Add-on for adjusted Korean equity daily OHLCV + traded amount.

## Purpose

Provide one durable MySQL-backed daily-bar contract for research projects so they do not rediscover old CSV folders or rebuild download/update logic.

## Source contract

- provider: CYBOS Plus `CpSysDib.StockChart`
- instrument scope: regular KOSPI/KOSDAQ equities returned by `CpCodeMgr`
- SPAC: excluded by provider metadata, not name heuristics
- exchange selector: `A`
- adjusted price: `true`
- source fields: date, open, high, low, close, volume, amount
- current recovered collection start: 2021-01-01
- completed-session guard: requests for `today` stop at the previous day before 20:00 KST

## MySQL contract

Primary data table: `korean_equity_daily`

Instrument identity table: `market_instrument`

Ingestion evidence table: `data_ingestion_run`

Health view: `korean_equity_daily_health`

Apply `schema.sql` before importing.

## Verified current coverage

User-local MySQL migration and health verification on 2026-08-24 established:

- status: `ACTIVE`
- instruments: 2,599
- rows: 3,299,454
- trading-date range: 2021-01-04 through 2026-08-21
- initial migration: 3,299,454 inserted / 0 updated

Machine-readable evidence is in `VERIFIED_RESULTS.json`.

## Normal access

Use `access.sql` as canonical SQL examples. Consumers should depend on this table contract or a stable gateway, not on CYBOS, collector internals, or CSV paths.

## Update flow

```text
CYBOS 32-bit collector
  -> validated staging CSV
  -> Node MySQL importer
  -> korean_equity_daily
  -> quality/health check
```

The staging CSV is transport material, not the long-term SSOT. MySQL is the durable data SSOT.

## Detachment

Removing this Add-on removes its schema/collector/import/access contract only. It must not change unrelated datasets or research semantics.

## Open evidence gaps

- historical delisted/unlisted universe coverage is not yet proven
- corporate-action semantics beyond recovered `adjusted=true` provider setting are not independently certified
