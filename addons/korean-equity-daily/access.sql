-- Latest dataset health.
SELECT * FROM korean_equity_daily_health;

-- One symbol by code and date range.
SELECT
  i.code,
  i.name,
  i.market,
  d.trading_date,
  d.open,
  d.high,
  d.low,
  d.close,
  d.volume,
  d.amount,
  d.adjusted
FROM korean_equity_daily d
JOIN market_instrument i ON i.instrument_id = d.instrument_id
WHERE i.code = ?
  AND d.trading_date BETWEEN ? AND ?
ORDER BY d.trading_date;

-- Point-in-time lookback ending strictly before a decision date.
SELECT
  d.trading_date,
  d.open,
  d.high,
  d.low,
  d.close,
  d.volume,
  d.amount
FROM korean_equity_daily d
JOIN market_instrument i ON i.instrument_id = d.instrument_id
WHERE i.code = ?
  AND d.trading_date < ?
ORDER BY d.trading_date DESC
LIMIT ?;

-- Cross-sectional daily snapshot for one date.
SELECT
  i.code,
  i.name,
  i.market,
  d.open,
  d.high,
  d.low,
  d.close,
  d.volume,
  d.amount
FROM korean_equity_daily d
JOIN market_instrument i ON i.instrument_id = d.instrument_id
WHERE d.trading_date = ?
ORDER BY i.code;
