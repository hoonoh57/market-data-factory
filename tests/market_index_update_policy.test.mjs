import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIndexUpdatePlan,
  groupIndexPlanByFrom,
  nextIsoDay,
} from '../src/data/marketIndexUpdatePolicy.mjs';

test('nextIsoDay crosses month boundaries', () => {
  assert.equal(nextIsoDay('2026-08-31'), '2026-09-01');
});

test('new indexes backfill from canonical initial date', () => {
  const plan = buildIndexUpdatePlan({
    codes: ['U001', 'U201'],
    latestByCode: new Map(),
    initialFrom: '2026-02-23',
    sessionDate: '2026-08-26',
  });
  assert.deepEqual(plan, [
    { code: 'U001', from: '2026-02-23', to: '2026-08-26', existing: false },
    { code: 'U201', from: '2026-02-23', to: '2026-08-26', existing: false },
  ]);
});

test('existing indexes resume from own latest trading date plus one', () => {
  const plan = buildIndexUpdatePlan({
    codes: ['U001', 'U201'],
    latestByCode: new Map([
      ['U001', '2026-08-25'],
      ['U201', '2026-08-24'],
    ]),
    initialFrom: '2026-02-23',
    sessionDate: '2026-08-26',
  });
  assert.deepEqual(plan.map(x => [x.code, x.from]), [
    ['U001', '2026-08-26'],
    ['U201', '2026-08-25'],
  ]);
  assert.deepEqual(groupIndexPlanByFrom(plan), [
    { from: '2026-08-25', codes: ['U201'] },
    { from: '2026-08-26', codes: ['U001'] },
  ]);
});

test('already current indexes are omitted from plan', () => {
  const plan = buildIndexUpdatePlan({
    codes: ['U001', 'U201'],
    latestByCode: new Map([
      ['U001', '2026-08-26'],
      ['U201', '2026-08-26'],
    ]),
    initialFrom: '2026-02-23',
    sessionDate: '2026-08-26',
  });
  assert.deepEqual(plan, []);
});
