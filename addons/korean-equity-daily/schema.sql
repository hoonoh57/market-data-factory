CREATE TABLE IF NOT EXISTS market_instrument (
  instrument_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code VARCHAR(16) NOT NULL,
  name VARCHAR(255) NULL,
  market VARCHAR(32) NULL,
  instrument_type VARCHAR(32) NOT NULL DEFAULT 'EQUITY',
  first_seen_date DATE NULL,
  last_seen_date DATE NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (instrument_id),
  UNIQUE KEY uq_market_instrument_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS data_ingestion_run (
  run_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  dataset_id VARCHAR(128) NOT NULL,
  source_provider VARCHAR(64) NOT NULL,
  source_location VARCHAR(1024) NULL,
  started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP NULL,
  rows_read BIGINT UNSIGNED NOT NULL DEFAULT 0,
  rows_inserted BIGINT UNSIGNED NOT NULL DEFAULT 0,
  rows_updated BIGINT UNSIGNED NOT NULL DEFAULT 0,
  files_processed INT UNSIGNED NOT NULL DEFAULT 0,
  status ENUM('RUNNING','PASS','FAIL') NOT NULL DEFAULT 'RUNNING',
  error_message TEXT NULL,
  PRIMARY KEY (run_id),
  KEY ix_ingestion_dataset_started (dataset_id, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS korean_equity_daily (
  instrument_id BIGINT UNSIGNED NOT NULL,
  trading_date DATE NOT NULL,
  open BIGINT UNSIGNED NOT NULL,
  high BIGINT UNSIGNED NOT NULL,
  low BIGINT UNSIGNED NOT NULL,
  close BIGINT UNSIGNED NOT NULL,
  volume BIGINT UNSIGNED NOT NULL,
  amount BIGINT UNSIGNED NOT NULL,
  adjusted BOOLEAN NOT NULL DEFAULT TRUE,
  source_provider VARCHAR(64) NOT NULL DEFAULT 'CYBOS',
  source_updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (instrument_id, trading_date),
  KEY ix_korean_equity_daily_date (trading_date, instrument_id),
  CONSTRAINT fk_korean_equity_daily_instrument
    FOREIGN KEY (instrument_id) REFERENCES market_instrument(instrument_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE OR REPLACE VIEW korean_equity_daily_health AS
SELECT
  COUNT(*) AS row_count,
  COUNT(DISTINCT instrument_id) AS instrument_count,
  MIN(trading_date) AS earliest_trading_date,
  MAX(trading_date) AS latest_trading_date,
  MAX(source_updated_at) AS latest_source_update_at
FROM korean_equity_daily;
