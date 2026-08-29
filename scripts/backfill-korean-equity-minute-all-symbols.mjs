import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fetchStockMaster } from '../src/data/stockMaster.mjs';

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

const from = String(arg('--from', '2026-08-01'));
const to = String(arg('--to', '2026-08-31'));
const batchSize = Math.max(1, Number(arg('--batch-size', '25')));
const limit = Math.max(0, Number(arg('--limit', '0')));
const execute = flag('--execute');
const keepStaging = flag('--keep-staging');
const python32 = process.env.CYBOS_PYTHON32 || 'E:\\Python310-32\\python.exe';
const collector = path.resolve('addons/korean-equity-minute-1m/collector/cybos_minute_1m_32.py');
const importer = path.resolve('scripts/import-korean-equity-minute-1m.mjs');

try {
  const master = await fetchStockMaster();
  let codes = master.rows
    .filter(row => ['KOSPI', 'KOSDAQ'].includes(String(row.market ?? '').trim().toUpperCase()))
    .map(row => String(row.code).slice(1))
    .sort();
  if (limit > 0) codes = codes.slice(0, limit);
  if (!codes.length) throw new Error('No KOSPI/KOSDAQ symbols resolved from stock master.');

  const slices = monthSlices(from, to);
  const plan = {
    from,
    to,
    symbols: codes.length,
    batch_size: batchSize,
    months: slices,
    execute,
    note: 'Idempotent MySQL upsert. Physical table partitioning is intentionally NOT changed by this runner.',
  };
  console.log(JSON.stringify(plan, null, 2));
  if (!execute) {
    console.log('[DRY-RUN] Add --execute to start CYBOS collection/import.');
    process.exit(0);
  }

  for (const slice of slices) {
    const monthRoot = path.resolve(`.runtime/cybos/minute/all-symbol-backfill/${slice.month}`);
    await mkdir(monthRoot, { recursive: true });
    let batchNo = 0;
    for (const batch of chunks(codes, batchSize)) {
      batchNo += 1;
      const staging = path.join(monthRoot, `batch-${String(batchNo).padStart(4, '0')}`);
      await rm(staging, { recursive: true, force: true });
      await mkdir(staging, { recursive: true });
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
      await run(process.execPath, [importer, '--source', staging]);
      if (!keepStaging) await rm(staging, { recursive: true, force: true });
    }
  }
  console.log(`[PASS] all-symbol minute backfill complete symbols=${codes.length} range=${from}..${to}`);
} catch (error) {
  console.error(`[ERROR] all-symbol minute backfill failed: ${error?.message ?? String(error)}`);
  process.exitCode = 1;
}
