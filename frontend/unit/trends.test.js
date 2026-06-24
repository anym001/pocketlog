// Unit tests for the pure trend-math helpers extracted into
// frontend/reportsData.js. The focus is the calendar edge cases that are
// awkward to hit through the UI: quarter/year axis walking across year
// boundaries, the moving-average window clamping, and the year-over-year
// stats threshold.
import { describe, expect, it } from 'vitest';
import reportsData from '../reportsData.js';

const {
  _bucketKey,
  _bucketAxis,
  _movingAverage,
  _tagLineColor,
  _trendMatchesEntity,
  _signedTrendAmount,
  _monthlyTotals,
  _trendStats,
} = reportsData;

describe('_bucketKey', () => {
  it('keys by month, quarter and year', () => {
    expect(_bucketKey('2026-04-15', 'month')).toBe('2026-04');
    expect(_bucketKey('2026-04-15', 'quarter')).toBe('2026-Q2');
    expect(_bucketKey('2026-04-15', 'year')).toBe('2026');
  });

  it('puts the quarter boundaries on the right side', () => {
    expect(_bucketKey('2026-03-31', 'quarter')).toBe('2026-Q1');
    expect(_bucketKey('2026-10-01', 'quarter')).toBe('2026-Q4');
  });
});

describe('_bucketAxis', () => {
  it('walks months across a year boundary, inclusive', () => {
    expect(_bucketAxis('2025-11-01', '2026-02-20', 'month')).toEqual([
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
    ]);
  });

  it('walks quarters across a year boundary, inclusive', () => {
    expect(_bucketAxis('2025-11-15', '2026-04-10', 'quarter')).toEqual([
      '2025-Q4',
      '2026-Q1',
      '2026-Q2',
    ]);
  });

  it('walks years inclusive', () => {
    expect(_bucketAxis('2024-06-01', '2026-03-01', 'year')).toEqual(['2024', '2025', '2026']);
  });

  it('returns a single bucket when from and to share it', () => {
    expect(_bucketAxis('2026-04-02', '2026-04-28', 'month')).toEqual(['2026-04']);
  });

  it('returns empty when from is after to', () => {
    expect(_bucketAxis('2026-05-01', '2026-01-01', 'month')).toEqual([]);
  });
});

describe('_movingAverage', () => {
  it('is a no-op copy for window <= 1', () => {
    const input = [1, 2, 3];
    const out = _movingAverage(input, 1);
    expect(out).toEqual([1, 2, 3]);
    expect(out).not.toBe(input); // fresh array
  });

  it('centres the window and clamps at the edges', () => {
    expect(_movingAverage([1, 2, 3, 4, 5], 3)).toEqual([1.5, 2, 3, 4, 4.5]);
  });
});

describe('_tagLineColor', () => {
  it('is a deterministic hsl string in range', () => {
    const a = _tagLineColor('Groceries');
    const b = _tagLineColor('Groceries');
    expect(a).toBe(b);
    expect(a).toMatch(/^hsl\(\d{1,3}deg 55% 50%\)$/);
  });
});

describe('_trendMatchesEntity', () => {
  it('counts both spending and income', () => {
    const entity = { kind: 'category', catId: 1 };
    expect(_trendMatchesEntity({ type: 'out', category_id: 1 }, entity)).toBe(true);
    expect(_trendMatchesEntity({ type: 'in', category_id: 1 }, entity)).toBe(true);
  });

  it('matches a category by id and a tag by name', () => {
    expect(
      _trendMatchesEntity({ type: 'out', category_id: 7 }, { kind: 'category', catId: 7 }),
    ).toBe(true);
    expect(
      _trendMatchesEntity({ type: 'out', tags: ['food', 'fun'] }, { kind: 'tag', name: 'fun' }),
    ).toBe(true);
    expect(_trendMatchesEntity({ type: 'out', tags: ['food'] }, { kind: 'tag', name: 'fun' })).toBe(
      false,
    );
  });
});

describe('_signedTrendAmount', () => {
  it('counts income positive and spending negative', () => {
    expect(_signedTrendAmount({ type: 'in', amount: 50 })).toBe(50);
    expect(_signedTrendAmount({ type: 'out', amount: 50 })).toBe(-50);
  });
});

describe('_monthlyTotals', () => {
  it('nets income (+) against spending (-) per calendar month', () => {
    const entity = { kind: 'category', catId: 1 };
    const txs = [
      { type: 'out', category_id: 1, date: '2026-01-05', amount: 10 },
      { type: 'out', category_id: 1, date: '2026-01-20', amount: 5 },
      { type: 'out', category_id: 1, date: '2026-02-01', amount: 8 },
      { type: 'out', category_id: 2, date: '2026-01-09', amount: 99 }, // other category
      { type: 'in', category_id: 1, date: '2026-01-09', amount: 100 }, // income, +
    ];
    const map = _monthlyTotals(txs, entity);
    expect(map.get('2026-01')).toBe(85); // 100 income - 15 spending
    expect(map.get('2026-02')).toBe(-8); // spending only → negative
    expect(map.size).toBe(2);
  });
});

describe('_trendStats', () => {
  it('returns null for an empty span', () => {
    expect(_trendStats(new Map(), '2026-05', '2026-01')).toBeNull();
  });

  it('computes mean and peak over the inclusive month axis', () => {
    const map = new Map([
      ['2026-01', 100],
      ['2026-03', 200],
    ]);
    const stats = _trendStats(map, '2026-01', '2026-03');
    // axis = Jan, Feb(0), Mar → total 300 over 3 months
    expect(stats.monthCount).toBe(3);
    expect(stats.mean).toBe(100);
    expect(stats.peak).toEqual({ key: '2026-03', value: 200 });
    expect(stats.yoy).toBeNull();
  });

  it('picks the peak by magnitude, keeping the sign (net flow can be negative)', () => {
    const map = new Map([
      ['2026-01', 100],
      ['2026-02', -250],
    ]);
    const stats = _trendStats(map, '2026-01', '2026-02');
    expect(stats.peak).toEqual({ key: '2026-02', value: -250 });
  });

  it('computes year-over-year once each year has >= 3 months in the axis', () => {
    const map = new Map([
      ['2024-06', 300],
      ['2025-06', 600],
    ]);
    const stats = _trendStats(map, '2024-01', '2025-12');
    expect(stats.yoy).not.toBeNull();
    expect(stats.yoy.firstYear).toBe('2024');
    expect(stats.yoy.lastYear).toBe('2025');
    expect(stats.yoy.firstMean).toBe(25); // 300 / 12
    expect(stats.yoy.lastMean).toBe(50); // 600 / 12
    expect(stats.yoy.pct).toBe(100); // (50 - 25) / 25 * 100
  });

  it('drops a year with fewer than 3 months in the axis from yoy', () => {
    const map = new Map([
      ['2024-12', 120],
      ['2025-06', 600],
    ]);
    // 2024 contributes only Nov+Dec (2 months) → excluded → < 2 years → no yoy
    const stats = _trendStats(map, '2024-11', '2025-12');
    expect(stats.yoy).toBeNull();
  });
});
