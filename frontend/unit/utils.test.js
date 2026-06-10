// Unit tests for the pure helpers extracted into frontend/utils.js.
import { describe, expect, it } from 'vitest';
import utils from '../utils.js';

const {
  _iso,
  _daysInMonth,
  _escAttr,
  _escText,
  _parseAmountWith,
  _formatAmountWith,
  _recurringDaysInMonth,
  _recurringClampDay,
  _recurringAddMonths,
  _recurringMon0Weekday,
  _recurringCmp,
  _recurringMonthStep,
  _recurringFirstOnOrAfter,
  _recurringNextOccurrence,
} = utils;

describe('_iso', () => {
  it('formats a zero-based month into an ISO date', () => {
    expect(_iso(2026, 0, 1)).toBe('2026-01-01');
    expect(_iso(2026, 11, 31)).toBe('2026-12-31');
  });

  it('zero-pads month and day', () => {
    expect(_iso(2026, 4, 9)).toBe('2026-05-09');
  });
});

describe('_daysInMonth', () => {
  it('returns the day count for a zero-based month', () => {
    expect(_daysInMonth(2026, 0)).toBe(31); // January
    expect(_daysInMonth(2026, 3)).toBe(30); // April
  });

  it('handles February in a leap year', () => {
    expect(_daysInMonth(2024, 1)).toBe(29);
    expect(_daysInMonth(2026, 1)).toBe(28);
  });
});

describe('_escAttr', () => {
  it('escapes the HTML attribute metacharacters incl. quotes', () => {
    expect(_escAttr('a"b<c>d&e')).toBe('a&quot;b&lt;c&gt;d&amp;e');
  });

  it('coerces non-strings', () => {
    expect(_escAttr(42)).toBe('42');
  });
});

describe('_escText', () => {
  it('escapes text-content metacharacters', () => {
    expect(_escText('<b>&"')).toBe('&lt;b&gt;&amp;"');
  });

  it('collapses null/undefined to an empty string', () => {
    expect(_escText(null)).toBe('');
    expect(_escText(undefined)).toBe('');
  });
});

describe('_parseAmountWith', () => {
  it('parses comma-decimal input (de): dot is a thousands separator', () => {
    expect(_parseAmountWith('1.234,56', ',')).toBe(1234.56);
    expect(_parseAmountWith('12,5', ',')).toBe(12.5);
  });

  it('parses dot-decimal input (en): comma is a thousands separator', () => {
    expect(_parseAmountWith('1,234.56', '.')).toBe(1234.56);
    expect(_parseAmountWith('12.5', '.')).toBe(12.5);
  });

  it('strips currency symbols and whitespace', () => {
    expect(_parseAmountWith('1.234,56 €', ',')).toBe(1234.56);
    expect(_parseAmountWith('$ 1,234.56', '.')).toBe(1234.56);
  });

  it('keeps a leading minus sign', () => {
    expect(_parseAmountWith('-12,50', ',')).toBe(-12.5);
  });

  it('returns NaN for null/undefined and non-numeric input', () => {
    expect(_parseAmountWith(null, ',')).toBeNaN();
    expect(_parseAmountWith(undefined, ',')).toBeNaN();
    expect(_parseAmountWith('abc', ',')).toBeNaN();
  });
});

describe('_formatAmountWith', () => {
  it('formats with two decimals and the given separator', () => {
    expect(_formatAmountWith(12.5, ',')).toBe('12,50');
    expect(_formatAmountWith(12.5, '.')).toBe('12.50');
  });

  it('never adds a thousands separator', () => {
    expect(_formatAmountWith(1234.56, ',')).toBe('1234,56');
  });

  it('round-trips through _parseAmountWith losslessly', () => {
    for (const sep of [',', '.']) {
      for (const n of [0, 0.01, 12.5, 1234.56, 99999.99]) {
        expect(_parseAmountWith(_formatAmountWith(n, sep), sep)).toBe(n);
      }
    }
  });
});

describe('recurring schedule math', () => {
  it('_recurringDaysInMonth takes a 1-based month', () => {
    expect(_recurringDaysInMonth(2026, 1)).toBe(31);
    expect(_recurringDaysInMonth(2024, 2)).toBe(29); // leap year
    expect(_recurringDaysInMonth(2026, 2)).toBe(28);
  });

  it('_recurringClampDay clamps day-of-month to the month length', () => {
    expect(_recurringClampDay(2026, 2, 31)).toBe(28);
    expect(_recurringClampDay(2026, 1, 31)).toBe(31);
  });

  it('_recurringAddMonths rolls over year boundaries', () => {
    expect(_recurringAddMonths(2026, 11, 3)).toEqual([2027, 2]);
    expect(_recurringAddMonths(2026, 1, 12)).toEqual([2027, 1]);
  });

  it('_recurringMon0Weekday maps JS Sunday-first to backend Monday-first', () => {
    expect(_recurringMon0Weekday(2026, 6, 8)).toBe(0); // 2026-06-08 is a Monday
    expect(_recurringMon0Weekday(2026, 6, 14)).toBe(6); // Sunday
  });

  it('_recurringCmp orders {y,m,d} tuples', () => {
    expect(_recurringCmp({ y: 2026, m: 1, d: 2 }, { y: 2026, m: 1, d: 1 })).toBeGreaterThan(0);
    expect(_recurringCmp({ y: 2026, m: 1, d: 1 }, { y: 2026, m: 2, d: 1 })).toBeLessThan(0);
    expect(_recurringCmp({ y: 2026, m: 3, d: 3 }, { y: 2026, m: 3, d: 3 })).toBe(0);
  });

  it('_recurringMonthStep maps frequency to months', () => {
    expect(_recurringMonthStep('monthly')).toBe(1);
    expect(_recurringMonthStep('quarterly')).toBe(3);
    expect(_recurringMonthStep('yearly')).toBe(12);
  });

  describe('_recurringFirstOnOrAfter', () => {
    it('daily starts on the anchor itself', () => {
      expect(_recurringFirstOnOrAfter('daily', { y: 2026, m: 6, d: 10 })).toEqual({
        y: 2026,
        m: 6,
        d: 10,
      });
    });

    it('weekly advances to the target weekday', () => {
      // Anchor 2026-06-10 is a Wednesday (Mon0 = 2); Friday is weekday 4.
      expect(_recurringFirstOnOrAfter('weekly', { y: 2026, m: 6, d: 10 }, 4, null)).toEqual({
        y: 2026,
        m: 6,
        d: 12,
      });
    });

    it('weekly stays put when the anchor already matches', () => {
      expect(_recurringFirstOnOrAfter('weekly', { y: 2026, m: 6, d: 10 }, 2, null)).toEqual({
        y: 2026,
        m: 6,
        d: 10,
      });
    });

    it('monthly clamps day 31 to the month length', () => {
      expect(_recurringFirstOnOrAfter('monthly', { y: 2026, m: 2, d: 1 }, null, 31)).toEqual({
        y: 2026,
        m: 2,
        d: 28,
      });
    });

    it('monthly rolls into the next month when the day already passed', () => {
      expect(_recurringFirstOnOrAfter('monthly', { y: 2026, m: 6, d: 20 }, null, 5)).toEqual({
        y: 2026,
        m: 7,
        d: 5,
      });
    });
  });

  describe('_recurringNextOccurrence', () => {
    it('daily honours the interval', () => {
      expect(_recurringNextOccurrence('daily', 3, { y: 2026, m: 6, d: 29 })).toEqual({
        y: 2026,
        m: 7,
        d: 2,
      });
    });

    it('weekly is strictly after, even on the target weekday', () => {
      // 2026-06-08 is a Monday; next Monday with interval 1 is a week later.
      expect(_recurringNextOccurrence('weekly', 1, { y: 2026, m: 6, d: 8 }, 0, null)).toEqual({
        y: 2026,
        m: 6,
        d: 15,
      });
    });

    it('monthly clamps to short months but keeps the nominal day after', () => {
      // Day 31, stepping Jan → Feb → Mar: Feb clamps to 28, Mar returns to 31
      // because the nominal day-of-month is passed in each step.
      const feb = _recurringNextOccurrence('monthly', 1, { y: 2026, m: 1, d: 31 }, null, 31);
      expect(feb).toEqual({ y: 2026, m: 2, d: 28 });
      expect(_recurringNextOccurrence('monthly', 1, feb, null, 31)).toEqual({
        y: 2026,
        m: 3,
        d: 31,
      });
    });

    it('quarterly and yearly use the month step times interval', () => {
      expect(_recurringNextOccurrence('quarterly', 2, { y: 2026, m: 11, d: 15 }, null, 15)).toEqual(
        { y: 2027, m: 5, d: 15 },
      );
      expect(_recurringNextOccurrence('yearly', 1, { y: 2026, m: 2, d: 28 }, null, 29)).toEqual({
        y: 2027,
        m: 2,
        d: 28,
      });
    });

    it('treats interval 0/null as 1', () => {
      expect(_recurringNextOccurrence('monthly', 0, { y: 2026, m: 6, d: 1 }, null, 1)).toEqual({
        y: 2026,
        m: 7,
        d: 1,
      });
    });
  });
});
