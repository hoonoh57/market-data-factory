import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createMySqlPool } from '../src/db/mysql.mjs';
import { parseMinuteCsv, stockCodeFromMinuteFilename } from '../src/data/minuteCsv.mjs';

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const sourceDir = path.resolve(arg('--source') ?? '.runtime/cybos/minute/1m');
const provider = String(arg('--provider') ?? 'CYBOS').trim() || 'CYBOS';
const pool = createMySqlPool();
let runId;
let rowsRead = 0;
let rowsInserted = 0;
let rowsUpdated = 0;
let filesProcessed = 0;

try {
  const [run] = await pool.execute(
    `INSERT INTO data_ingestion_run (dataset_id, source_provider, source_location, status)
     VALUES ('korean-equity-minute-1m', ?, ?, 'RUNNING')`,
    [provider, sourceDir],
  );
  runId = run.insertId;

  const files = (await readdir(sourceDir)).filter(file => stockCodeFromMinuteFilename(file)).sort();
  if (!files.length) throw new Error(`No six-character minute CSV files found in ${sourceDir}`);

  console.log(`[MINUTE IMPORT] start files=${files.length}`);
  for (const [fileIndex, file] of files.entries()) {
    const code = stockCodeFromMinuteFilename(file);
    const filePath = path.join(sourceDir, file);
    const rows = parseMinuteCsv(await readFile(filePath, 'utf8'), { source: file });
    if (!rows.length) continue;
    const firstTimestamp = rows[0].mysqlTimestamp;
    const lastTimestamp = rows.at(-1).mysqlTimestamp;

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        `INSERT INTO market_instrument (code, instrument_type, first_seen_date, last_seen_date)
         VALUES (?, 'EQUITY', ?, ?)
         ON DUPLICATE KEY UPDATE
           first_seen_date = LEAST(COALESCE(first_seen_date, VALUES(first_seen_date)), VALUES(first_seen_date)),
           last_seen_date = GREATEST(COALESCE(last_seen_date, VALUES(last_seen_date)), VALUES(last_seen_date))`,
        [code, rows[0].tradingDate, rows.at(-1).tradingDate],
      );
      const [[instrument]] = await connection.execute('SELECT instrument_id FROM market_instrument WHERE code = ?', [code]);
      if (!instrument) throw new Error(`Unable to resolve instrument ${code}.`);

      const [existingRows] = await connection.execute(
        `SELECT DATE_FORMAT(bar_timestamp, '%Y-%m-%d %H:%i:%s') AS bar_timestamp
         FROM korean_equity_minute_1m
         WHERE instrument_id = ? AND bar_timestamp BETWEEN ? AND ?`,
        [instrument.instrument_id, firstTimestamp, lastTimestamp],
      );
      const existing = new Set(existingRows.map(row => row.bar_timestamp));

      for (let offset = 0; offset < rows.length; offset += 500) {
        const chunk = rows.slice(offset, offset + 500);
        const placeholders = chunk.map(() => '(?,?,?,?,?,?,?,?,?,?,?)').join(',');
        const values = [];
        for (const row of chunk) {
          values.push(
            instrument.instrument_id,
            row.mysqlTimestamp,
            row.tradingDate,
            row.open,
            row.high,
            row.low,
            row.close,
            row.volume,
            row.amount,
            true,
            provider,
          );
        }
        await connection.query(
          `INSERT INTO korean_equity_minute_1m
           (instrument_id, bar_timestamp, trading_date, open, high, low, close, volume, amount, adjusted, source_provider)
           VALUES ${placeholders}
           ON DUPLICATE KEY UPDATE
             trading_date=VALUES(trading_date), open=VALUES(open), high=VALUES(high), low=VALUES(low), close=VALUES(close),
             volume=VALUES(volume), amount=VALUES(amount), adjusted=VALUES(adjusted), source_provider=VALUES(source_provider)`,
          values,
        );
      }
      await connection.commit();

      rowsRead += rows.length;
      const updated = rows.filter(row => existing.has(row.mysqlTimestamp)).length;
      rowsUpdated += updated;
      rowsInserted += rows.length - updated;
      filesProcessed += 1;
      if ((fileIndex + 1) % 10 === 0 || fileIndex + 1 === files.length) {
        console.log(`[MINUTE IMPORT] ${fileIndex + 1}/${files.length} rows=${rowsRead} inserted=${rowsInserted} updated=${rowsUpdated}`);
      }
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  await pool.execute(
    `UPDATE data_ingestion_run
     SET completed_at=CURRENT_TIMESTAMP, rows_read=?, rows_inserted=?, rows_updated=?, files_processed=?, status='PASS'
     WHERE run_id=?`,
    [rowsRead, rowsInserted, rowsUpdated, filesProcessed, runId],
  );
  console.log(`[PASS] korean-equity-minute-1m imported files=${filesProcessed} rows=${rowsRead} inserted=${rowsInserted} updated=${rowsUpdated}`);
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
  console.error(`[ERROR] korean-equity-minute-1m import failed: ${error?.message ?? String(error)}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
