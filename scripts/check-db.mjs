import { withMySqlConnection } from '../src/db/mysql.mjs';

try {
  const result = await withMySqlConnection(async connection => {
    const [[row]] = await connection.query('SELECT DATABASE() AS db, VERSION() AS version, NOW() AS serverTime');
    return row;
  });
  console.log(`[PASS] MySQL connected: database=${result.db} version=${result.version}`);
} catch (error) {
  console.error(`[ERROR] MySQL connection failed: ${error?.message ?? String(error)}`);
  if (process.env.MARKET_DATA_DEBUG === '1' && error?.stack) console.error(error.stack);
  process.exitCode = 1;
}
