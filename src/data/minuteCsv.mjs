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

function integer(value, label) {
  if (!/^-?\d+$/.test(String(value ?? '').trim())) throw new Error(`${label} must be an integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} exceeds safe integer range.`);
  return parsed;
}

function timestamp(value, label) {
  const text = String(value ?? '').trim();
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(text);
  if (!match) throw new Error(`${label} must be exact YYYY-MM-DDTHH:MM.`);
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  if (hour > 23 || minute > 59) throw new Error(`${label} has invalid clock time.`);
  const [year, month, day] = match[1].split('-').map(Number);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new Error(`${label} has invalid calendar date.`);
  }
  return { text, tradingDate: match[1], mysqlTimestamp: `${match[1]} ${match[2]}:${match[3]}:00` };
}

export function stockCodeFromMinuteFilename(file) {
  const match = /^([0-9A-Z]{6})\.csv$/i.exec(String(file ?? ''));
  return match ? match[1].toUpperCase() : null;
}

export function parseMinuteCsv(text, { source = 'minute.csv' } = {}) {
  const lines = String(text ?? '').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  if (!lines.length) throw new Error(`${source} is empty.`);
  const headers = parseCsvLine(lines[0]);
  const expected = ['timestamp', 'open', 'high', 'low', 'close', 'volume', 'amount'];
  if (headers.length !== expected.length || headers.some((value, index) => value !== expected[index])) {
    throw new Error(`${source} schema must be: ${expected.join(',')}`);
  }

  const rows = [];
  let previous = '';
  for (let index = 1; index < lines.length; index += 1) {
    const values = parseCsvLine(lines[index]);
    if (values.length !== expected.length) throw new Error(`${source} column mismatch at row ${index + 1}.`);
    const raw = Object.fromEntries(expected.map((name, offset) => [name, values[offset]]));
    const stamp = timestamp(raw.timestamp, `${source}:${index + 1}:timestamp`);
    if (previous && stamp.text <= previous) throw new Error(`${source} timestamp order/duplicate at ${stamp.text}.`);
    previous = stamp.text;

    const row = {
      timestamp: stamp.text,
      mysqlTimestamp: stamp.mysqlTimestamp,
      tradingDate: stamp.tradingDate,
      open: integer(raw.open, `${source}:${index + 1}:open`),
      high: integer(raw.high, `${source}:${index + 1}:high`),
      low: integer(raw.low, `${source}:${index + 1}:low`),
      close: integer(raw.close, `${source}:${index + 1}:close`),
      volume: integer(raw.volume, `${source}:${index + 1}:volume`),
      amount: integer(raw.amount, `${source}:${index + 1}:amount`),
    };
    if (Math.min(row.open, row.high, row.low, row.close) <= 0) throw new Error(`${source} non-positive price at ${stamp.text}.`);
    if (row.volume < 0 || row.amount < 0) throw new Error(`${source} negative quantity at ${stamp.text}.`);
    if (row.high < Math.max(row.open, row.low, row.close)) throw new Error(`${source} invalid high at ${stamp.text}.`);
    if (row.low > Math.min(row.open, row.high, row.close)) throw new Error(`${source} invalid low at ${stamp.text}.`);
    rows.push(row);
  }
  return rows;
}
