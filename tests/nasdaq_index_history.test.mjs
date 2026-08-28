import test from 'node:test';
import assert from 'node:assert/strict';

import {
  latestEligibleUsCalendarDate,
  parseNasdaqHistoricalPayload,
  SOX_INDEX_CODE,
} from '../src/data/nasdaqIndexHistory.mjs';

test('parseNasdaqHistoricalPayload normalizes Nasdaq SOX rows ascending', () => {
  const payload = {
    data: {
      tradesTable: {
        rows: [
          { date: '08/28/2026', open: '7,000.10', high: '7,100.20', low: '6,950.00', close: '7,050.30', volume: '--' },
          { date: '08/27/2026', open: '6,900', high: '7,020', low: '6,850', close: '7,000', volume: '1,234' },
        ],
      },
    },
  };
  const rows = parseNasdaqHistoricalPayload(payload, { code: SOX_INDEX_CODE });
  assert.deepEqual(rows.map(row => row.tradingDate), ['2026-08-27', '2026-08-28']);
  assert.equal(rows[0].volume, 1234);
  assert.equal(rows[1].volume, 0);
  assert.equal(rows[1].close, 7050.3);
});

test('parseNasdaqHistoricalPayload rejects malformed OHLC', () => {
  const payload = {
    data: { tradesTable: { rows: [
      { date: '08/28/2026', open: '100', high: '99', low: '95', close: '98', volume: '1' },
    ] } },
  };
  assert.throws(() => parseNasdaqHistoricalPayload(payload), /high is below OHLC maximum/);
});

test('latestEligibleUsCalendarDate respects New York close buffer during DST', () => {
  assert.equal(
    latestEligibleUsCalendarDate(new Date('2026-08-28T20:10:00Z')),
    '2026-08-27',
  );
  assert.equal(
    latestEligibleUsCalendarDate(new Date('2026-08-28T20:25:00Z')),
    '2026-08-28',
  );
});

test('latestEligibleUsCalendarDate respects New York close buffer during standard time', () => {
  assert.equal(
    latestEligibleUsCalendarDate(new Date('2026-01-15T21:10:00Z')),
    '2026-01-14',
  );
  assert.equal(
    latestEligibleUsCalendarDate(new Date('2026-01-15T21:25:00Z')),
    '2026-01-15',
  );
});
