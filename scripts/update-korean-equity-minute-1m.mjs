import { rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createMySqlPool } from '../src/db/mysql.mjs';
import { minuteUpdateDecision } from '../src/data/minuteUpdatePolicy.mjs';

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function nextIsoDay(isoDate) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function run(command, args, { cwd = process.cwd() } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', shell: false });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)));
  });
}

const decision = minuteUpdateDecision();
if (decision.action === 'SKIP') {
  console.log(`[PASS] minute update skipped: current trading session is not complete before ${decision.completedSessionHourKst}:00 KST`);
  process.exit(0);
}

const pool = createMySqlPool();
try {
  const symbolsArg = arg('--symbols');
  let codes;
  if (symbolsArg) {
    codes = [...new Set(symbolsArg.split(',').map(value => value.trim().replace(/^A/i, '')).filter(Boolean))];
    if (!codes.length || codes.some(code => !/^[0-9A-Z]{6}$/i.test(code))) {
      throw new Error('--symbols must contain comma-separated six-character stock codes.');
    }
  } else {
    const [rows] = await pool.query(
      `SELECT DISTINCT i.code
       FROM market_instrument i
       JOIN korean_equity_minute_1m m ON m.instrument_id=i.instrument_id
       ORDER BY i.code`,
    );
    codes = rows.map(row => String(row.code));
  }
  if (!codes.length) throw new Error('No minute dataset instruments are available to update.');

  const [[latest]] = await pool.query(
    `SELECT DATE_FORMAT(MAX(trading_date), '%Y-%m-%d') AS latest_date
     FROM korean_equity_minute_1m`,
  );
  if (!latest?.latest_date) throw new Error('Minute dataset has no existing trading date.');

  const dateFrom = nextIsoDay(latest.latest_date);
  const dateTo = decision.kstDate;
  if (dateFrom > dateTo) {
    console.log(`[PASS] minute update already current through ${latest.latest_date}`);
    process.exit(0);
  }

  const staging = path.resolve('.runtime/cybos/minute/1m-update');
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });

  const python32 = process.env.CYBOS_PYTHON32 || 'E:\\Python310-32\\python.exe';
  const collector = path.resolve('addons/korean-equity-minute-1m/collector/cybos_minute_1m_32.py');
  await run(python32, [
    collector,
    '--symbols', codes.join(','),
    '--from', dateFrom,
    '--to', dateTo,
    '--output', staging,
    '--exchange', 'A',
    '--adjusted', 'true',
    '--max-attempts', '3',
  ]);

  await run(process.execPath, [path.resolve('scripts/import-korean-equity-minute-1m.mjs'), '--source', staging]);
  await run(process.execPath, [path.resolve('scripts/check-korean-equity-minute-1m.mjs')]);
} catch (error) {
  console.error(`[ERROR] minute update failed: ${error?.message ?? String(error)}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
