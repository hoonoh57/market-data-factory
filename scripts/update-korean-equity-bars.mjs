import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMySqlPool } from '../src/db/mysql.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAY_MS = 86_400_000;

function option(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function has(name) {
  return process.argv.includes(`--${name}`);
}

function isoDay(value, name) {
  const text = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw new Error(`${name} must be YYYY-MM-DD.`);
  }
  return text;
}

function nextDay(value) {
  return new Date(Date.parse(`${value}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
}

function eligibleEndDate() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const today = kst.toISOString().slice(0, 10);
  if (kst.getUTCHours() >= 20) return today;
  return new Date(Date.parse(`${today}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
}

function emit(event, fields = {}) {
  const payload = { event, at: new Date().toISOString(), ...fields };
  console.log(`BAR_EVENT ${JSON.stringify(payload)}`);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: 'inherit', shell: false });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} exited with code ${code}`)));
  });
}

function groupPlans(plans) {
  const groups = new Map();
  for (const item of plans) {
    if (!groups.has(item.from)) groups.set(item.from, []);
    groups.get(item.from).push(item.code);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function batches(items, size = 200) {
  const out = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

async function instruments(pool) {
  const [rows] = await pool.query(
    `SELECT instrument_id, code
       FROM market_instrument
      WHERE instrument_type='EQUITY'
      ORDER BY code`,
  );
  return rows
    .map(row => ({ instrumentId: Number(row.instrument_id), code: String(row.code).replace(/^A/, '') }))
    .filter(row => /^[0-9A-Z]{6}$/.test(row.code));
}

async function latestByCode(pool, type, allInstruments) {
  const table = type === 'daily' ? 'korean_equity_daily' : 'korean_equity_minute_1m';
  const orderColumn = type === 'daily' ? 'trading_date' : 'bar_timestamp';
  const result = new Map();
  let cursor = 0;
  async function worker() {
    while (cursor < allInstruments.length) {
      const item = allInstruments[cursor++];
      const [[row]] = await pool.query(
        `SELECT DATE_FORMAT(${orderColumn}, '%Y-%m-%d') AS latest_date
           FROM ${table} FORCE INDEX (PRIMARY)
          WHERE instrument_id=?
          ORDER BY ${orderColumn} DESC
          LIMIT 1`,
        [item.instrumentId],
      );
      if (row?.latest_date) result.set(item.code, String(row.latest_date));
    }
  }
  await Promise.all(Array.from({ length: 10 }, () => worker()));
  return result;
}

async function earliestDate(pool, type) {
  const table = type === 'daily' ? 'korean_equity_daily' : 'korean_equity_minute_1m';
  const [[row]] = await pool.query(`SELECT DATE_FORMAT(MIN(trading_date), '%Y-%m-%d') AS earliest_date FROM ${table}`);
  return row?.earliest_date ? String(row.earliest_date) : null;
}

async function status(pool, type) {
  const table = type === 'daily' ? 'korean_equity_daily' : 'korean_equity_minute_1m';
  // Avoid COUNT(*) / COUNT(DISTINCT) across the very large minute table.
  // Date edges use the trading_date index; row count is an immediate InnoDB estimate.
  const [[dates]] = await pool.query(
    `SELECT DATE_FORMAT(MIN(trading_date), '%Y-%m-%d') AS earliest_date,
            DATE_FORMAT(MAX(trading_date), '%Y-%m-%d') AS latest_date
       FROM ${table}`,
  );
  const [[covered]] = await pool.query(
    `SELECT COUNT(*) AS count
       FROM market_instrument i
      WHERE i.instrument_type='EQUITY'
        AND EXISTS (SELECT 1 FROM ${table} b WHERE b.instrument_id=i.instrument_id LIMIT 1)`,
  );
  const [[universe]] = await pool.query(`SELECT COUNT(*) AS count FROM market_instrument WHERE instrument_type='EQUITY'`);
  const result = {
    type,
    instrumentsWithData: Number(covered.count),
    universe: Number(universe.count),
    missingInstruments: Number(universe.count) - Number(covered.count),
    earliestDate: dates.earliest_date ? String(dates.earliest_date) : null,
    latestDate: dates.latest_date ? String(dates.latest_date) : null,
  };
  emit('status', result);
  return result;
}

async function collectDaily(plans, end, staging, python32) {
  const configPath = path.join(staging, 'daily-request.json');
  let completed = 0;
  for (const [from, codes] of groupPlans(plans)) {
    for (const batch of batches(codes)) {
      await writeFile(configPath, JSON.stringify({
        dataset: 'daily', python32, outputDir: staging, dateFrom: from, dateTo: end,
        exchange: 'K', adjusted: true, maxAttempts: 3,
      }, null, 2));
      emit('batch_start', { type: 'daily', from, end, symbols: batch.length, completed, total: plans.length });
      await run(python32, [
        path.join(ROOT, 'addons/korean-equity-daily/collector/cybos_daily_32.py'),
        '--request', configPath,
        '--symbols', batch.map(code => `A${code}`).join(','),
      ]);
      completed += batch.length;
      emit('progress', { type: 'daily', completed, total: plans.length, percent: Number((completed * 100 / plans.length).toFixed(1)) });
    }
  }
}

async function collectMinute(plans, end, staging, python32) {
  let completed = 0;
  for (const [from, codes] of groupPlans(plans)) {
    for (const batch of batches(codes)) {
      emit('batch_start', { type: 'minute', from, end, symbols: batch.length, completed, total: plans.length });
      await run(python32, [
        path.join(ROOT, 'addons/korean-equity-minute-1m/collector/cybos_minute_1m_32.py'),
        '--symbols', batch.join(','), '--from', from, '--to', end, '--output', staging,
        '--exchange', 'A', '--adjusted', 'true', '--max-attempts', '3',
      ]);
      completed += batch.length;
      emit('progress', { type: 'minute', completed, total: plans.length, percent: Number((completed * 100 / plans.length).toFixed(1)) });
    }
  }
}

async function main() {
  const command = option('command', 'update');
  const type = option('type');
  if (!['daily', 'minute'].includes(type)) throw new Error('--type must be daily or minute.');
  const pool = createMySqlPool();
  try {
    if (command === 'status') {
      await status(pool, type);
      return;
    }
    if (command !== 'update') throw new Error('--command must be update or status.');
    const mode = option('mode', 'incremental');
    if (!['full', 'incremental'].includes(mode)) throw new Error('--mode must be full or incremental.');
    const end = isoDay(option('end', eligibleEndDate()), '--end');
    const all = await instruments(pool);
    if (!all.length) throw new Error('market_instrument contains no EQUITY instruments.');
    const latest = mode === 'incremental' ? await latestByCode(pool, type, all) : new Map();
    const fallbackStart = option('start')
      ? isoDay(option('start'), '--start')
      : (await earliestDate(pool, type)) ?? (type === 'daily' ? '2021-01-01' : null);
    if (!fallbackStart) throw new Error('No existing minute start date. Supply --start for the first minute download.');
    const plans = all.map(({ code }) => ({
      code,
      from: mode === 'full' ? fallbackStart : (latest.has(code) ? nextDay(latest.get(code)) : fallbackStart),
    })).filter(item => item.from <= end);
    emit('plan', { type, mode, start: fallbackStart, end, universe: all.length, updateNeeded: plans.length, alreadyCurrent: all.length - plans.length });
    if (has('dry-run') || !plans.length) {
      emit('complete', { type, mode, dryRun: has('dry-run'), updatedSymbols: 0 });
      return;
    }
    const staging = path.join(ROOT, '.runtime', 'cybos', 'bars-update', type);
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    const python32 = process.env.CYBOS_PYTHON32 || 'E:\\Python310-32\\python.exe';
    if (type === 'daily') await collectDaily(plans, end, staging, python32);
    else await collectMinute(plans, end, staging, python32);
    const csvFiles = (await readdir(staging)).filter(file => /^[0-9A-Z]{6}\.csv$/i.test(file));
    if (csvFiles.length) {
      const importer = type === 'daily' ? 'import-korean-equity-daily.mjs' : 'import-korean-equity-minute-1m.mjs';
      emit('import_start', { type, files: csvFiles.length });
      await run(process.execPath, [path.join(ROOT, 'scripts', importer), '--source', staging]);
    } else {
      emit('import_skip', { type, reason: 'no_rows_collected' });
    }
    await status(pool, type);
    emit('complete', { type, mode, updatedSymbols: csvFiles.length });
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  emit('error', { message: error?.message ?? String(error) });
  process.exitCode = 1;
});
