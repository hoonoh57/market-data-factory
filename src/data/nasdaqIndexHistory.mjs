export const SOX_INDEX_CODE = 'SOX';

function numberValue(value, label, { allowMissing = false } = {}) {
  const raw = String(value ?? '').trim();
  if (allowMissing && (!raw || raw === '--' || raw === 'N/A')) return 0;
  const cleaned = raw.replace(/[$,%]/g, '').replace(/,/g, '').trim();
  if (!cleaned || !/^-?(?:\d+\.?\d*|\.\d+)$/.test(cleaned)) {
    throw new Error(`${label} must be numeric: ${raw}`);
  }
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) throw new Error(`${label} is not finite.`);
  return parsed;
}

function isoDate(value, label) {
  const raw = String(value ?? '').trim();
  let year;
  let month;
  let day;
  let match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw);
  if (match) {
    month = Number(match[1]);
    day = Number(match[2]);
    year = Number(match[3]);
  } else {
    match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    if (!match) throw new Error(`${label} must be MM/DD/YYYY or YYYY-MM-DD: ${raw}`);
    year = Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  const iso = date.toISOString().slice(0, 10);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
    throw new Error(`${label} has invalid calendar date: ${raw}`);
  }
  return iso;
}

function rowValue(row, ...names) {
  for (const name of names) {
    if (row && Object.prototype.hasOwnProperty.call(row, name)) return row[name];
  }
  return undefined;
}

export function parseNasdaqHistoricalPayload(payload, { code = SOX_INDEX_CODE } = {}) {
  const data = payload?.data;
  const rawRows = data?.tradesTable?.rows;
  if (!Array.isArray(rawRows)) {
    const status = payload?.status?.bCodeMessage?.[0]?.errorMessage || payload?.message || '';
    throw new Error(`Nasdaq ${code} historical payload has no tradesTable.rows${status ? `: ${status}` : ''}`);
  }

  const rows = rawRows.map((raw, index) => {
    const tradingDate = isoDate(rowValue(raw, 'date', 'tradeDate'), `${code}:row${index + 1}:date`);
    const open = numberValue(rowValue(raw, 'open', 'openPrice'), `${code}:${tradingDate}:open`);
    const high = numberValue(rowValue(raw, 'high', 'highPrice'), `${code}:${tradingDate}:high`);
    const low = numberValue(rowValue(raw, 'low', 'lowPrice'), `${code}:${tradingDate}:low`);
    const close = numberValue(rowValue(raw, 'close', 'closePrice', 'last'), `${code}:${tradingDate}:close`);
    const volumeNumber = numberValue(rowValue(raw, 'volume', 'shareVolume'), `${code}:${tradingDate}:volume`, { allowMissing: true });
    const volume = Math.max(0, Math.trunc(volumeNumber));

    // Nasdaq's historical index endpoint occasionally publishes an index row whose
    // reported high/low does not contain open/close (observed for SOX 2026-07-21).
    // For the SOX rebound signal we must preserve the provider values, not silently
    // manufacture corrected OHLC. Therefore reject only unusable/non-positive
    // levels here; downstream strategy work is based primarily on completed closes.
    if (Math.min(open, high, low, close) <= 0) {
      throw new Error(`${code}:${tradingDate} contains non-positive OHLC.`);
    }

    return { tradingDate, open, high, low, close, volume };
  });

  rows.sort((a, b) => a.tradingDate.localeCompare(b.tradingDate));
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i - 1].tradingDate === rows[i].tradingDate) {
      throw new Error(`Nasdaq ${code} duplicate date: ${rows[i].tradingDate}`);
    }
  }
  return rows;
}

function nyParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const value = Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return {
    year: Number(value.year), month: Number(value.month), day: Number(value.day),
    hour: Number(value.hour), minute: Number(value.minute),
  };
}

function isoFromParts(parts) {
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function previousIsoDay(iso) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export function latestEligibleUsCalendarDate(now = new Date(), { settlementBufferMinutes = 20 } = {}) {
  const p = nyParts(now);
  const today = isoFromParts(p);
  const minutes = p.hour * 60 + p.minute;
  const complete = minutes >= 16 * 60 + settlementBufferMinutes;
  return complete ? today : previousIsoDay(today);
}
