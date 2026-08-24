const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

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
  const date = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  if (p.hour < completedSessionHourKst) {
    return {
      action: 'SKIP',
      reason: 'CURRENT_TRADING_SESSION_INCOMPLETE',
      kstDate: date,
      completedSessionHourKst,
    };
  }
  return {
    action: 'RUN',
    reason: 'CURRENT_TRADING_SESSION_COMPLETED',
    kstDate: date,
    completedSessionHourKst,
  };
}
