import { createMySqlPool } from '../src/db/mysql.mjs';
import {
  latestEligibleUsCalendarDate,
  parseNasdaqHistoricalPayload,
  SOX_INDEX_CODE,
} from '../src/data/nasdaqIndexHistory.mjs';

function isoAddDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(days));
  return d.toISOString().slice(0, 10);
}

async function requireTable(pool, table) {
  const [rows] = await pool.query('SHOW TABLES LIKE ?', [table]);
  if (!rows.length) throw new Error(`${table} is missing. Run npm run data:index:schema first.`);
}

async function fetchNasdaqHistory(fromDate, toDate, { maxAttempts = 3 } = {}) {
  const url = new URL(`https://api.nasdaq.com/api/quote/${SOX_INDEX_CODE}/historical`);
  url.searchParams.set('assetclass', 'index');
  url.searchParams.set('fromdate', fromDate);
  url.searchParams.set('todate', toDate);
  url.searchParams.set('limit', '5000');
  url.searchParams.set('offset', '0');

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: 'application/json, text/plain, */*',
          'accept-language': 'en-US,en;q=0.9',
          origin: 'https://www.nasdaq.com',
          referer: 'https://www.nasdaq.com/',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36',
        },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      const payload = await response.json();
      return parseNasdaqHistoricalPayload(payload, { code: SOX_INDEX_CODE });
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) await new Promise(resolve => setTimeout(resolve, 1500 * attempt));
    }
  }
  throw new Error(`Nasdaq SOX download failed after ${maxAttempts} attempts: ${lastError?.message ?? String(lastError)}`);
}

const pool = createMySqlPool();
let runId;
try {
  await requireTable(pool, 'market_index_daily');

  const [[latestRow]] = await pool.query(
    `SELECT DATE_FORMAT(MAX(trading_date), '%Y-%m-%d') AS latest_date
     FROM market_index_daily WHERE index_code=?`,
    [SOX_INDEX_CODE],
  );
  const [[earliestKoreaRow]] = await pool.query(
    `SELECT DATE_FORMAT(MIN(trading_date), '%Y-%m-%d') AS earliest_date
     FROM korean_equity_daily`,
  );
  const latest = latestRow?.latest_date ? String(latestRow.latest_date) : '';
  const earliestKorea = earliestKoreaRow?.earliest_date ? String(earliestKoreaRow.earliest_date) : '';
  if (!earliestKorea) throw new Error('korean_equity_daily has no rows; SOX initial backfill boundary cannot be resolved.');

  const fromDate = latest ? isoAddDays(latest, 1) : isoAddDays(earliestKorea, -180);
  const toDate = latestEligibleUsCalendarDate();
  if (fromDate > toDate) {
    console.log(`[PASS] SOX daily already current latest=${latest} eligible_us_calendar_date=${toDate}`);
  } else {
    const rows = await fetchNasdaqHistory(fromDate, toDate);
    const eligibleRows = rows.filter(row => row.tradingDate >= fromDate && row.tradingDate <= toDate);

    const [run] = await pool.execute(
      `INSERT INTO data_ingestion_run (dataset_id, source_provider, source_location, status)
       VALUES ('global-market-index-sox', 'NASDAQ', ?, 'RUNNING')`,
      [`https://api.nasdaq.com/api/quote/${SOX_INDEX_CODE}/historical`],
    );
    runId = run.insertId;

    let inserted = 0;
    let updated = 0;
    if (eligibleRows.length) {
      const [existingRows] = await pool.query(
        `SELECT DATE_FORMAT(trading_date, '%Y-%m-%d') AS trading_date
         FROM market_index_daily
         WHERE index_code=? AND trading_date BETWEEN ? AND ?`,
        [SOX_INDEX_CODE, eligibleRows[0].tradingDate, eligibleRows.at(-1).tradingDate],
      );
      const existing = new Set(existingRows.map(row => String(row.trading_date)));

      for (let offset = 0; offset < eligibleRows.length; offset += 500) {
        const chunk = eligibleRows.slice(offset, offset + 500);
        const placeholders = chunk.map(() => '(?,?,?,?,?,?,?,?)').join(',');
        const values = [];
        for (const row of chunk) {
          values.push(
            SOX_INDEX_CODE,
            row.tradingDate,
            row.open,
            row.high,
            row.low,
            row.close,
            row.volume,
            'NASDAQ',
          );
        }
        await pool.query(
          `INSERT INTO market_index_daily
           (index_code, trading_date, open, high, low, close, volume, source_provider)
           VALUES ${placeholders}
           ON DUPLICATE KEY UPDATE
             open=VALUES(open), high=VALUES(high), low=VALUES(low), close=VALUES(close),
             volume=VALUES(volume), source_provider=VALUES(source_provider)`,
          values,
        );
      }
      updated = eligibleRows.filter(row => existing.has(row.tradingDate)).length;
      inserted = eligibleRows.length - updated;
    }

    await pool.execute(
      `UPDATE data_ingestion_run
       SET completed_at=CURRENT_TIMESTAMP, rows_read=?, rows_inserted=?, rows_updated=?, files_processed=0, status='PASS'
       WHERE run_id=?`,
      [eligibleRows.length, inserted, updated, runId],
    );

    const latestImported = eligibleRows.length ? eligibleRows.at(-1).tradingDate : latest || '(none)';
    console.log(
      `[PASS] SOX daily update from=${fromDate} to=${toDate} rows=${eligibleRows.length} ` +
      `inserted=${inserted} updated=${updated} latest=${latestImported}`,
    );
  }
} catch (error) {
  if (runId) {
    try {
      await pool.execute(
        `UPDATE data_ingestion_run
         SET completed_at=CURRENT_TIMESTAMP, status='FAIL', error_message=? WHERE run_id=?`,
        [String(error?.message ?? error).slice(0, 65535), runId],
      );
    } catch {}
  }
  console.error(`[ERROR] SOX daily update failed: ${error?.message ?? String(error)}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
