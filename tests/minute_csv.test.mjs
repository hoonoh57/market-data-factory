import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMinuteCsv, stockCodeFromMinuteFilename } from '../src/data/minuteCsv.mjs';

test('MINUTE-CSV-001 parses exact minute OHLCVA rows', () => {
  const rows = parseMinuteCsv(
    'timestamp,open,high,low,close,volume,amount\n2026-08-21T09:00,100,110,95,105,12,1234\n',
    { source: '005930.csv' },
  );
  assert.deepEqual(rows[0], {
    timestamp: '2026-08-21T09:00',
    mysqlTimestamp: '2026-08-21 09:00:00',
    tradingDate: '2026-08-21',
    open: 100,
    high: 110,
    low: 95,
    close: 105,
    volume: 12,
    amount: 1234,
  });
});

test('MINUTE-CSV-002 rejects duplicate or unordered timestamps', () => {
  assert.throws(() => parseMinuteCsv(
    'timestamp,open,high,low,close,volume,amount\n2026-08-21T09:01,100,110,95,105,12,1234\n2026-08-21T09:00,100,110,95,105,12,1234\n',
  ), /timestamp order\/duplicate/);
});

test('MINUTE-CSV-003 rejects schema drift', () => {
  assert.throws(() => parseMinuteCsv('timestamp,open,close\n2026-08-21T09:00,100,105\n'), /schema must be/);
});

test('MINUTE-CSV-004 recognizes six-character stock filenames only', () => {
  assert.equal(stockCodeFromMinuteFilename('005930.csv'), '005930');
  assert.equal(stockCodeFromMinuteFilename('A12345.csv'), 'A12345');
  assert.equal(stockCodeFromMinuteFilename('selection.json'), null);
});
