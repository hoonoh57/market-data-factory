import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDailyCsv, stockCodeFromDailyFilename } from '../src/data/dailyCsv.mjs';

test('DAILY-CSV-001 parses canonical adjusted daily rows', () => {
  const rows = parseDailyCsv('date,open,high,low,close,volume,amount\n2026-08-20,100,120,90,110,1000,110000\n2026-08-21,111,130,105,125,2000,250000\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[1].tradingDate, '2026-08-21');
  assert.equal(rows[1].amount, 250000);
});

test('DAILY-CSV-002 rejects schema drift', () => {
  assert.throws(() => parseDailyCsv('date,open,close\n2026-08-21,1,1\n'), /schema must be/);
});

test('DAILY-CSV-003 rejects invalid OHLC', () => {
  assert.throws(() => parseDailyCsv('date,open,high,low,close,volume,amount\n2026-08-21,100,90,80,95,1,95\n'), /high is below/);
});

test('DAILY-CSV-004 recognizes six-character stock files only', () => {
  assert.equal(stockCodeFromDailyFilename('005930.csv'), '005930');
  assert.equal(stockCodeFromDailyFilename('0001A0.csv'), '0001A0');
  assert.equal(stockCodeFromDailyFilename('0001a0.csv'), '0001A0');
  assert.equal(stockCodeFromDailyFilename('universe.csv'), null);
  assert.equal(stockCodeFromDailyFilename('12345.csv'), null);
});
