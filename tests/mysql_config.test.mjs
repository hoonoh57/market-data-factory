import test from 'node:test';
import assert from 'node:assert/strict';
import { mysqlConfig, mysqlUrl } from '../src/db/mysql.mjs';

test('MYSQL-ENV-001 accepts split MySQL settings with default database', () => {
  assert.deepEqual(mysqlConfig({
    MYSQL_HOST: '127.0.0.1',
    MYSQL_PORT: '3306',
    MYSQL_USER: 'root',
    MYSQL_PASSWORD: 'secret',
  }), {
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    password: 'secret',
    database: 'market_data',
  });
});

test('MYSQL-ENV-002 accepts MYSQL_DATABASE override', () => {
  assert.equal(mysqlConfig({
    MYSQL_USER: 'root',
    MYSQL_PASSWORD: 'secret',
    MYSQL_DATABASE: 'research_data',
  }).database, 'research_data');
});

test('MYSQL-ENV-003 accepts MYSQL_URL as optional override', () => {
  const value = 'mysql://user:secret@127.0.0.1:3306/market_data';
  assert.equal(mysqlUrl({ MYSQL_URL: value }), value);
  assert.deepEqual(mysqlConfig({ MYSQL_URL: value }), { uri: value });
});

test('MYSQL-ENV-004 rejects missing MYSQL_USER without MYSQL_URL', () => {
  assert.throws(() => mysqlConfig({ MYSQL_PASSWORD: 'secret' }), /MYSQL_USER is required/);
});

test('MYSQL-ENV-005 rejects missing MYSQL_PASSWORD without MYSQL_URL', () => {
  assert.throws(() => mysqlConfig({ MYSQL_USER: 'root' }), /MYSQL_PASSWORD is required/);
});

test('MYSQL-ENV-006 rejects invalid port', () => {
  assert.throws(() => mysqlConfig({
    MYSQL_USER: 'root',
    MYSQL_PASSWORD: 'secret',
    MYSQL_PORT: 'abc',
  }), /MYSQL_PORT/);
});

test('MYSQL-ENV-007 rejects MYSQL_URL without database name', () => {
  assert.throws(() => mysqlConfig({ MYSQL_URL: 'mysql://user:secret@127.0.0.1:3306/' }), /database name/);
});
