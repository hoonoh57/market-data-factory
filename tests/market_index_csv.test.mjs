import test from 'node:test';
import assert from 'node:assert/strict';
import {
  indexCodeFromFilename,
  parseIndexDailyCsv,
  parseIndexMinuteCsv,
} from '../src/data/marketIndexCsv.mjs';

test('market index filenames accept only U001/U201', () => {
  assert.equal(indexCodeFromFilename('U001.csv'), 'U001');
  assert.equal(indexCodeFromFilename('u201.CSV'), 'U201');
  assert.equal(indexCodeFromFilename('U301.csv'), null);
  assert.equal(indexCodeFromFilename('005930.csv'), null);
});

test('market index daily CSV preserves decimal levels', () => {
  const rows = parseIndexDailyCsv(
    'date,open,high,low,close,volume\n' +
    '2026-08-26,3245.12,3260.5,3230.25,3255.75,123456\n',
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tradingDate, '2026-08-26');
  assert.equal(rows[0].close, 3255.75);
  assert.equal(rows[0].volume, 123456);
});

test('market index minute CSV preserves exact timestamp and decimals', () => {
  const rows = parseIndexMinuteCsv(
    'timestamp,open,high,low,close,volume\n' +
    '2026-08-26T09:01,3245.1,3246.2,3244.9,3246.0,100\n' +
    '2026-08-26T09:02,3246.0,3247.0,3245.5,3246.8,120\n',
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].mysqlTimestamp, '2026-08-26 09:01:00');
  assert.equal(rows[1].close, 3246.8);
});

test('market index CSV rejects duplicate/out-of-order and invalid OHLC', () => {
  assert.throws(() => parseIndexDailyCsv(
    'date,open,high,low,close,volume\n' +
    '2026-08-26,100,101,99,100,1\n' +
    '2026-08-26,100,101,99,100,1\n',
  ), /strictly ascending/);

  assert.throws(() => parseIndexMinuteCsv(
    'timestamp,open,high,low,close,volume\n' +
    '2026-08-26T09:01,100,99,98,100,1\n',
  ), /high is below OHLC maximum/);
});
