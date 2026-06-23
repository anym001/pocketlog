// Unit tests for the pure aggregation helpers extracted into
// frontend/reportsData.js.
import { describe, expect, it } from 'vitest';
import reportsData from '../reportsData.js';

const {
  _sumByType,
  _totalsByCategory,
  _tagColor,
  _totalsByTag,
  _goalProgress,
  _budgetPeriod,
  _budgetUsage,
  _monthSpan,
  _autoGranularity,
} = reportsData;

describe('_tagColor', () => {
  it('is deterministic — same name, same color', () => {
    expect(_tagColor('abo')).toBe(_tagColor('abo'));
  });

  it('returns a valid hsl() string with hue 0–359', () => {
    const m = _tagColor('urlaub').match(/^hsl\((\d+)deg 58% 52%\)$/);
    expect(m).not.toBeNull();
    expect(parseInt(m[1], 10)).toBeLessThan(360);
  });
});

describe('_totalsByTag', () => {
  it('sums per tag, sorted by amount desc, full amount per tag', () => {
    const txs = [
      { type: 'out', amount: 10, tags: ['a', 'b'] },
      { type: 'out', amount: 5, tags: ['a'] },
      { type: 'in', amount: 99, tags: ['a'] }, // wrong type, ignored
      { type: 'out', amount: 7, tags: [] }, // untagged, ignored
      { type: 'out', amount: 3 }, // no tags field, ignored
    ];
    expect(_totalsByTag(txs, 'out')).toEqual([
      { name: 'a', amount: 15 },
      { name: 'b', amount: 10 },
    ]);
  });

  it('returns an empty list when nothing matches', () => {
    expect(_totalsByTag([{ type: 'in', amount: 1, tags: ['x'] }], 'out')).toEqual([]);
  });
});

describe('_monthSpan', () => {
  it('counts calendar months inclusively', () => {
    expect(_monthSpan('2026-01-01', '2026-01-31')).toBe(1);
    expect(_monthSpan('2026-01-15', '2026-12-01')).toBe(12);
    expect(_monthSpan('2025-11-01', '2026-02-28')).toBe(4);
  });
});

describe('_autoGranularity', () => {
  it('picks month under 24 months, quarter up to 60, year beyond', () => {
    expect(_autoGranularity('2025-01-01', '2026-11-30')).toBe('month'); // 23
    expect(_autoGranularity('2025-01-01', '2026-12-31')).toBe('quarter'); // 24
    expect(_autoGranularity('2022-01-01', '2026-12-31')).toBe('quarter'); // 60
    expect(_autoGranularity('2022-01-01', '2027-01-31')).toBe('year'); // 61
  });
});

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

describe('_budgetPeriod', () => {
  it('monthly returns the single calendar month', () => {
    expect(_budgetPeriod('monthly', 2026, 5)).toEqual({
      from: '2026-06-01',
      to: '2026-06-30',
    });
  });

  it('monthly handles February (28 days in 2026)', () => {
    expect(_budgetPeriod('monthly', 2026, 1)).toEqual({
      from: '2026-02-01',
      to: '2026-02-28',
    });
  });

  it('quarterly snaps any month to its containing calendar quarter', () => {
    // April (month 3) → Q2 = Apr–Jun.
    expect(_budgetPeriod('quarterly', 2026, 3)).toEqual({
      from: '2026-04-01',
      to: '2026-06-30',
    });
    // December (month 11) → Q4 = Oct–Dec.
    expect(_budgetPeriod('quarterly', 2026, 11)).toEqual({
      from: '2026-10-01',
      to: '2026-12-31',
    });
    // January (month 0) → Q1 = Jan–Mar.
    expect(_budgetPeriod('quarterly', 2026, 0)).toEqual({
      from: '2026-01-01',
      to: '2026-03-31',
    });
  });

  it('yearly spans the whole calendar year regardless of month', () => {
    expect(_budgetPeriod('yearly', 2026, 7)).toEqual({
      from: '2026-01-01',
      to: '2026-12-31',
    });
  });
});

describe('_budgetUsage', () => {
  const budget = { category_id: 5, amount: '300' };

  it('sums only out rows of the category within the period', () => {
    const pool = [
      { category_id: 5, type: 'out', date: '2026-06-10', amount: 100 },
      { category_id: 5, type: 'out', date: '2026-06-20', amount: 50 },
      { category_id: 5, type: 'in', date: '2026-06-15', amount: 999 }, // wrong type
      { category_id: 9, type: 'out', date: '2026-06-15', amount: 999 }, // wrong category
      { category_id: 5, type: 'out', date: '2026-05-31', amount: 999 }, // before period
      { category_id: 5, type: 'out', date: '2026-07-01', amount: 999 }, // after period
    ];
    const u = _budgetUsage(budget, pool, '2026-06-01', '2026-06-30');
    expect(u.spentCents).toBe(15000);
    expect(u.limitCents).toBe(30000);
    expect(u.pct).toBe(50);
    expect(u.remainingCents).toBe(15000);
    expect(u.over).toBe(false);
  });

  it('flags over-budget and clamps pct while rawPct keeps the overshoot', () => {
    const pool = [{ category_id: 5, type: 'out', date: '2026-06-10', amount: 450 }];
    const u = _budgetUsage(budget, pool, '2026-06-01', '2026-06-30');
    expect(u.spentCents).toBe(45000);
    expect(u.pct).toBe(100); // clamped
    expect(u.rawPct).toBe(150);
    expect(u.remainingCents).toBe(-15000);
    expect(u.over).toBe(true);
  });

  it('exactly at the limit is not over budget', () => {
    const pool = [{ category_id: 5, type: 'out', date: '2026-06-10', amount: 300 }];
    const u = _budgetUsage(budget, pool, '2026-06-01', '2026-06-30');
    expect(u.spentCents).toBe(30000);
    expect(u.remainingCents).toBe(0);
    expect(u.over).toBe(false);
  });

  it('sums money in integer cents (no float drift)', () => {
    const pool = [
      { category_id: 5, type: 'out', date: '2026-06-10', amount: 0.1 },
      { category_id: 5, type: 'out', date: '2026-06-11', amount: 0.2 },
    ];
    const u = _budgetUsage(budget, pool, '2026-06-01', '2026-06-30');
    expect(u.spentCents).toBe(30); // 0.1 + 0.2 === 30 cents exactly
  });
});
