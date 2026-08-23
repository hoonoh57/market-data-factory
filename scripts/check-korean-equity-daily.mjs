import { withMySqlConnection } from '../src/db/mysql.mjs';

try {
  const result = await withMySqlConnection(async connection => {
    const [[health]] = await connection.query(
      `SELECT
         row_count,
         instrument_count,
         DATE_FORMAT(earliest_trading_date, '%Y-%m-%d') AS earliest_trading_date,
         DATE_FORMAT(latest_trading_date, '%Y-%m-%d') AS latest_trading_date,
         latest_source_update_at
       FROM korean_equity_daily_health`,
    );
    const [[run]] = await connection.query(
      `SELECT status, started_at, completed_at, rows_read, rows_inserted, rows_updated, files_processed
       FROM data_ingestion_run
       WHERE dataset_id='korean-equity-daily'
       ORDER BY run_id DESC LIMIT 1`,
    );
    return { health, run: run ?? null };
  });
  if (!result.health || Number(result.health.row_count ?? 0) < 1) {
    throw new Error('korean_equity_daily has no rows.');
  }
  if (result.run && result.run.status !== 'PASS') {
    throw new Error(`latest ingestion status is ${result.run.status}`);
  }
  console.log(`[PASS] korean-equity-daily rows=${result.health.row_count} instruments=${result.health.instrument_count} range=${result.health.earliest_trading_date}..${result.health.latest_trading_date}`);
} catch (error) {
  console.error(`[ERROR] korean-equity-daily health failed: ${error?.message ?? String(error)}`);
  process.exitCode = 1;
}
