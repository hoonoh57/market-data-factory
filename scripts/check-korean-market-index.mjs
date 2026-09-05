import { createMySqlPool } from '../src/db/mysql.mjs';
import { INDEX_CODES } from '../src/data/marketIndexCsv.mjs';

const pool = createMySqlPool();

try {
  const [[daily]] = await pool.query(
    `SELECT COUNT(*) AS row_count,
            COUNT(DISTINCT index_code) AS index_count,
            DATE_FORMAT(MIN(trading_date), '%Y-%m-%d') AS earliest_date,
            DATE_FORMAT(MAX(trading_date), '%Y-%m-%d') AS latest_date
     FROM market_index_daily
     WHERE index_code IN (?)`,
    [INDEX_CODES],
  );
  const [[minute]] = await pool.query(
    `SELECT COUNT(*) AS row_count,
            COUNT(DISTINCT index_code) AS index_count,
            DATE_FORMAT(MIN(bar_timestamp), '%Y-%m-%d %H:%i:%s') AS earliest_ts,
            DATE_FORMAT(MAX(bar_timestamp), '%Y-%m-%d %H:%i:%s') AS latest_ts,
            SUM(CASE WHEN trading_date <> DATE(bar_timestamp) THEN 1 ELSE 0 END) AS date_mismatch_count
     FROM market_index_minute_1m
     WHERE index_code IN (?)`,
    [INDEX_CODES],
  );
  const [codes] = await pool.query(
    `SELECT index_code,
            (SELECT COUNT(*) FROM market_index_daily d WHERE d.index_code=i.index_code) AS daily_rows,
            (SELECT COUNT(*) FROM market_index_minute_1m m WHERE m.index_code=i.index_code) AS minute_rows
     FROM (SELECT ? AS index_code UNION ALL SELECT ?) i
     ORDER BY index_code`,
    INDEX_CODES,
  );
  const [[invalidDaily]] = await pool.query(
    `SELECT COUNT(*) AS invalid_count
     FROM market_index_daily
     WHERE index_code IN (?)
       AND (open <= 0 OR high <= 0 OR low <= 0 OR close <= 0
        OR high < GREATEST(open, high, low, close)
        OR low > LEAST(open, high, low, close))`,
    [INDEX_CODES],
  );
  const [[invalidMinute]] = await pool.query(
    `SELECT COUNT(*) AS invalid_count
     FROM market_index_minute_1m
     WHERE index_code IN (?)
       AND (open <= 0 OR high <= 0 OR low <= 0 OR close <= 0
        OR high < GREATEST(open, high, low, close)
        OR low > LEAST(open, high, low, close))`,
    [INDEX_CODES],
  );

  if (Number(daily?.row_count ?? 0) <= 0) throw new Error('market_index_daily is empty.');
  if (Number(minute?.row_count ?? 0) <= 0) throw new Error('market_index_minute_1m is empty.');
  if (Number(daily?.index_count ?? 0) !== INDEX_CODES.length) throw new Error('market_index_daily does not contain both U001 and U201.');
  if (Number(minute?.index_count ?? 0) !== INDEX_CODES.length) throw new Error('market_index_minute_1m does not contain both U001 and U201.');
  if (Number(minute?.date_mismatch_count ?? 0) !== 0) throw new Error('market_index_minute_1m contains trading_date/bar_timestamp mismatches.');
  if (Number(invalidDaily?.invalid_count ?? 0) !== 0) throw new Error('market_index_daily contains invalid OHLC rows.');
  if (Number(invalidMinute?.invalid_count ?? 0) !== 0) throw new Error('market_index_minute_1m contains invalid OHLC rows.');
  for (const row of codes) {
    if (Number(row.daily_rows) <= 0 || Number(row.minute_rows) <= 0) {
      throw new Error(`${row.index_code} is missing daily or minute rows.`);
    }
  }

  console.log(
    `[PASS] korean-market-index daily_rows=${daily.row_count} minute_rows=${minute.row_count} ` +
    `indexes=${daily.index_count} daily_range=${daily.earliest_date}..${daily.latest_date} ` +
    `minute_range=${minute.earliest_ts}..${minute.latest_ts}`,
  );
} catch (error) {
  console.error(`[ERROR] korean-market-index health failed: ${error?.message ?? String(error)}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
