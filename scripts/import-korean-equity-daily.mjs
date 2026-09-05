import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createMySqlPool } from '../src/db/mysql.mjs';
import { parseCsvLine, parseDailyCsv, stockCodeFromDailyFilename } from '../src/data/dailyCsv.mjs';

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function parseUniverse(text) {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  if (!lines.length) return new Map();
  const headers = parseCsvLine(lines[0]);
  const required = ['code', 'name', 'market'];
  if (headers.length !== required.length || headers.some((value, index) => value !== required[index])) return new Map();
  const out = new Map();
  for (const line of lines.slice(1)) {
    const values = parseCsvLine(line);
    if (values.length !== required.length) continue;
    const rawCode = String(values[0] ?? '').trim();
    const code = rawCode.startsWith('A') ? rawCode.slice(1) : rawCode;
    if (!/^\d{6}$/.test(code)) continue;
    out.set(code, { name: String(values[1] ?? '').trim() || null, market: String(values[2] ?? '').trim() || null });
  }
  return out;
}

const sourceDir = path.resolve(arg('--source') ?? '.runtime/cybos/daily');
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
     VALUES ('korean-equity-daily', ?, ?, 'RUNNING')`,
    [provider, sourceDir],
  );
  runId = run.insertId;

  let universe = new Map();
  try { universe = parseUniverse(await readFile(path.join(sourceDir, 'universe.csv'), 'utf8')); } catch {}

  const files = (await readdir(sourceDir)).filter(file => stockCodeFromDailyFilename(file)).sort();
  if (!files.length) throw new Error(`No six-digit daily CSV files found in ${sourceDir}`);

  console.log(`[DAILY IMPORT] start files=${files.length}`);
  for (const [fileIndex, file] of files.entries()) {
    const code = stockCodeFromDailyFilename(file);
    const filePath = path.join(sourceDir, file);
    const rows = parseDailyCsv(await readFile(filePath, 'utf8'), { source: file });
    if (!rows.length) continue;
    const metadata = universe.get(code) ?? {};
    const firstDate = rows[0].tradingDate;
    const lastDate = rows.at(-1).tradingDate;

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        `INSERT INTO market_instrument (code, name, market, instrument_type, first_seen_date, last_seen_date)
         VALUES (?, ?, ?, 'EQUITY', ?, ?)
         ON DUPLICATE KEY UPDATE
           name = COALESCE(VALUES(name), name),
           market = COALESCE(VALUES(market), market),
           first_seen_date = LEAST(COALESCE(first_seen_date, VALUES(first_seen_date)), VALUES(first_seen_date)),
           last_seen_date = GREATEST(COALESCE(last_seen_date, VALUES(last_seen_date)), VALUES(last_seen_date))`,
        [code, metadata.name ?? null, metadata.market ?? null, firstDate, lastDate],
      );
      const [[instrument]] = await connection.execute('SELECT instrument_id FROM market_instrument WHERE code = ?', [code]);
      const [existingRows] = await connection.execute(
        `SELECT DATE_FORMAT(trading_date, '%Y-%m-%d') AS trading_date
         FROM korean_equity_daily
         WHERE instrument_id = ? AND trading_date BETWEEN ? AND ?`,
        [instrument.instrument_id, firstDate, lastDate],
      );
      const existingDates = new Set(existingRows.map(row => String(row.trading_date)));

      for (let offset = 0; offset < rows.length; offset += 500) {
        const chunk = rows.slice(offset, offset + 500);
        const placeholders = chunk.map(() => '(?,?,?,?,?,?,?,?,?,?)').join(',');
        const values = [];
        for (const row of chunk) {
          values.push(
            instrument.instrument_id,
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
          `INSERT INTO korean_equity_daily
           (instrument_id, trading_date, open, high, low, close, volume, amount, adjusted, source_provider)
           VALUES ${placeholders}
           ON DUPLICATE KEY UPDATE
             open=VALUES(open), high=VALUES(high), low=VALUES(low), close=VALUES(close),
             volume=VALUES(volume), amount=VALUES(amount), adjusted=VALUES(adjusted),
             source_provider=VALUES(source_provider)`,
          values,
        );
      }
      await connection.commit();
      rowsRead += rows.length;
      rowsUpdated += rows.filter(row => existingDates.has(row.tradingDate)).length;
      rowsInserted += rows.filter(row => !existingDates.has(row.tradingDate)).length;
      filesProcessed += 1;
      if ((fileIndex + 1) % 25 === 0 || fileIndex + 1 === files.length) {
        console.log(`[DAILY IMPORT] ${fileIndex + 1}/${files.length} rows=${rowsRead} inserted=${rowsInserted} updated=${rowsUpdated}`);
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
  console.log(`[PASS] korean-equity-daily imported files=${filesProcessed} rows=${rowsRead} inserted=${rowsInserted} updated=${rowsUpdated}`);
} catch (error) {
  if (runId) {
    try {
      await pool.execute(
        `UPDATE data_ingestion_run SET completed_at=CURRENT_TIMESTAMP, rows_read=?, rows_inserted=?, rows_updated=?, files_processed=?, status='FAIL', error_message=? WHERE run_id=?`,
        [rowsRead, rowsInserted, rowsUpdated, filesProcessed, String(error?.message ?? error).slice(0, 65535), runId],
      );
    } catch {}
  }
  console.error(`[ERROR] korean-equity-daily import failed: ${error?.message ?? String(error)}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
