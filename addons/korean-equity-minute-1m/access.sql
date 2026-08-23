-- Exact 1-minute bars for one instrument and one trading date.
SELECT
  i.code,
  DATE_FORMAT(m.bar_timestamp, '%Y-%m-%dT%H:%i') AS timestamp,
  m.open,
  m.high,
  m.low,
  m.close,
  m.volume,
  m.amount
FROM korean_equity_minute_1m m
JOIN market_instrument i ON i.instrument_id = m.instrument_id
WHERE i.code = ?
  AND m.trading_date = ?
ORDER BY m.bar_timestamp;

-- Exact interval; no nearest-time repair.
SELECT
  DATE_FORMAT(m.bar_timestamp, '%Y-%m-%dT%H:%i') AS timestamp,
  m.open,
  m.high,
  m.low,
  m.close,
  m.volume,
  m.amount
FROM korean_equity_minute_1m m
JOIN market_instrument i ON i.instrument_id = m.instrument_id
WHERE i.code = ?
  AND m.bar_timestamp BETWEEN ? AND ?
ORDER BY m.bar_timestamp;

-- Exact single minute lookup. Zero rows means missing; consumers must not substitute a nearby minute.
SELECT
  m.open, m.high, m.low, m.close, m.volume, m.amount
FROM korean_equity_minute_1m m
JOIN market_instrument i ON i.instrument_id = m.instrument_id
WHERE i.code = ?
  AND m.bar_timestamp = ?;
