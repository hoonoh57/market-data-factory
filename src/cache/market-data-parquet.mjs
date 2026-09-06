import { createHash } from 'node:crypto';
import path from 'node:path';

export const CACHE_MANIFEST_SCHEMA = 'dsl_market_data_cache/v1';

const SPECS = Object.freeze({
  daily: Object.freeze({
    datasetId: 'korean-equity-daily',
    table: 'korean_equity_daily',
    modifiedColumn: 'source_updated_at',
    root: 'parquet/daily',
    partitionBy: Object.freeze(['year', 'month']),
    partitionSql: "DATE_FORMAT(trading_date, '%Y-%m')",
  }),
  minute: Object.freeze({
    datasetId: 'korean-equity-minute-1m',
    table: 'korean_equity_minute_1m',
    modifiedColumn: 'ingested_at',
    root: 'parquet/minute_1m',
    partitionBy: Object.freeze(['trading_date']),
    partitionSql: "DATE_FORMAT(trading_date, '%Y-%m-%d')",
  }),
});

export function datasetSpec(name) {
  const spec = SPECS[String(name ?? '').trim()];
  if (!spec) throw new Error('dataset must be daily or minute');
  return spec;
}

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

export function sha256Hex(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

export function sourceStatus(spec, raw) {
  const rowCount = Number(raw.row_count ?? 0);
  const instrumentCount = Number(raw.instrument_count ?? 0);
  if (!Number.isSafeInteger(rowCount) || rowCount < 0) throw new Error('invalid source row_count');
  if (!Number.isSafeInteger(instrumentCount) || instrumentCount < 0) throw new Error('invalid source instrument_count');
  const earliest = raw.earliest == null ? null : String(raw.earliest);
  const latest = raw.latest == null ? null : String(raw.latest);
  const lastModified = raw.last_modified == null ? null : String(raw.last_modified);
  const revision = sha256Hex(canonicalJson({
    dataset_id: spec.datasetId,
    earliest,
    instrument_count: instrumentCount,
    last_modified: lastModified,
    latest,
    row_count: rowCount,
  }));
  return Object.freeze({
    dataset_id: spec.datasetId,
    row_count: rowCount,
    instrument_count: instrumentCount,
    earliest,
    latest,
    revision,
  });
}

export function sourceFingerprint(status) {
  return sha256Hex(canonicalJson(status));
}

export function partitionRevision(partition, rowCount, lastModified) {
  const count = Number(rowCount);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('invalid partition row_count');
  return sha256Hex(canonicalJson({
    last_modified: lastModified == null ? null : String(lastModified),
    partition: String(partition),
    row_count: count,
  }));
}

export function generationRoot(spec, status) {
  return path.posix.join(spec.root, `generation=${sourceFingerprint(status)}`);
}

export function partitionFile(spec, partition, cacheRoot = spec.root) {
  const value = String(partition);
  if (spec.datasetId === 'korean-equity-daily') {
    const match = /^(\d{4})-(\d{2})$/.exec(value);
    if (!match) throw new Error(`invalid daily partition: ${value}`);
    return path.posix.join(cacheRoot, `year=${match[1]}`, `month=${match[2]}`, 'part.parquet');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`invalid minute partition: ${value}`);
  return path.posix.join(cacheRoot, `trading_date=${value}`, 'part.parquet');
}

export function cacheManifest({ spec, status, generatedAtUtc, partitions, cacheRoot = generationRoot(spec, status) }) {
  if (!Array.isArray(partitions)) throw new Error('partitions must be an array');
  const partitionMap = {};
  for (const item of [...partitions].sort((a, b) => String(a.partition).localeCompare(String(b.partition)))) {
    const key = String(item.partition);
    if (partitionMap[key]) throw new Error(`duplicate partition: ${key}`);
    partitionMap[key] = {
      file: partitionFile(spec, key, cacheRoot),
      row_count: Number(item.row_count),
      revision: String(item.revision),
    };
  }
  return {
    schema: CACHE_MANIFEST_SCHEMA,
    dataset_id: spec.datasetId,
    cache: {
      format: 'parquet',
      root: cacheRoot,
      partition_by: [...spec.partitionBy],
    },
    source: { ...status },
    source_fingerprint: sourceFingerprint(status),
    generated_at_utc: String(generatedAtUtc),
    partitions: partitionMap,
  };
}
