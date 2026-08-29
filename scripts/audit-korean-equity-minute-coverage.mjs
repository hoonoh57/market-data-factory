import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createMySqlPool } from '../src/db/mysql.mjs';

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function median(values) {
  if (!values.length) return 0;
  const xs = [...values].sort((a, b) => a - b);
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

const from = String(arg('--from', '2026-08-01'));
const to = String(arg('--to', '2026-08-31'));
const output = path.resolve(arg('--output', '.runtime/audit/minute-coverage.json'));
const pool = createMySqlPool();

try {
  const [dailyRows] = await pool.query(
    `SELECT DATE_FORMAT(d.trading_date, '%Y-%m-%d') AS trading_date,
            COUNT(DISTINCT d.instrument_id) AS eligible_instruments
     FROM korean_equity_daily d
     WHERE d.trading_date BETWEEN ? AND ?
     GROUP BY d.trading_date
     ORDER BY d.trading_date`,
    [from, to],
  );

  // Coverage is counted only inside the point-in-time daily eligible universe.
  // Minute rows that do not have a matching daily instrument-day are reported separately
  // instead of inflating the coverage numerator.
  const [minuteRows] = await pool.query(
    `SELECT DATE_FORMAT(m.trading_date, '%Y-%m-%d') AS trading_date,
            m.instrument_id,
            COUNT(*) AS bar_count,
            DATE_FORMAT(MIN(m.bar_timestamp), '%H:%i:%s') AS first_bar,
            DATE_FORMAT(MAX(m.bar_timestamp), '%H:%i:%s') AS last_bar
     FROM korean_equity_minute_1m m
     JOIN korean_equity_daily d
       ON d.instrument_id = m.instrument_id
      AND d.trading_date = m.trading_date
     WHERE m.trading_date BETWEEN ? AND ?
     GROUP BY m.trading_date, m.instrument_id
     ORDER BY m.trading_date, m.instrument_id`,
    [from, to],
  );

  const [[orphanRow]] = await pool.query(
    `SELECT COUNT(*) AS orphan_instrument_days
     FROM (
       SELECT DISTINCT m.instrument_id, m.trading_date
       FROM korean_equity_minute_1m m
       LEFT JOIN korean_equity_daily d
         ON d.instrument_id = m.instrument_id
        AND d.trading_date = m.trading_date
       WHERE m.trading_date BETWEEN ? AND ?
         AND d.instrument_id IS NULL
     ) x`,
    [from, to],
  );

  const dailyByDate = new Map(dailyRows.map(row => [String(row.trading_date), Number(row.eligible_instruments)]));
  const grouped = new Map();
  for (const row of minuteRows) {
    const day = String(row.trading_date);
    if (!grouped.has(day)) grouped.set(day, []);
    grouped.get(day).push({
      instrument_id: Number(row.instrument_id),
      bar_count: Number(row.bar_count),
      first_bar: row.first_bar,
      last_bar: row.last_bar,
    });
  }

  const days = [...new Set([...dailyByDate.keys(), ...grouped.keys()])].sort();
  const daySummaries = [];
  let totalEligible = 0;
  let totalCovered = 0;
  for (const day of days) {
    const rows = grouped.get(day) ?? [];
    const expectedUniverse = dailyByDate.get(day) ?? 0;
    const barCounts = rows.map(row => row.bar_count).filter(value => value > 0);
    const typicalBars = median(barCounts);
    const completeThreshold = typicalBars > 0 ? typicalBars * 0.95 : 0;
    const complete = rows.filter(row => row.bar_count >= completeThreshold).length;
    const partial = rows.length - complete;
    totalEligible += expectedUniverse;
    totalCovered += rows.length;
    daySummaries.push({
      trading_date: day,
      eligible_instruments: expectedUniverse,
      minute_instruments: rows.length,
      instrument_coverage_ratio: expectedUniverse ? rows.length / expectedUniverse : null,
      typical_bar_count: typicalBars,
      complete_instruments: complete,
      partial_instruments: partial,
      complete_ratio_within_minute_universe: rows.length ? complete / rows.length : null,
    });
  }

  const [monthRows] = await pool.query(
    `SELECT DATE_FORMAT(m.trading_date, '%Y-%m') AS month,
            COUNT(*) AS row_count,
            COUNT(DISTINCT m.instrument_id) AS instrument_count,
            COUNT(DISTINCT m.trading_date) AS trading_days
     FROM korean_equity_minute_1m m
     JOIN korean_equity_daily d
       ON d.instrument_id = m.instrument_id
      AND d.trading_date = m.trading_date
     WHERE m.trading_date BETWEEN ? AND ?
     GROUP BY DATE_FORMAT(m.trading_date, '%Y-%m')
     ORDER BY month`,
    [from, to],
  );

  const report = {
    dataset: 'korean_equity_minute_1m',
    requested_range: { from, to },
    methodology: {
      universe_denominator: 'distinct instruments in korean_equity_daily per trading date',
      coverage_numerator: 'distinct minute instrument-days INNER JOINed to the same daily eligible instrument-day',
      typical_bar_count: 'median bar_count among eligible instruments that have minute rows on that date',
      complete_rule: 'bar_count >= 95% of that date median; this is a coverage diagnostic, not an exchange-session truth contract',
    },
    summary: {
      trading_days: daySummaries.length,
      eligible_instrument_days: totalEligible,
      covered_instrument_days: totalCovered,
      missing_instrument_days: Math.max(0, totalEligible - totalCovered),
      overall_instrument_day_coverage_ratio: totalEligible ? totalCovered / totalEligible : null,
      orphan_minute_instrument_days: Number(orphanRow?.orphan_instrument_days ?? 0),
    },
    months: monthRows.map(row => ({
      month: String(row.month),
      row_count: Number(row.row_count),
      instrument_count: Number(row.instrument_count),
      trading_days: Number(row.trading_days),
    })),
    days: daySummaries,
  };

  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report.summary, null, 2));
  console.log(`[PASS] minute coverage audit ${from}..${to} -> ${output}`);
} catch (error) {
  console.error(`[ERROR] minute coverage audit failed: ${error?.message ?? String(error)}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
