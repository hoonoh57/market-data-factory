import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createMySqlPool } from '../src/db/mysql.mjs';
import {
  indexCodeFromFilename,
  parseIndexDailyCsv,
  parseIndexMinuteCsv,
} from '../src/data/marketIndexCsv.mjs';

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function listIndexFiles(dir) {
  try {
    return (await readdir(dir)).filter(file => indexCodeFromFilename(file)).sort();
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

const sourceRoot = path.resolve(arg('--source') ?? '.runtime/cybos/index');
const provider = String(arg('--provider') ?? 'CYBOS').trim() || 'CYBOS';
const dailyDir = path.join(sourceRoot, 'daily');
const minuteDir = path.join(sourceRoot, 'minute');
const pool = createMySqlPool();
let runId;
let rowsRead = 0;
let rowsInserted = 0;
let rowsUpdated = 0;
let filesProcessed = 0;

async function importDailyFile(file) {
  const code = indexCodeFromFilename(file);
  const rows = parseIndexDailyCsv(await readFile(path.join(dailyDir, file), 'utf8'), { source: `daily/${file}` });
  if (!rows.length) return;
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [existingRows] = await connection.execute(
      `SELECT DATE_FORMAT(trading_date, '%Y-%m-%d') AS trading_date
       FROM market_index_daily
       WHERE index_code=? AND trading_date BETWEEN ? AND ?`,
      [code, rows[0].tradingDate, rows.at(-1).tradingDate],
    );
    const existing = new Set(existingRows.map(row => String(row.trading_date)));

    for (let offset = 0; offset < rows.length; offset += 500) {
      const chunk = rows.slice(offset, offset + 500);
      const placeholders = chunk.map(() => '(?,?,?,?,?,?,?,?)').join(',');
      const values = [];
      for (const row of chunk) {
        values.push(code, row.tradingDate, row.open, row.high, row.low, row.close, row.volume, provider);
      }
      await connection.query(
        `INSERT INTO market_index_daily
         (index_code, trading_date, open, high, low, close, volume, source_provider)
         VALUES ${placeholders}
         ON DUPLICATE KEY UPDATE
           open=VALUES(open), high=VALUES(high), low=VALUES(low), close=VALUES(close),
           volume=VALUES(volume), source_provider=VALUES(source_provider)`,
        values,
      );
    }
    await connection.commit();
    rowsRead += rows.length;
    const updated = rows.filter(row => existing.has(row.tradingDate)).length;
    rowsUpdated += updated;
    rowsInserted += rows.length - updated;
    filesProcessed += 1;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function importMinuteFile(file) {
  const code = indexCodeFromFilename(file);
  const rows = parseIndexMinuteCsv(await readFile(path.join(minuteDir, file), 'utf8'), { source: `minute/${file}` });
  if (!rows.length) return;
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [existingRows] = await connection.execute(
      `SELECT DATE_FORMAT(bar_timestamp, '%Y-%m-%d %H:%i:%s') AS bar_timestamp
       FROM market_index_minute_1m
       WHERE index_code=? AND bar_timestamp BETWEEN ? AND ?`,
      [code, rows[0].mysqlTimestamp, rows.at(-1).mysqlTimestamp],
    );
    const existing = new Set(existingRows.map(row => String(row.bar_timestamp)));

    for (let offset = 0; offset < rows.length; offset += 500) {
      const chunk = rows.slice(offset, offset + 500);
      const placeholders = chunk.map(() => '(?,?,?,?,?,?,?,?,?)').join(',');
      const values = [];
      for (const row of chunk) {
        values.push(
          code,
          row.mysqlTimestamp,
          row.tradingDate,
          row.open,
          row.high,
          row.low,
          row.close,
          row.volume,
          provider,
        );
      }
      await connection.query(
        `INSERT INTO market_index_minute_1m
         (index_code, bar_timestamp, trading_date, open, high, low, close, volume, source_provider)
         VALUES ${placeholders}
         ON DUPLICATE KEY UPDATE
           trading_date=VALUES(trading_date), open=VALUES(open), high=VALUES(high), low=VALUES(low),
           close=VALUES(close), volume=VALUES(volume), source_provider=VALUES(source_provider)`,
        values,
      );
    }
    await connection.commit();
    rowsRead += rows.length;
    const updated = rows.filter(row => existing.has(row.mysqlTimestamp)).length;
    rowsUpdated += updated;
    rowsInserted += rows.length - updated;
    filesProcessed += 1;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

try {
  const dailyFiles = await listIndexFiles(dailyDir);
  const minuteFiles = await listIndexFiles(minuteDir);
  if (!dailyFiles.length && !minuteFiles.length) {
    throw new Error(`No market index CSV files found under ${sourceRoot}`);
  }

  const [run] = await pool.execute(
    `INSERT INTO data_ingestion_run (dataset_id, source_provider, source_location, status)
     VALUES ('korean-market-index', ?, ?, 'RUNNING')`,
    [provider, sourceRoot],
  );
  runId = run.insertId;

  for (const file of dailyFiles) await importDailyFile(file);
  for (const file of minuteFiles) await importMinuteFile(file);

  await pool.execute(
    `UPDATE data_ingestion_run
     SET completed_at=CURRENT_TIMESTAMP, rows_read=?, rows_inserted=?, rows_updated=?, files_processed=?, status='PASS'
     WHERE run_id=?`,
    [rowsRead, rowsInserted, rowsUpdated, filesProcessed, runId],
  );
  console.log(
    `[PASS] korean-market-index imported files=${filesProcessed} rows=${rowsRead} ` +
    `inserted=${rowsInserted} updated=${rowsUpdated}`,
  );
} catch (error) {
  if (runId) {
    try {
      await pool.execute(
        `UPDATE data_ingestion_run
         SET completed_at=CURRENT_TIMESTAMP, rows_read=?, rows_inserted=?, rows_updated=?, files_processed=?, status='FAIL', error_message=?
         WHERE run_id=?`,
        [rowsRead, rowsInserted, rowsUpdated, filesProcessed, String(error?.message ?? error).slice(0, 65535), runId],
      );
    } catch {}
  }
  console.error(`[ERROR] korean-market-index import failed: ${error?.message ?? String(error)}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
