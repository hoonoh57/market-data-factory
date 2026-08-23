import test from 'node:test';
import assert from 'node:assert/strict';
import { mysqlUrl } from '../src/db/mysql.mjs';

test('MYSQL-ENV-001 rejects missing MYSQL_URL', () => {
  assert.throws(() => mysqlUrl({}), /MYSQL_URL is required/);
});

test('MYSQL-ENV-002 accepts mysql connection URL with database', () => {
  const value = 'mysql://user:secret@127.0.0.1:3306/market_data';
  assert.equal(mysqlUrl({ MYSQL_URL: value }), value);
});

test('MYSQL-ENV-003 rejects URLs without database name', () => {
  assert.throws(() => mysqlUrl({ MYSQL_URL: 'mysql://user:secret@127.0.0.1:3306/' }), /database name/);
});
