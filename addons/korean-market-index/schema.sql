CREATE TABLE IF NOT EXISTS market_index_daily (
  index_code VARCHAR(10) NOT NULL,
  trading_date DATE NOT NULL,
  open DECIMAL(18,6) NOT NULL,
  high DECIMAL(18,6) NOT NULL,
  low DECIMAL(18,6) NOT NULL,
  close DECIMAL(18,6) NOT NULL,
  volume BIGINT UNSIGNED NOT NULL DEFAULT 0,
  source_provider VARCHAR(32) NOT NULL,
  ingested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (index_code, trading_date),
  KEY idx_market_index_daily_date (trading_date, index_code)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS market_index_minute_1m (
  index_code VARCHAR(10) NOT NULL,
  bar_timestamp DATETIME NOT NULL,
  trading_date DATE NOT NULL,
  open DECIMAL(18,6) NOT NULL,
  high DECIMAL(18,6) NOT NULL,
  low DECIMAL(18,6) NOT NULL,
  close DECIMAL(18,6) NOT NULL,
  volume BIGINT UNSIGNED NOT NULL DEFAULT 0,
  source_provider VARCHAR(32) NOT NULL,
  ingested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (index_code, bar_timestamp),
  KEY idx_market_index_minute_1m_date (trading_date, index_code),
  KEY idx_market_index_minute_1m_timestamp (bar_timestamp)
) ENGINE=InnoDB;

CREATE OR REPLACE VIEW market_index_daily_health AS
SELECT
  COUNT(*) AS row_count,
  COUNT(DISTINCT index_code) AS index_count,
  DATE_FORMAT(MIN(trading_date), '%Y-%m-%d') AS earliest_trading_date,
  DATE_FORMAT(MAX(trading_date), '%Y-%m-%d') AS latest_trading_date
FROM market_index_daily;

CREATE OR REPLACE VIEW market_index_minute_1m_health AS
SELECT
  COUNT(*) AS row_count,
  COUNT(DISTINCT index_code) AS index_count,
  DATE_FORMAT(MIN(bar_timestamp), '%Y-%m-%d %H:%i:%s') AS earliest_bar_timestamp,
  DATE_FORMAT(MAX(bar_timestamp), '%Y-%m-%d %H:%i:%s') AS latest_bar_timestamp,
  DATE_FORMAT(MIN(trading_date), '%Y-%m-%d') AS earliest_trading_date,
  DATE_FORMAT(MAX(trading_date), '%Y-%m-%d') AS latest_trading_date
FROM market_index_minute_1m;
