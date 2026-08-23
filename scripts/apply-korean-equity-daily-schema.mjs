import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMySqlPool } from '../src/db/mysql.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schemaFile = path.join(root, 'addons', 'korean-equity-daily', 'schema.sql');
const sql = await readFile(schemaFile, 'utf8');
const pool = createMySqlPool({ overrides: { multipleStatements: true } });

try {
  await pool.query(sql);
  console.log('[PASS] korean-equity-daily schema applied');
} catch (error) {
  console.error(`[ERROR] schema apply failed: ${error?.message ?? String(error)}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
