import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createMySqlPool } from '../src/db/mysql.mjs';
import { INDEX_CODES } from '../src/data/marketIndexCsv.mjs';
import { minuteUpdateDecision } from '../src/data/minuteUpdatePolicy.mjs';
import { buildIndexUpdatePlan, groupIndexPlanByFrom } from '../src/data/marketIndexUpdatePolicy.mjs';

function run(command, args, { cwd = process.cwd(), capture = false } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
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
    child.on('error', error => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.on('exit', code => {
      if (settled) return;
      settled = true;
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error((stderr || stdout || `${command} exited with code ${code}`).trim()));
    });
  });
}

async function runNodeScript(script, args = [], options = {}) {
  return run(process.execPath, [path.resolve(script), ...args], options);
}

async function refreshCompletedDaily() {
  // Do not spawn npm.cmd from Node on Windows. Newer Node releases can reject
  // direct .cmd spawning with EINVAL when shell=false. Execute the three stable
  // daily-update stages through node.exe instead; this is equivalent to
  // `npm run data:daily:update` without a command-shell dependency.
  await runNodeScript('scripts/run-cybos-daily.mjs', [], { capture: true });
  await runNodeScript('scripts/import-korean-equity-daily.mjs', [], { capture: true });
  await runNodeScript('scripts/check-korean-equity-daily.mjs', [], { capture: true });
}

async function requireTable(pool, table) {
  const [rows] = await pool.query('SHOW TABLES LIKE ?', [table]);
  if (!rows.length) throw new Error(`${table} is missing. Run npm run data:index:schema first.`);
}

async function scalarDate(pool, sql, params, label) {
  const [[row]] = await pool.query(sql, params);
  const value = row?.value ? String(row.value) : '';
  if (!value) throw new Error(`${label} could not be resolved.`);
  return value;
}

async function latestByIndex(pool, table) {
  const [rows] = await pool.query(
    `SELECT index_code, DATE_FORMAT(MAX(trading_date), '%Y-%m-%d') AS latest_date
     FROM \`${table}\`
     WHERE index_code IN (?)
     GROUP BY index_code`,
    [INDEX_CODES],
  );
  return new Map(rows.map(row => [String(row.index_code), String(row.latest_date)]));
}

async function collectMode({ mode, plan, sessionDate, staging, python32, collector }) {
  if (!plan.length) return 0;
  const output = path.join(staging, mode === 'daily' ? 'daily' : 'minute');
  await mkdir(output, { recursive: true });
  let groups = 0;
  for (const group of groupIndexPlanByFrom(plan)) {
    await run(python32, [
      collector,
      '--symbols', group.codes.join(','),
      '--mode', mode,
      '--from', group.from,
      '--to', sessionDate,
      '--output', output,
      '--max-attempts', '3',
    ], { capture: true });
    groups += 1;
  }
  return groups;
}

const decision = minuteUpdateDecision();
const skipDailyRefresh = process.argv.includes('--skip-daily-refresh');
const cliArg = name => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : null; };
const fullRefresh = cliArg('mode') === 'full';
const pool = createMySqlPool();

try {
  if (!skipDailyRefresh) {
    await refreshCompletedDaily();
  }

  await requireTable(pool, 'market_index_daily');
  await requireTable(pool, 'market_index_minute_1m');

  const resolvedSessionDate = await scalarDate(
    pool,
    `SELECT DATE_FORMAT(MAX(trading_date), '%Y-%m-%d') AS value
     FROM korean_equity_daily
     WHERE trading_date <= ?`,
    [decision.eligibleCalendarDate],
    `latest completed trading session on or before ${decision.eligibleCalendarDate}`,
  );
  const sessionDate = cliArg('end') || resolvedSessionDate;
  const dailyInitialFrom = await scalarDate(
    pool,
    `SELECT DATE_FORMAT(MIN(trading_date), '%Y-%m-%d') AS value
     FROM korean_equity_daily
     WHERE trading_date <= ?`,
    [sessionDate],
    'initial market index daily backfill date',
  );
  const minuteInitialFrom = await scalarDate(
    pool,
    `SELECT DATE_FORMAT(MIN(trading_date), '%Y-%m-%d') AS value
     FROM korean_equity_minute_1m
     WHERE trading_date <= ?`,
    [sessionDate],
    'initial market index minute backfill date',
  );

  const dailyLatest = fullRefresh ? new Map() : await latestByIndex(pool, 'market_index_daily');
  const minuteLatest = fullRefresh ? new Map() : await latestByIndex(pool, 'market_index_minute_1m');
  const requestedStart = cliArg('start');
  const dailyPlan = buildIndexUpdatePlan({
    codes: INDEX_CODES,
    latestByCode: dailyLatest,
    initialFrom: requestedStart || dailyInitialFrom,
    sessionDate,
  });
  const minutePlan = buildIndexUpdatePlan({
    codes: INDEX_CODES,
    latestByCode: minuteLatest,
    initialFrom: requestedStart || minuteInitialFrom,
    sessionDate,
  });

  if (!dailyPlan.length && !minutePlan.length) {
    console.log(
      `[PASS] market index update already current session=${sessionDate} ` +
      `eligible_calendar_date=${decision.eligibleCalendarDate} indexes=${INDEX_CODES.join(',')}`,
    );
    process.exit(0);
  }

  const staging = path.resolve('.runtime/cybos/index-update');
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  const python32 = process.env.CYBOS_PYTHON32 || 'E:\\Python310-32\\python.exe';
  const collector = path.resolve('addons/korean-market-index/collector/cybos_market_index_32.py');

  const dailyGroups = await collectMode({
    mode: 'daily', plan: dailyPlan, sessionDate, staging, python32, collector,
  });
  const minuteGroups = await collectMode({
    mode: 'minute', plan: minutePlan, sessionDate, staging, python32, collector,
  });

  await runNodeScript('scripts/import-korean-market-index.mjs', ['--source', staging], { capture: true });
  await runNodeScript('scripts/check-korean-market-index.mjs', [], { capture: true });

  const dailyNew = INDEX_CODES.filter(code => !dailyLatest.has(code)).length;
  const minuteNew = INDEX_CODES.filter(code => !minuteLatest.has(code)).length;
  console.log(
    `[PASS] market index update session=${sessionDate} eligible_calendar_date=${decision.eligibleCalendarDate} ` +
    `indexes=${INDEX_CODES.join(',')} daily_groups=${dailyGroups} minute_groups=${minuteGroups} ` +
    `daily_new=${dailyNew} minute_new=${minuteNew}`,
  );
} catch (error) {
  console.error(`[ERROR] market index update failed: ${error?.message ?? String(error)}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
