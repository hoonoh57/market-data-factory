import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MATERIALIZER = path.join(ROOT, 'scripts', 'materialize-market-data-parquet.mjs');
const CONVERTER = path.join(ROOT, 'scripts', 'csv-to-parquet.py');

test('materializer uses shared MySQL authority and immutable generation contract', () => {
  const text = readFileSync(MATERIALIZER, 'utf8');
  assert.match(text, /withMySqlConnection/);
  assert.match(text, /generationRoot/);
  assert.match(text, /source dataset changed during cache materialization/);
  assert.match(text, /CACHE_EVENT/);
  assert.doesNotMatch(text, /MYSQL_PASSWORD|MYSQL_HOST|createConnection\s*\(/);
});

test('materializer JavaScript parses without connecting to MySQL', () => {
  const result = spawnSync(process.execPath, ['--check', MATERIALIZER], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('Parquet converter remains storage-only and uses compressed Parquet', () => {
  const text = readFileSync(CONVERTER, 'utf8');
  assert.match(text, /pyarrow\.parquet/);
  assert.match(text, /compression="zstd"/);
  assert.doesNotMatch(text.toLowerCase(), /pymysql|mysql_host|select\s+/);
});

test('64-bit dependency file pins the Parquet implementation', () => {
  const text = readFileSync(path.join(ROOT, 'requirements-64bit.txt'), 'utf8');
  assert.match(text, /^pyarrow==25\.0\.1$/m);
});
