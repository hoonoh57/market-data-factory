import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CACHE_MANIFEST_SCHEMA,
  cacheManifest,
  canonicalJson,
  datasetSpec,
  partitionFile,
  partitionRevision,
  sourceFingerprint,
  sourceStatus,
} from '../src/cache/market-data-parquet.mjs';

test('daily/minute specs expose stable dataset identities and cache roots', () => {
  const daily = datasetSpec('daily');
  const minute = datasetSpec('minute');
  assert.equal(daily.datasetId, 'korean-equity-daily');
  assert.equal(daily.root, 'parquet/daily');
  assert.deepEqual([...daily.partitionBy], ['year', 'month']);
  assert.equal(minute.datasetId, 'korean-equity-minute-1m');
  assert.equal(minute.root, 'parquet/minute_1m');
  assert.deepEqual([...minute.partitionBy], ['trading_date']);
  assert.throws(() => datasetSpec('unknown'), /daily or minute/);
});

test('source status revision and fingerprint are deterministic and mutation-sensitive', () => {
  const spec = datasetSpec('daily');
  const raw = {
    row_count: 10,
    instrument_count: 2,
    earliest: '2026-01-02',
    latest: '2026-01-05',
    last_modified: '2026-01-05T20:00:00',
  };
  const one = sourceStatus(spec, raw);
  const two = sourceStatus(spec, { ...raw });
  assert.deepEqual(one, two);
  assert.equal(sourceFingerprint(one), sourceFingerprint(two));
  const changed = sourceStatus(spec, { ...raw, last_modified: '2026-01-05T20:00:01' });
  assert.notEqual(one.revision, changed.revision);
  assert.notEqual(sourceFingerprint(one), sourceFingerprint(changed));
});

test('partition file paths are deterministic and reject malformed values', () => {
  assert.equal(
    partitionFile(datasetSpec('daily'), '2026-09'),
    'parquet/daily/year=2026/month=09/part.parquet',
  );
  assert.equal(
    partitionFile(datasetSpec('minute'), '2026-09-04'),
    'parquet/minute_1m/trading_date=2026-09-04/part.parquet',
  );
  assert.throws(() => partitionFile(datasetSpec('daily'), '../2026-09'), /invalid daily partition/);
  assert.throws(() => partitionFile(datasetSpec('minute'), '2026-09'), /invalid minute partition/);
});

test('manifest matches DSL cache contract and sorts partitions', () => {
  const spec = datasetSpec('daily');
  const status = sourceStatus(spec, {
    row_count: 20,
    instrument_count: 2,
    earliest: '2026-01-02',
    latest: '2026-02-02',
    last_modified: '2026-02-02T20:00:00',
  });
  const manifest = cacheManifest({
    spec,
    status,
    generatedAtUtc: '2026-09-06T02:00:00Z',
    partitions: [
      { partition: '2026-02', row_count: 10, revision: partitionRevision('2026-02', 10, 'b') },
      { partition: '2026-01', row_count: 10, revision: partitionRevision('2026-01', 10, 'a') },
    ],
  });
  assert.equal(manifest.schema, CACHE_MANIFEST_SCHEMA);
  assert.equal(manifest.cache.format, 'parquet');
  assert.equal(manifest.source_fingerprint, sourceFingerprint(status));
  assert.deepEqual(Object.keys(manifest.partitions), ['2026-01', '2026-02']);
  assert.equal(manifest.partitions['2026-01'].file, 'parquet/daily/year=2026/month=01/part.parquet');
});

test('canonical JSON is key-order independent', () => {
  assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }));
});
