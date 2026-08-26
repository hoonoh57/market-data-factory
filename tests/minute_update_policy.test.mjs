import test from 'node:test';
import assert from 'node:assert/strict';
import { minuteUpdateDecision } from '../src/data/minuteUpdatePolicy.mjs';

test('MINUTE-UPDATE-001 excludes today before 20:00 KST but still runs past catch-up', () => {
  const decision = minuteUpdateDecision(new Date('2026-08-26T22:35:00Z'));
  assert.equal(decision.action, 'RUN');
  assert.equal(decision.kstDate, '2026-08-27');
  assert.equal(decision.eligibleCalendarDate, '2026-08-26');
  assert.equal(decision.currentSessionComplete, false);
  assert.equal(decision.reason, 'CURRENT_TRADING_SESSION_INCOMPLETE_TODAY_EXCLUDED');
});

test('MINUTE-UPDATE-002 includes today at 20:00 KST or later', () => {
  const decision = minuteUpdateDecision(new Date('2026-08-27T11:00:00Z'));
  assert.equal(decision.action, 'RUN');
  assert.equal(decision.kstDate, '2026-08-27');
  assert.equal(decision.eligibleCalendarDate, '2026-08-27');
  assert.equal(decision.currentSessionComplete, true);
  assert.equal(decision.reason, 'CURRENT_TRADING_SESSION_COMPLETED');
});

test('MINUTE-UPDATE-003 19:59 KST still excludes today', () => {
  const decision = minuteUpdateDecision(new Date('2026-08-27T10:59:00Z'));
  assert.equal(decision.eligibleCalendarDate, '2026-08-26');
  assert.equal(decision.currentSessionComplete, false);
});
