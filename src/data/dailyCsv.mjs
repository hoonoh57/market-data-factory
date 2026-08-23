import path from 'node:path';

export const DAILY_HEADERS = Object.freeze(['date', 'open', 'high', 'low', 'close', 'volume', 'amount']);

export function parseCsvLine(line) {
  const values = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') { current += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else current += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { values.push(current); current = ''; }
    else current += char;
  }
  if (quoted) throw new Error('CSV contains an unterminated quoted field.');
  values.push(current);
  return values;
}

function positiveInteger(value, label) {
  if (!/^\d+$/.test(String(value ?? ''))) throw new Error(`${label} must be a non-negative integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} is outside the safe integer range.`);
  return parsed;
}

function date(value) {
  const text = String(value ?? '');
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) throw new Error(`Invalid trading date: ${text}`);
  const parsed = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (parsed.toISOString().slice(0, 10) !== text) throw new Error(`Invalid trading date: ${text}`);
  return text;
}

export function parseDailyCsv(text, { source = 'daily.csv' } = {}) {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  if (!lines.length) throw new Error(`${source} is empty.`);
  const headers = parseCsvLine(lines[0]);
  if (headers.length !== DAILY_HEADERS.length || headers.some((value, index) => value !== DAILY_HEADERS[index])) {
    throw new Error(`${source} schema must be: ${DAILY_HEADERS.join(',')}`);
  }
  const rows = [];
  let previous = '';
  for (let index = 1; index < lines.length; index += 1) {
    const values = parseCsvLine(lines[index]);
    if (values.length !== DAILY_HEADERS.length) throw new Error(`${source} column mismatch at row ${index + 1}.`);
    const raw = Object.fromEntries(DAILY_HEADERS.map((header, column) => [header, values[column]]));
    const tradingDate = date(raw.date);
    if (previous && tradingDate <= previous) throw new Error(`${source} dates must be strictly ascending: ${previous} -> ${tradingDate}.`);
    previous = tradingDate;
    const row = {
      tradingDate,
      open: positiveInteger(raw.open, `${source}:${tradingDate}:open`),
      high: positiveInteger(raw.high, `${source}:${tradingDate}:high`),
      low: positiveInteger(raw.low, `${source}:${tradingDate}:low`),
      close: positiveInteger(raw.close, `${source}:${tradingDate}:close`),
      volume: positiveInteger(raw.volume, `${source}:${tradingDate}:volume`),
      amount: positiveInteger(raw.amount, `${source}:${tradingDate}:amount`),
    };
    if (Math.min(row.open, row.high, row.low, row.close) <= 0) throw new Error(`${source}:${tradingDate} contains a non-positive price.`);
    if (row.high < Math.max(row.open, row.low, row.close)) throw new Error(`${source}:${tradingDate} high is below OHLC maximum.`);
    if (row.low > Math.min(row.open, row.high, row.close)) throw new Error(`${source}:${tradingDate} low is above OHLC minimum.`);
    rows.push(row);
  }
  return rows;
}

export function stockCodeFromDailyFilename(file) {
  const name = path.basename(String(file));
  const match = /^(\d{6})\.csv$/i.exec(name);
  return match ? match[1] : null;
}
