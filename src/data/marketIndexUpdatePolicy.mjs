export function nextIsoDay(isoDate) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid ISO date: ${isoDate}`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function buildIndexUpdatePlan({ codes, latestByCode, initialFrom, sessionDate }) {
  const uniqueCodes = [...new Set((codes ?? []).map(code => String(code).trim()).filter(Boolean))].sort();
  if (!uniqueCodes.length) throw new Error('At least one index code is required.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(initialFrom ?? ''))) throw new Error('initialFrom must be YYYY-MM-DD.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(sessionDate ?? ''))) throw new Error('sessionDate must be YYYY-MM-DD.');

  const latest = latestByCode instanceof Map ? latestByCode : new Map(Object.entries(latestByCode ?? {}));
  return uniqueCodes
    .map(code => ({
      code,
      from: latest.has(code) && latest.get(code) ? nextIsoDay(String(latest.get(code))) : String(initialFrom),
      to: String(sessionDate),
      existing: latest.has(code) && Boolean(latest.get(code)),
    }))
    .filter(item => item.from <= item.to);
}

export function groupIndexPlanByFrom(plan) {
  const groups = new Map();
  for (const item of plan ?? []) {
    if (!groups.has(item.from)) groups.set(item.from, []);
    groups.get(item.from).push(item.code);
  }
  return [...groups.entries()]
    .map(([from, codes]) => ({ from, codes: [...codes].sort() }))
    .sort((a, b) => a.from.localeCompare(b.from));
}
