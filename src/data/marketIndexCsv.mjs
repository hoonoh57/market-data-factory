import path from 'node:path';
import { parseCsvLine } from './dailyCsv.mjs';

export const INDEX_CODES = Object.freeze(['U001', 'U201']);
export const INDEX_DAILY_HEADERS = Object.freeze(['date', 'open', 'high', 'low', 'close', 'volume']);
export const INDEX_MINUTE_HEADERS = Object.freeze(['timestamp', 'open', 'high', 'low', 'close', 'volume']);

function decimal(value, label) {
  const text = String(value ?? '').trim();
  if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(text)) throw new Error(`${label} must be a decimal number.`);
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) throw new Error(`${label} is not finite.`);
  return parsed;
}

function nonNegativeInteger(value, label) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) throw new Error(`${label} must be a non-negative integer.`);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} is outside the safe integer range.`);
  return parsed;
}

function tradingDate(value, label) {
  const text = String(value ?? '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) throw new Error(`${label} must be YYYY-MM-DD.`);
  const parsed = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (parsed.toISOString().slice(0, 10) !== text) throw new Error(`${label} has invalid calendar date.`);
  return text;
}

function minuteTimestamp(value, label) {
  const text = String(value ?? '').trim();
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(text);
  if (!match) throw new Error(`${label} must be exact YYYY-MM-DDTHH:MM.`);
  const date = tradingDate(match[1], label);
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  if (hour > 23 || minute > 59) throw new Error(`${label} has invalid clock time.`);
  return {
    text,
    tradingDate: date,
    mysqlTimestamp: `${date} ${match[2]}:${match[3]}:00`,
  };
}

function validateOhlc(row, label) {
  if (Math.min(row.open, row.high, row.low, row.close) <= 0) throw new Error(`${label} contains a non-positive index level.`);
  if (row.high < Math.max(row.open, row.low, row.close)) throw new Error(`${label} high is below OHLC maximum.`);
  if (row.low > Math.min(row.open, row.high, row.close)) throw new Error(`${label} low is above OHLC minimum.`);
}

function rowsFromCsv(text, expected, source) {
  const lines = String(text ?? '').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  if (!lines.length) throw new Error(`${source} is empty.`);
  const headers = parseCsvLine(lines[0]);
  if (headers.length !== expected.length || headers.some((value, index) => value !== expected[index])) {
    throw new Error(`${source} schema must be: ${expected.join(',')}`);
  }
  return lines.slice(1).map((line, index) => {
    const values = parseCsvLine(line);
    if (values.length !== expected.length) throw new Error(`${source} column mismatch at row ${index + 2}.`);
    return Object.fromEntries(expected.map((name, offset) => [name, values[offset]]));
  });
}

export function indexCodeFromFilename(file) {
  const name = path.basename(String(file ?? '')).toUpperCase();
  const match = /^(U\d{3})\.CSV$/.exec(name);
  return match && INDEX_CODES.includes(match[1]) ? match[1] : null;
}

export function parseIndexDailyCsv(text, { source = 'index-daily.csv' } = {}) {
  const rawRows = rowsFromCsv(text, INDEX_DAILY_HEADERS, source);
  const rows = [];
  let previous = '';
  for (let index = 0; index < rawRows.length; index += 1) {
    const raw = rawRows[index];
    const date = tradingDate(raw.date, `${source}:${index + 2}:date`);
    if (previous && date <= previous) throw new Error(`${source} dates must be strictly ascending: ${previous} -> ${date}.`);
    previous = date;
    const row = {
      tradingDate: date,
      open: decimal(raw.open, `${source}:${date}:open`),
      high: decimal(raw.high, `${source}:${date}:high`),
      low: decimal(raw.low, `${source}:${date}:low`),
      close: decimal(raw.close, `${source}:${date}:close`),
      volume: nonNegativeInteger(raw.volume, `${source}:${date}:volume`),
    };
    validateOhlc(row, `${source}:${date}`);
    rows.push(row);
  }
  return rows;
}

export function parseIndexMinuteCsv(text, { source = 'index-minute.csv' } = {}) {
  const rawRows = rowsFromCsv(text, INDEX_MINUTE_HEADERS, source);
  const rows = [];
  let previous = '';
  for (let index = 0; index < rawRows.length; index += 1) {
    const raw = rawRows[index];
    const stamp = minuteTimestamp(raw.timestamp, `${source}:${index + 2}:timestamp`);
    if (previous && stamp.text <= previous) throw new Error(`${source} timestamp order/duplicate at ${stamp.text}.`);
    previous = stamp.text;
    const row = {
      timestamp: stamp.text,
      mysqlTimestamp: stamp.mysqlTimestamp,
      tradingDate: stamp.tradingDate,
      open: decimal(raw.open, `${source}:${stamp.text}:open`),
      high: decimal(raw.high, `${source}:${stamp.text}:high`),
      low: decimal(raw.low, `${source}:${stamp.text}:low`),
      close: decimal(raw.close, `${source}:${stamp.text}:close`),
      volume: nonNegativeInteger(raw.volume, `${source}:${stamp.text}:volume`),
    };
    validateOhlc(row, `${source}:${stamp.text}`);
    rows.push(row);
  }
  return rows;
}
