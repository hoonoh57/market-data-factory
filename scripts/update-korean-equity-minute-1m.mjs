import { rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createMySqlPool } from '../src/db/mysql.mjs';
import { minuteUpdateDecision } from '../src/data/minuteUpdatePolicy.mjs';
import { fetchStockMaster } from '../src/data/stockMaster.mjs';

function run(command, args, { cwd = process.cwd(), capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    if (capture) {
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
    }
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error((stderr || stdout || `${command} exited with code ${code}`).trim()));
    });
  });
}

function nextIsoDay(isoDate) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function subtractMonths(isoDate, months) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  const originalDay = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - months);
  const nextMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(originalDay, nextMonth));
  return d.toISOString().slice(0, 10);
}

function groupByFrom(plan) {
  const groups = new Map();
  for (const item of plan) {
    if (!groups.has(item.from)) groups.set(item.from, []);
    groups.get(item.from).push(item.code);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

const decision = minuteUpdateDecision();
if (decision.action === 'SKIP') {
  console.log(`[PASS] minute update skipped: current trading session is not complete before ${decision.completedSessionHourKst}:00 KST`);
  process.exit(0);
}

const pool = createMySqlPool();
try {
  // The +15% selection must use the just-completed daily session, so refresh daily first.
  await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'data:daily:update'], { capture: true });

  const [[latestDaily]] = await pool.query(
    `SELECT DATE_FORMAT(MAX(trading_date), '%Y-%m-%d') AS latest_date
     FROM korean_equity_daily`,
  );
  if (!latestDaily?.latest_date) throw new Error('Daily dataset is empty.');
  if (latestDaily.latest_date !== decision.kstDate) {
    throw new Error(`Daily dataset latest date ${latestDaily.latest_date} does not match completed session ${decision.kstDate}.`);
  }

  const [[previousDaily]] = await pool.query(
    `SELECT DATE_FORMAT(MAX(trading_date), '%Y-%m-%d') AS previous_date
     FROM korean_equity_daily
     WHERE trading_date < ?`,
    [latestDaily.latest_date],
  );
  if (!previousDaily?.previous_date) throw new Error('Unable to resolve previous trading date from daily dataset.');

  const stockMaster = await fetchStockMaster();
  const krx300Codes = stockMaster.rows
    .filter(row => row.krx300 === '1')
    .map(row => row.code.slice(1));

  const [movers] = await pool.query(
    `SELECT i.code,
            p.close AS previous_close,
            c.close AS current_close,
            ((c.close / p.close) - 1) * 100 AS change_pct
     FROM korean_equity_daily c
     JOIN korean_equity_daily p
       ON p.instrument_id = c.instrument_id AND p.trading_date = ?
     JOIN market_instrument i ON i.instrument_id = c.instrument_id
     WHERE c.trading_date = ?
       AND p.close > 0
       AND c.close >= p.close * 1.15
     ORDER BY i.code`,
    [previousDaily.previous_date, latestDaily.latest_date],
  );
  const moverCodes = movers.map(row => String(row.code));
  const targetCodes = [...new Set([...krx300Codes, ...moverCodes])].sort();
  if (!targetCodes.length) throw new Error('Minute target universe resolved to zero instruments.');

  const [existing] = await pool.query(
    `SELECT i.code, DATE_FORMAT(MAX(m.trading_date), '%Y-%m-%d') AS latest_date
     FROM market_instrument i
     JOIN korean_equity_minute_1m m ON m.instrument_id = i.instrument_id
     WHERE i.code IN (?)
     GROUP BY i.code`,
    [targetCodes],
  );
  const latestByCode = new Map(existing.map(row => [String(row.code), row.latest_date]));
  const newFrom = subtractMonths(decision.kstDate, 6);
  const plan = targetCodes
    .map(code => ({ code, from: latestByCode.has(code) ? nextIsoDay(latestByCode.get(code)) : newFrom }))
    .filter(item => item.from <= decision.kstDate);

  if (!plan.length) {
    console.log(`[PASS] minute update already current universe=${targetCodes.length} krx300=${krx300Codes.length} movers15=${moverCodes.length}`);
    process.exit(0);
  }

  const staging = path.resolve('.runtime/cybos/minute/1m-update');
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });

  const python32 = process.env.CYBOS_PYTHON32 || 'E:\\Python310-32\\python.exe';
  const collector = path.resolve('addons/korean-equity-minute-1m/collector/cybos_minute_1m_32.py');
  for (const [dateFrom, codes] of groupByFrom(plan)) {
    await run(python32, [
      collector,
      '--symbols', codes.join(','),
      '--from', dateFrom,
      '--to', decision.kstDate,
      '--output', staging,
      '--exchange', 'A',
      '--adjusted', 'true',
      '--max-attempts', '3',
    ], { capture: true });
  }

  await run(process.execPath, [path.resolve('scripts/import-korean-equity-minute-1m.mjs'), '--source', staging], { capture: true });
  await run(process.execPath, [path.resolve('scripts/check-korean-equity-minute-1m.mjs')], { capture: true });

  const newCount = targetCodes.filter(code => !latestByCode.has(code)).length;
  const existingCount = targetCodes.length - newCount;
  console.log(
    `[PASS] minute update session=${decision.kstDate} universe=${targetCodes.length} ` +
    `krx300=${krx300Codes.length} movers15=${moverCodes.length} existing=${existingCount} new=${newCount}`
  );
} catch (error) {
  console.error(`[ERROR] minute update failed: ${error?.message ?? String(error)}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
