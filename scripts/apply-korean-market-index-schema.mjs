import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createMySqlPool } from '../src/db/mysql.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'addons', 'korean-market-index', 'schema.sql');
const sql = await readFile(file, 'utf8');
const statements = sql.split(/;\s*(?:\r?\n|$)/).map(value => value.trim()).filter(Boolean);
const pool = createMySqlPool({ overrides: { multipleStatements: false } });

try {
  for (const statement of statements) await pool.query(statement);
  console.log('[PASS] korean-market-index schema applied');
} catch (error) {
  console.error(`[ERROR] korean-market-index schema failed: ${error?.message ?? String(error)}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
