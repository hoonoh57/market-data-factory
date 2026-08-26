const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function isoDayFromParts(p) {
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function previousIsoDay(isoDate) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export function kstParts(now = new Date()) {
  const shifted = new Date(now.getTime() + KST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

export function minuteUpdateDecision(now = new Date(), { completedSessionHourKst = 20 } = {}) {
  const p = kstParts(now);
  const kstDate = isoDayFromParts(p);
  const currentSessionComplete = p.hour >= completedSessionHourKst;
  return {
    action: 'RUN',
    reason: currentSessionComplete
      ? 'CURRENT_TRADING_SESSION_COMPLETED'
      : 'CURRENT_TRADING_SESSION_INCOMPLETE_TODAY_EXCLUDED',
    kstDate,
    eligibleCalendarDate: currentSessionComplete ? kstDate : previousIsoDay(kstDate),
    currentSessionComplete,
    completedSessionHourKst,
  };
}
