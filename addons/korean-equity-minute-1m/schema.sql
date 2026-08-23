CREATE TABLE IF NOT EXISTS korean_equity_minute_1m (
  instrument_id BIGINT UNSIGNED NOT NULL,
  bar_timestamp DATETIME NOT NULL,
  trading_date DATE NOT NULL,
  open BIGINT NOT NULL,
  high BIGINT NOT NULL,
  low BIGINT NOT NULL,
  close BIGINT NOT NULL,
  volume BIGINT UNSIGNED NOT NULL,
  amount BIGINT UNSIGNED NOT NULL,
  adjusted BOOLEAN NOT NULL DEFAULT TRUE,
  source_provider VARCHAR(32) NOT NULL,
  ingested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (instrument_id, bar_timestamp),
  KEY idx_korean_equity_minute_1m_date (trading_date, instrument_id),
  KEY idx_korean_equity_minute_1m_timestamp (bar_timestamp)
) ENGINE=InnoDB;

CREATE OR REPLACE VIEW korean_equity_minute_1m_health AS
SELECT
  COUNT(*) AS row_count,
  COUNT(DISTINCT instrument_id) AS instrument_count,
  DATE_FORMAT(MIN(bar_timestamp), '%Y-%m-%d %H:%i:%s') AS earliest_bar_timestamp,
  DATE_FORMAT(MAX(bar_timestamp), '%Y-%m-%d %H:%i:%s') AS latest_bar_timestamp,
  DATE_FORMAT(MIN(trading_date), '%Y-%m-%d') AS earliest_trading_date,
  DATE_FORMAT(MAX(trading_date), '%Y-%m-%d') AS latest_trading_date
FROM korean_equity_minute_1m;
