// Unit tests for the pure aggregation helpers extracted into
// frontend/reportsData.js.
import { describe, expect, it } from 'vitest';
import reportsData from '../reportsData.js';

const { _sumByType, _totalsByCategory, _goalProgress } = reportsData;

describe('_sumByType', () => {
  it('splits totals by in/out', () => {
    const txs = [
      { type: 'out', amount: 10 },
      { type: 'in', amount: 30 },
      { type: 'out', amount: 5 },
    ];
    expect(_sumByType(txs)).toEqual({ out: 15, in: 30 });
  });

  it('returns zeros for an empty list', () => {
    expect(_sumByType([])).toEqual({ out: 0, in: 0 });
  });
});

describe('_totalsByCategory', () => {
  it('sums per category for the requested type, sorted by amount desc', () => {
    const txs = [
      { type: 'out', category_id: 1, amount: 5 },
      { type: 'out', category_id: 2, amount: 20 },
      { type: 'out', category_id: 1, amount: 10 },
      { type: 'in', category_id: 3, amount: 99 }, // wrong type, ignored
    ];
    expect(_totalsByCategory(txs, 'out')).toEqual([
      { catId: 2, amount: 20 },
      { catId: 1, amount: 15 },
    ]);
  });

  it('defaults to type "out" and ignores other types', () => {
    const txs = [
      { type: 'out', category_id: 1, amount: 7 },
      { type: 'in', category_id: 1, amount: 100 },
    ];
    expect(_totalsByCategory(txs)).toEqual([{ catId: 1, amount: 7 }]);
  });
});

describe('_goalProgress', () => {
  const base = { category_id: 5, start_date: '2026-01-01' };

  it('computes savings progress including the initial amount', () => {
    const goal = { ...base, direction: 'save_up', initial_amount: '100', target_amount: '500' };
    const pool = [
      { category_id: 5, type: 'in', date: '2026-02-01', amount: 200 },
      { category_id: 5, type: 'out', date: '2026-02-01', amount: 999 }, // wrong type
      { category_id: 9, type: 'in', date: '2026-02-01', amount: 999 }, // wrong category
      { category_id: 5, type: 'in', date: '2025-12-31', amount: 999 }, // before start
    ];
    const p = _goalProgress(goal, pool);
    // (100 initial + 200 saved) / 500 target = 60%
    expect(p.pct).toBe(60);
    expect(p.primaryCents).toBe(30000);
    expect(p.targetCents).toBe(50000);
    expect(p.complete).toBe(false);
  });

  it('marks a savings goal complete once the target is reached and clamps pct', () => {
    const goal = { ...base, direction: 'save_up', initial_amount: '0', target_amount: '100' };
    const pool = [{ category_id: 5, type: 'in', date: '2026-03-01', amount: 150 }];
    const p = _goalProgress(goal, pool);
    expect(p.pct).toBe(100); // clamped from 150
    expect(p.rawPct).toBe(150);
    expect(p.complete).toBe(true);
  });

  it('computes debt pay-down progress against the repay span', () => {
    const goal = { ...base, direction: 'pay_down', initial_amount: '1000', target_amount: '0' };
    const pool = [{ category_id: 5, type: 'out', date: '2026-02-01', amount: 250 }];
    const p = _goalProgress(goal, pool);
    // repaid 250 of a 1000 span = 25%; 750 remaining
    expect(p.pct).toBe(25);
    expect(p.primaryCents).toBe(75000);
    expect(p.paidCents).toBe(25000);
    expect(p.complete).toBe(false);
  });

  it('sums money in integer cents (no float drift)', () => {
    const goal = { ...base, direction: 'save_up', initial_amount: '0', target_amount: '0.30' };
    const pool = [
      { category_id: 5, type: 'in', date: '2026-02-01', amount: 0.1 },
      { category_id: 5, type: 'in', date: '2026-02-01', amount: 0.2 },
    ];
    const p = _goalProgress(goal, pool);
    expect(p.primaryCents).toBe(30); // 0.1 + 0.2 === 30 cents exactly
    expect(p.complete).toBe(true);
  });
});
