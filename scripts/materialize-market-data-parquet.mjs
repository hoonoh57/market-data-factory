import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { withMySqlConnection } from '../src/db/mysql.mjs';
import {
  CACHE_MANIFEST_SCHEMA,
  cacheManifest,
  datasetSpec,
  generationRoot,
  partitionFile,
  partitionRevision,
  sourceFingerprint,
  sourceStatus,
} from '../src/cache/market-data-parquet.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONVERTER = path.join(ROOT, 'scripts', 'csv-to-parquet.py');

function parseArgs(argv) {
  const result = { command: 'status', dataset: null, target: null, python: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--command') result.command = argv[++i];
    else if (arg === '--dataset') result.dataset = argv[++i];
    else if (arg === '--target') result.target = argv[++i];
    else if (arg === '--python') result.python = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!['status', 'sync'].includes(result.command)) throw new Error('command must be status or sync');
  datasetSpec(result.dataset);
  if (result.command === 'sync' && !String(result.target ?? '').trim()) {
    throw new Error('--target is required for sync');
  }
  return result;
}

function pythonPath(explicit) {
  if (String(explicit ?? '').trim()) return String(explicit).trim();
  if (String(process.env.MARKET_DATA_PYTHON64 ?? '').trim()) return String(process.env.MARKET_DATA_PYTHON64).trim();
  return process.platform === 'win32' ? 'python' : 'python3';
}

function formatSql(spec) {
  return `
    SELECT
      COUNT(*) AS row_count,
      COUNT(DISTINCT instrument_id) AS instrument_count,
      DATE_FORMAT(MIN(trading_date), '%Y-%m-%d') AS earliest,
      DATE_FORMAT(MAX(trading_date), '%Y-%m-%d') AS latest,
      DATE_FORMAT(MAX(${spec.modifiedColumn}), '%Y-%m-%dT%H:%i:%s') AS last_modified
    FROM ${spec.table}
  `;
}

async function readSourceStatus(connection, spec) {
  const [rows] = await connection.query(formatSql(spec));
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error('source status query returned unexpected rows');
  return sourceStatus(spec, rows[0]);
}

async function readPartitionStats(connection, spec) {
  const [rows] = await connection.query(`
    SELECT
      ${spec.partitionSql} AS partition_key,
      COUNT(*) AS row_count,
      DATE_FORMAT(MAX(${spec.modifiedColumn}), '%Y-%m-%dT%H:%i:%s') AS last_modified
    FROM ${spec.table}
    GROUP BY ${spec.partitionSql}
    ORDER BY partition_key
  `);
  return rows.map((row) => {
    const partition = String(row.partition_key);
    const rowCount = Number(row.row_count);
    return {
      partition,
      row_count: rowCount,
      revision: partitionRevision(partition, rowCount, row.last_modified),
    };
  });
}

function dailyBounds(partition) {
  const match = /^(\d{4})-(\d{2})$/.exec(partition);
  if (!match) throw new Error(`invalid daily partition: ${partition}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const start = `${match[1]}-${match[2]}-01`;
  const next = month === 12
    ? `${String(year + 1).padStart(4, '0')}-01-01`
    : `${match[1]}-${String(month + 1).padStart(2, '0')}-01`;
  return [start, next];
}

async function readPartitionRows(connection, spec, partition) {
  if (spec.datasetId === 'korean-equity-daily') {
    const [start, next] = dailyBounds(partition);
    const [rows] = await connection.query(`
      SELECT
        i.code,
        DATE_FORMAT(d.trading_date, '%Y-%m-%d') AS trading_date,
        d.open, d.high, d.low, d.close, d.volume, d.amount
      FROM korean_equity_daily d
      JOIN market_instrument i ON i.instrument_id = d.instrument_id
      WHERE d.trading_date >= ? AND d.trading_date < ?
      ORDER BY d.trading_date, i.code
    `, [start, next]);
    return rows;
  }

  const [rows] = await connection.query(`
    SELECT
      i.code,
      DATE_FORMAT(m.bar_timestamp, '%Y-%m-%d %H:%i:%s') AS bar_timestamp,
      DATE_FORMAT(m.trading_date, '%Y-%m-%d') AS trading_date,
      m.open, m.high, m.low, m.close, m.volume, m.amount
    FROM korean_equity_minute_1m m
    JOIN market_instrument i ON i.instrument_id = m.instrument_id
    WHERE m.trading_date = ?
    ORDER BY m.bar_timestamp, i.code
  `, [partition]);
  return rows;
}

function csvValue(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

async function writeCsv(filePath, rows, dataset) {
  const fields = dataset === 'daily'
    ? ['code', 'trading_date', 'open', 'high', 'low', 'close', 'volume', 'amount']
    : ['code', 'bar_timestamp', 'trading_date', 'open', 'high', 'low', 'close', 'volume', 'amount'];
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const stream = fs.createWriteStream(filePath, { encoding: 'utf8' });
  stream.write(`${fields.join(',')}\n`);
  for (const row of rows) {
    const line = `${fields.map((field) => csvValue(row[field])).join(',')}\n`;
    if (!stream.write(line)) await new Promise((resolve) => stream.once('drain', resolve));
  }
  await new Promise((resolve, reject) => {
    stream.once('error', reject);
    stream.end(resolve);
  });
}

function readExistingManifest(manifestPath, spec) {
  if (!fs.existsSync(manifestPath)) return null;
  const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (parsed?.schema !== CACHE_MANIFEST_SCHEMA || parsed?.dataset_id !== spec.datasetId) return null;
  return parsed;
}

function runConverter({ python, dataset, input, output }) {
  const result = spawnSync(
    python,
    [CONVERTER, '--dataset', dataset, '--input', input, '--output', output],
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Parquet converter failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
}

async function linkOrCopy(source, target) {
  if (path.resolve(source) === path.resolve(target)) return;
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.promises.link(source, target);
  } catch (error) {
    if (!['EXDEV', 'EPERM', 'EACCES', 'EEXIST'].includes(error.code)) throw error;
    if (!fs.existsSync(target)) await fs.promises.copyFile(source, target);
  }
}

async function syncDataset(connection, { dataset, target, python }) {
  const spec = datasetSpec(dataset);
  const dataRoot = path.resolve(target);
  const manifestPath = path.join(dataRoot, 'manifest', `${spec.datasetId}.json`);
  const existing = readExistingManifest(manifestPath, spec);
  const status = await readSourceStatus(connection, spec);
  const sourceHash = sourceFingerprint(status);
  const cacheRoot = generationRoot(spec, status);
  const partitionStats = await readPartitionStats(connection, spec);
  const stagingRoot = path.join(ROOT, '.runtime', 'analytics-cache', dataset);
  await fs.promises.mkdir(stagingRoot, { recursive: true });

  let reused = 0;
  let materialized = 0;
  for (const item of partitionStats) {
    const relative = partitionFile(spec, item.partition, cacheRoot);
    const output = path.join(dataRoot, ...relative.split('/'));
    const previous = existing?.partitions?.[item.partition];
    const previousFile = previous?.file
      ? path.join(dataRoot, ...String(previous.file).split('/'))
      : null;

    if (previous?.revision === item.revision && previousFile && fs.existsSync(previousFile)) {
      await linkOrCopy(previousFile, output);
      reused += 1;
      continue;
    }

    const rows = await readPartitionRows(connection, spec, item.partition);
    if (rows.length !== item.row_count) {
      throw new Error(`partition ${item.partition} changed during materialization: expected=${item.row_count} actual=${rows.length}`);
    }
    const csvPath = path.join(stagingRoot, `${item.partition}.csv`);
    try {
      await writeCsv(csvPath, rows, dataset);
      await fs.promises.mkdir(path.dirname(output), { recursive: true });
      runConverter({ python, dataset, input: csvPath, output });
    } finally {
      await fs.promises.rm(csvPath, { force: true });
    }
    materialized += 1;
  }

  const latestStatus = await readSourceStatus(connection, spec);
  if (sourceFingerprint(latestStatus) !== sourceHash) {
    throw new Error('source dataset changed during cache materialization');
  }

  const manifest = cacheManifest({
    spec,
    status,
    cacheRoot,
    generatedAtUtc: new Date().toISOString(),
    partitions: partitionStats,
  });
  await fs.promises.mkdir(path.dirname(manifestPath), { recursive: true });
  const tempManifest = `${manifestPath}.${process.pid}.tmp`;
  await fs.promises.writeFile(tempManifest, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await fs.promises.rename(tempManifest, manifestPath);
  return { manifest, reused, materialized };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const spec = datasetSpec(args.dataset);
  const python = pythonPath(args.python);
  await withMySqlConnection(async (connection) => {
    if (args.command === 'status') {
      const status = await readSourceStatus(connection, spec);
      console.log(`CACHE_EVENT ${JSON.stringify({
        event: 'status',
        dataset_id: spec.datasetId,
        source: status,
        source_fingerprint: sourceFingerprint(status),
      })}`);
      return;
    }

    const result = await syncDataset(connection, {
      dataset: args.dataset,
      target: args.target,
      python,
    });
    console.log(`CACHE_EVENT ${JSON.stringify({
      event: 'complete',
      dataset_id: spec.datasetId,
      source_fingerprint: result.manifest.source_fingerprint,
      cache_root: result.manifest.cache.root,
      partitions: Object.keys(result.manifest.partitions).length,
      materialized: result.materialized,
      reused: result.reused,
    })}`);
  });
}

main().catch((error) => {
  console.error(`CACHE_EVENT ${JSON.stringify({ event: 'error', message: error.message })}`);
  process.exitCode = 1;
});
