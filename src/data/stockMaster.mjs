const CODE_PATTERN = /^A[0-9A-Z]{6}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const STOCK_MASTER_URL = 'https://raw.githubusercontent.com/hoonoh57/data/main/stock-code/stock_master.csv';

export function parseCsvLine(line) {
  const values = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { value += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else value += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { values.push(value); value = ''; }
    else value += ch;
  }
  if (quoted) throw new Error('stock_master.csv contains an unterminated quoted field.');
  values.push(value);
  return values;
}

export function parseStockMasterCsv(text) {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) throw new Error('stock_master.csv must contain data.');
  const headers = parseCsvLine(lines[0]);
  for (const required of ['code', 'name', 'market', 'krx300', 'krx300_as_of']) {
    if (!headers.includes(required)) throw new Error(`stock_master.csv missing ${required}`);
  }
  const rows = lines.slice(1).map(line => {
    const values = parseCsvLine(line);
    if (values.length !== headers.length) throw new Error('stock_master.csv column count mismatch.');
    return Object.fromEntries(headers.map((header, index) => [header, values[index]]));
  });
  const seen = new Set();
  const asOf = new Set();
  let krx300Count = 0;
  for (const row of rows) {
    row.code = String(row.code ?? '').trim().toUpperCase();
    row.krx300 = String(row.krx300 ?? '').trim();
    row.krx300_as_of = String(row.krx300_as_of ?? '').trim();
    if (!CODE_PATTERN.test(row.code)) throw new Error(`Invalid stock master code: ${row.code}`);
    if (seen.has(row.code)) throw new Error(`Duplicate stock master code: ${row.code}`);
    seen.add(row.code);
    if (!['0', '1'].includes(row.krx300)) throw new Error(`Invalid krx300 flag: ${row.code}`);
    if (!DATE_PATTERN.test(row.krx300_as_of)) throw new Error(`Invalid krx300_as_of: ${row.code}`);
    asOf.add(row.krx300_as_of);
    if (row.krx300 === '1') krx300Count += 1;
  }
  if (asOf.size !== 1) throw new Error('stock_master.csv must have one krx300_as_of date.');
  if (krx300Count !== 300) throw new Error(`stock_master.csv must expose exactly 300 KRX300 members, actual=${krx300Count}`);
  return { rows, krx300Count, krx300AsOf: [...asOf][0] };
}

export async function fetchStockMaster(fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(STOCK_MASTER_URL, { headers: { Accept: 'text/csv,text/plain;q=0.9,*/*;q=0.1' } });
  const text = await response.text();
  if (!response.ok) throw new Error(`stock master download failed HTTP ${response.status}`);
  return parseStockMasterCsv(text);
}
