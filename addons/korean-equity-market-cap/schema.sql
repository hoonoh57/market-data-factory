CREATE TABLE IF NOT EXISTS korean_equity_market_cap (
  instrument_id BIGINT UNSIGNED NOT NULL,
  trading_date DATE NOT NULL,
  listed_shares BIGINT UNSIGNED NOT NULL,
  market_cap BIGINT UNSIGNED NOT NULL,
  source_provider VARCHAR(32) NOT NULL DEFAULT 'KRX',
  source_updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (instrument_id, trading_date),
  KEY idx_korean_equity_market_cap_date (trading_date, instrument_id),
  CONSTRAINT fk_korean_equity_market_cap_instrument
    FOREIGN KEY (instrument_id) REFERENCES market_instrument(instrument_id)
) ENGINE=InnoDB;
