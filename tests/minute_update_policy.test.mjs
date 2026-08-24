import test from 'node:test';
import assert from 'node:assert/strict';
import { minuteUpdateDecision } from '../src/data/minuteUpdatePolicy.mjs';

test('MINUTE-UPDATE-001 skips current KST session before 20:00', () => {
  const decision = minuteUpdateDecision(new Date('2026-08-24T00:20:00Z'));
  assert.equal(decision.action, 'SKIP');
  assert.equal(decision.kstDate, '2026-08-24');
  assert.equal(decision.reason, 'CURRENT_TRADING_SESSION_INCOMPLETE');
});

test('MINUTE-UPDATE-002 runs at 20:00 KST or later', () => {
  const decision = minuteUpdateDecision(new Date('2026-08-24T11:00:00Z'));
  assert.equal(decision.action, 'RUN');
  assert.equal(decision.kstDate, '2026-08-24');
});
