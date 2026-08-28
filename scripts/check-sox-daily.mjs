import { createMySqlPool } from '../src/db/mysql.mjs';
import { latestEligibleUsCalendarDate, SOX_INDEX_CODE } from '../src/data/nasdaqIndexHistory.mjs';

const pool = createMySqlPool();
try {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS row_count,
            DATE_FORMAT(MIN(trading_date), '%Y-%m-%d') AS min_date,
            DATE_FORMAT(MAX(trading_date), '%Y-%m-%d') AS max_date,
            MIN(close) AS min_close,
            MAX(close) AS max_close,
            COUNT(DISTINCT source_provider) AS providers
     FROM market_index_daily WHERE index_code=?`,
    [SOX_INDEX_CODE],
  );
  const count = Number(row?.row_count || 0);
  if (!count) throw new Error('market_index_daily has no SOX rows. Run npm run data:sox:update.');
  if (!(Number(row.min_close) > 0) || !(Number(row.max_close) > 0)) {
    throw new Error('SOX contains non-positive close values.');
  }
  const eligible = latestEligibleUsCalendarDate();
  console.log(
    `[PASS] SOX daily rows=${count} range=${row.min_date}..${row.max_date} ` +
    `eligible_us_calendar_date=${eligible} providers=${row.providers}`,
  );
} catch (error) {
  console.error(`[ERROR] SOX daily check failed: ${error?.message ?? String(error)}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
