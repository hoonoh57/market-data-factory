import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createMySqlPool } from '../src/db/mysql.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'addons', 'korean-equity-minute-1m', 'schema.sql');
const sql = await readFile(file, 'utf8');
const statements = sql.split(/;\s*(?:\r?\n|$)/).map(value => value.trim()).filter(Boolean);
const pool = createMySqlPool({ overrides: { multipleStatements: false } });

try {
  const [[instrumentTable]] = await pool.query("SHOW TABLES LIKE 'market_instrument'");
  if (!instrumentTable) throw new Error('market_instrument is missing. Apply/import korean-equity-daily first.');
  for (const statement of statements) await pool.query(statement);
  console.log('[PASS] korean-equity-minute-1m schema applied');
} catch (error) {
  console.error(`[ERROR] korean-equity-minute-1m schema failed: ${error?.message ?? String(error)}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
