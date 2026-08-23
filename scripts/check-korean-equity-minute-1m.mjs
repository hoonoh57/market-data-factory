import { withMySqlConnection } from '../src/db/mysql.mjs';

try {
  const result = await withMySqlConnection(async connection => {
    const [[health]] = await connection.query('SELECT * FROM korean_equity_minute_1m_health');
    const [[run]] = await connection.query(
      `SELECT status, started_at, completed_at, rows_read, rows_inserted, rows_updated, files_processed
       FROM data_ingestion_run
       WHERE dataset_id='korean-equity-minute-1m'
       ORDER BY run_id DESC LIMIT 1`,
    );
    return { health, run: run ?? null };
  });
  if (!result.health || Number(result.health.row_count ?? 0) < 1) {
    throw new Error('korean_equity_minute_1m has no rows.');
  }
  if (result.run && result.run.status !== 'PASS') {
    throw new Error(`latest ingestion status is ${result.run.status}`);
  }
  console.log(
    `[PASS] korean-equity-minute-1m rows=${result.health.row_count} instruments=${result.health.instrument_count} `
    + `range=${result.health.earliest_bar_timestamp}..${result.health.latest_bar_timestamp}`,
  );
} catch (error) {
  console.error(`[ERROR] korean-equity-minute-1m health failed: ${error?.message ?? String(error)}`);
  process.exitCode = 1;
}
