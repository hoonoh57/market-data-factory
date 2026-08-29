import { mkdir, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fetchStockMaster } from '../src/data/stockMaster.mjs';
import { createMySqlPool } from '../src/db/mysql.mjs';

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
function flag(name) { return process.argv.includes(name); }

function run(command, args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', shell: false });
    let stdout = '';
    let stderr = '';
    if (capture) {
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
    }
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error((stderr || stdout || `${command} exited ${code}`).trim())));
  });
}

function parseDate(text) {
  const d = new Date(`${text}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(d.valueOf())) throw new Error(`Invalid date: ${text}`);
  return d;
}
function iso(d) { return d.toISOString().slice(0, 10); }
function monthSlices(fromText, toText) {
  const from = parseDate(fromText);
  const to = parseDate(toText);
  if (from > to) throw new Error('--from cannot be after --to');
  const out = [];
  let cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  while (cursor <= to) {
    const monthStart = new Date(cursor);
    const monthEnd = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0));
    out.push({
      month: `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`,
      from: iso(monthStart < from ? from : monthStart),
      to: iso(monthEnd > to ? to : monthEnd),
    });
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
  }
  return out;
}
function chunks(values, size) {
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}
function seconds(ms) { return Math.round(ms / 10) / 100; }

async function resolveMissingCodes(pool, candidateCodes, from, to) {
  if (!candidateCodes.length) return [];
  const [rows] = await pool.query(
    `SELECT i.code, COUNT(*) AS missing_days
     FROM korean_equity_daily d
     JOIN market_instrument i ON i.instrument_id = d.instrument_id
     LEFT JOIN (
       SELECT DISTINCT instrument_id, trading_date
       FROM korean_equity_minute_1m
       WHERE trading_date BETWEEN ? AND ?
     ) m
       ON m.instrument_id = d.instrument_id
      AND m.trading_date = d.trading_date
     WHERE d.trading_date BETWEEN ? AND ?
       AND i.code IN (?)
       AND m.instrument_id IS NULL
     GROUP BY i.code
     ORDER BY i.code`,
    [from, to, from, to, candidateCodes],
  );
  return rows.map(row => ({ code: String(row.code), missing_days: Number(row.missing_days) }));
}

const from = String(arg('--from', '2026-08-01'));
const to = String(arg('--to', '2026-08-31'));
const batchSize = Math.max(1, Number(arg('--batch-size', '25')));
const limit = Math.max(0, Number(arg('--limit', '0')));
const execute = flag('--execute');
const keepStaging = flag('--keep-staging');
const includeCovered = flag('--include-covered');
const python32 = process.env.CYBOS_PYTHON32 || 'E:\\Python310-32\\python.exe';
const collector = path.resolve('addons/korean-equity-minute-1m/collector/cybos_minute_1m_32.py');
const preflight = path.resolve('addons/korean-equity-minute-1m/collector/check_cybos_connection_32.py');
const importer = path.resolve('scripts/import-korean-equity-minute-1m.mjs');
const auditor = path.resolve('scripts/audit-korean-equity-minute-coverage.mjs');
let pool;

try {
  const master = await fetchStockMaster();
  let candidateCodes = master.rows
    .filter(row => ['KOSPI', 'KOSDAQ'].includes(String(row.market ?? '').trim().toUpperCase()))
    .map(row => String(row.code).slice(1))
    .sort();
  if (!candidateCodes.length) throw new Error('No KOSPI/KOSDAQ symbols resolved from stock master.');

  let missingByCode = [];
  let codes = candidateCodes;
  if (!includeCovered) {
    pool = createMySqlPool();
    missingByCode = await resolveMissingCodes(pool, candidateCodes, from, to);
    codes = missingByCode.map(row => row.code);
    if (limit > 0) codes = codes.slice(0, limit);
  } else if (limit > 0) {
    codes = codes.slice(0, limit);
  }

  const slices = monthSlices(from, to);
  const missingDays = missingByCode.reduce((sum, row) => sum + row.missing_days, 0);
  const plan = {
    from,
    to,
    candidate_symbols: candidateCodes.length,
    symbols: codes.length,
    selection: includeCovered ? 'ALL_ELIGIBLE_SYMBOLS' : 'ONLY_SYMBOLS_WITH_MISSING_INSTRUMENT_DAYS',
    missing_instrument_days: includeCovered ? null : missingDays,
    batch_size: batchSize,
    months: slices,
    execute,
    note: 'Idempotent MySQL upsert. Default planning skips symbols already fully covered for the requested range. Use --include-covered only for explicit re-download/repair.',
  };
  console.log(JSON.stringify(plan, null, 2));

  if (!codes.length) {
    console.log('[PASS] no missing minute symbol-days remain for the requested range.');
    process.exit(0);
  }
  if (!execute) {
    console.log('[DRY-RUN] Add --execute to start CYBOS collection/import.');
    process.exit(0);
  }

  console.log(`[PREFLIGHT] checking CYBOS connection with ${python32}`);
  try {
    const checked = await run(python32, [preflight], { capture: true });
    if (checked.stdout.trim()) console.log(checked.stdout.trim());
  } catch (error) {
    throw new Error(
      `CYBOS preflight failed before any backfill work. ${error?.message ?? String(error)}\n` +
      'Action: run CYBOS Plus and this PowerShell at the same Windows privilege level, confirm login/connect, then rerun. ' +
      'The backfill is idempotent, so rerunning is safe.',
    );
  }

  const totalStarted = Date.now();
  const missing = new Set();
  let batchesCompleted = 0;

  for (const slice of slices) {
    const monthRoot = path.resolve(`.runtime/cybos/minute/all-symbol-backfill/${slice.month}`);
    await mkdir(monthRoot, { recursive: true });
    let batchNo = 0;
    for (const batch of chunks(codes, batchSize)) {
      batchNo += 1;
      const staging = path.join(monthRoot, `batch-${String(batchNo).padStart(4, '0')}`);
      await rm(staging, { recursive: true, force: true });
      await mkdir(staging, { recursive: true });
      const started = Date.now();
      console.log(`[BACKFILL] month=${slice.month} batch=${batchNo} symbols=${batch.length} range=${slice.from}..${slice.to}`);
      await run(python32, [
        collector,
        '--symbols', batch.join(','),
        '--from', slice.from,
        '--to', slice.to,
        '--output', staging,
        '--exchange', 'A',
        '--adjusted', 'true',
        '--max-attempts', '3',
      ]);

      const files = (await readdir(staging)).filter(file => /^[0-9A-Z]{6}\.csv$/i.test(file));
      const collectedCodes = new Set(files.map(file => file.slice(0, 6).toUpperCase()));
      const missingBatch = batch.filter(code => !collectedCodes.has(code));
      for (const code of missingBatch) missing.add(`${slice.month}:${code}`);
      if (missingBatch.length) {
        console.log(`[WARN] no minute rows/files month=${slice.month} batch=${batchNo} symbols=${missingBatch.join(',')}`);
      }

      await run(process.execPath, [importer, '--source', staging]);
      batchesCompleted += 1;
      console.log(
        `[BATCH-DONE] month=${slice.month} batch=${batchNo} requested=${batch.length} files=${files.length} ` +
        `elapsed_seconds=${seconds(Date.now() - started)}`,
      );
      if (!keepStaging) await rm(staging, { recursive: true, force: true });
    }
  }

  console.log(
    `[PASS] all-symbol minute backfill complete symbols=${codes.length} batches=${batchesCompleted} ` +
    `range=${from}..${to} elapsed_seconds=${seconds(Date.now() - totalStarted)}`,
  );
  if (missing.size) {
    console.log(`[WARN] no-data symbol-month count=${missing.size} entries=${[...missing].join(',')}`);
  }

  console.log('[AUDIT] measuring post-backfill coverage...');
  await run(process.execPath, [auditor, '--from', from, '--to', to]);
} catch (error) {
  console.error(`[ERROR] all-symbol minute backfill failed: ${error?.message ?? String(error)}`);
  process.exitCode = 1;
} finally {
  if (pool) await pool.end();
}
