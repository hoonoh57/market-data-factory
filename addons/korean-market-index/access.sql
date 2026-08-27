-- Latest KOSPI daily rows
SELECT trading_date, open, high, low, close, volume
FROM market_index_daily
WHERE index_code = 'U001'
ORDER BY trading_date DESC
LIMIT 20;

-- Exact KOSDAQ 1-minute rows for one completed session
SELECT bar_timestamp, open, high, low, close, volume
FROM market_index_minute_1m
WHERE index_code = 'U201'
  AND trading_date = '2026-08-26'
ORDER BY bar_timestamp;

-- Last completed benchmark minute at or before a search timestamp
SELECT bar_timestamp, close
FROM market_index_minute_1m
WHERE index_code = 'U001'
  AND bar_timestamp <= '2026-08-26 13:00:00'
ORDER BY bar_timestamp DESC
LIMIT 1;

-- Future daily closes strictly after the signal date
SELECT trading_date, close
FROM market_index_daily
WHERE index_code = 'U001'
  AND trading_date > '2026-05-15'
ORDER BY trading_date ASC
LIMIT 60;
