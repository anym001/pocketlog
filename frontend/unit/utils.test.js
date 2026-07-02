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
  _filterTransactions,
  _passwordErrorKey,
  _importReport,
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

describe('_filterTransactions', () => {
  const catNames = { 1: 'Wohnen', 2: 'Freizeit' };
  const lookup = (id) => catNames[id] || 'Sonstiges';
  const txs = [
    { category_id: 1, desc: 'Miete Juni', tags: ['fixkosten'] },
    { category_id: 2, desc: 'Kino', tags: ['ausgehen', 'film'] },
    { category_id: 9, desc: 'Unbekannt', tags: null },
  ];

  it('drill-down by category ignores the text query', () => {
    const out = _filterTransactions(
      txs,
      { query: 'kino', categoryFilterId: 1, tagFilterName: null },
      lookup,
    );
    expect(out).toEqual([txs[0]]);
  });

  it('drill-down by tag requires array membership', () => {
    const out = _filterTransactions(
      txs,
      { query: '', categoryFilterId: null, tagFilterName: 'film' },
      lookup,
    );
    expect(out).toEqual([txs[1]]);
    // tags: null must not throw and must not match.
    const none = _filterTransactions(
      txs,
      { query: '', categoryFilterId: null, tagFilterName: 'nope' },
      lookup,
    );
    expect(none).toEqual([]);
  });

  it('text query matches description, category name and tags', () => {
    const byDesc = _filterTransactions(
      txs,
      { query: 'miete', categoryFilterId: null, tagFilterName: null },
      lookup,
    );
    expect(byDesc).toEqual([txs[0]]);
    const byCat = _filterTransactions(
      txs,
      { query: 'freizeit', categoryFilterId: null, tagFilterName: null },
      lookup,
    );
    expect(byCat).toEqual([txs[1]]);
    const byTag = _filterTransactions(
      txs,
      { query: 'fixkosten', categoryFilterId: null, tagFilterName: null },
      lookup,
    );
    expect(byTag).toEqual([txs[0]]);
  });

  it('matches the localized fallback name for a missing category', () => {
    const out = _filterTransactions(
      txs,
      { query: 'sonstiges', categoryFilterId: null, tagFilterName: null },
      lookup,
    );
    expect(out).toEqual([txs[2]]);
  });

  it('handles a missing description safely', () => {
    const out = _filterTransactions(
      [{ category_id: 1, tags: [] }],
      { query: 'x', categoryFilterId: null, tagFilterName: null },
      lookup,
    );
    expect(out).toEqual([]);
  });
});

describe('_passwordErrorKey', () => {
  const err = (type, ctx) => ({
    detail: [{ loc: ['body', 'password'], type, ctx }],
  });

  it('returns null for non-422 shapes and non-password errors', () => {
    expect(_passwordErrorKey(null)).toBeNull();
    expect(_passwordErrorKey({ detail: 'nope' })).toBeNull();
    expect(
      _passwordErrorKey({ detail: [{ loc: ['body', 'username'], type: 'string_too_short' }] }),
    ).toBeNull();
  });

  it('maps length errors with ctx bounds and falls back to the policy defaults', () => {
    expect(_passwordErrorKey(err('string_too_short', { min_length: 12 }))).toEqual({
      key: 'pwd.tooShort',
      params: { n: 12 },
    });
    expect(_passwordErrorKey(err('string_too_short', {}))).toEqual({
      key: 'pwd.tooShort',
      params: { n: 12 },
    });
    expect(_passwordErrorKey(err('string_too_long', { max_length: 128 }))).toEqual({
      key: 'pwd.tooLong',
      params: { n: 128 },
    });
  });

  it('maps the first missing complexity class', () => {
    expect(_passwordErrorKey(err('password_complexity', { missing: 'upper, digit' }))).toEqual({
      key: 'pwd.needUpper',
      params: {},
    });
    expect(_passwordErrorKey(err('password_complexity', { missing: 'special' }))).toEqual({
      key: 'pwd.needSpecial',
      params: {},
    });
  });

  it('returns null for unknown types or unknown classes', () => {
    expect(_passwordErrorKey(err('value_error', {}))).toBeNull();
    expect(_passwordErrorKey(err('password_complexity', { missing: 'emoji' }))).toBeNull();
  });
});

describe('_importReport', () => {
  it('builds the summary in a fixed order and skips zero counts', () => {
    const r = _importReport({ imported: 3, skipped: 0, deduped: 2, errors: [] });
    expect(r.ok).toBe(true);
    expect(r.summary).toEqual([
      { key: 'importExport.imported', params: { n: 3 } },
      { key: 'importExport.deduped', params: { n: 2 } },
    ]);
    expect(r.rowErrors).toEqual([]);
    expect(r.moreErrors).toBe(0);
  });

  it('reports not-ok when nothing was imported', () => {
    const r = _importReport({ imported: 0, skipped: 1, deduped: 0, errors: [] });
    expect(r.ok).toBe(false);
    expect(r.summary.map((s) => s.key)).toEqual(['importExport.imported', 'importExport.skipped']);
  });

  it('caps the row errors and counts the overflow', () => {
    const errors = Array.from({ length: 12 }, (_, i) => ({ row: i + 2, code: 'row_invalid' }));
    const r = _importReport({ imported: 0, skipped: 12, deduped: 0, errors });
    expect(r.summary.map((s) => s.key)).toContain('importExport.errorRows');
    expect(r.rowErrors).toHaveLength(10);
    expect(r.rowErrors[0]).toEqual({ row: 2, code: 'row_invalid', params: {} });
    expect(r.moreErrors).toBe(2);
  });
});

describe('_parseServerDate', () => {
  const { _parseServerDate } = utils;

  it('treats zone-less backend timestamps as UTC', () => {
    const d = _parseServerDate('2026-07-02T05:22:50');
    expect(d.getTime()).toBe(Date.UTC(2026, 6, 2, 5, 22, 50));
  });

  it('leaves explicit zones untouched', () => {
    expect(_parseServerDate('2026-07-02T05:22:50Z').getTime()).toBe(
      Date.UTC(2026, 6, 2, 5, 22, 50),
    );
    expect(_parseServerDate('2026-07-02T07:22:50+02:00').getTime()).toBe(
      Date.UTC(2026, 6, 2, 5, 22, 50),
    );
  });

  it('returns an invalid date for empty input', () => {
    expect(Number.isNaN(_parseServerDate('').getTime())).toBe(true);
    expect(Number.isNaN(_parseServerDate(null).getTime())).toBe(true);
  });
});

describe('_deviceLabelFromUA', () => {
  const { _deviceLabelFromUA } = utils;

  it('labels common desktop browsers', () => {
    expect(
      _deviceLabelFromUA(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      ),
    ).toBe('Chrome · Windows');
    expect(
      _deviceLabelFromUA(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
      ),
    ).toBe('Safari · macOS');
    expect(
      _deviceLabelFromUA('Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0'),
    ).toBe('Firefox · Linux');
  });

  it('recognises iOS WebKit browsers by vendor token before Safari', () => {
    expect(
      _deviceLabelFromUA(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.0.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('Chrome · iOS');
    expect(
      _deviceLabelFromUA(
        'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('Safari · iPadOS');
  });

  it('labels Edge on Windows via the Edg token', () => {
    expect(
      _deviceLabelFromUA(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
      ),
    ).toBe('Edge · Windows');
  });

  it('falls back to empty for unknown agents', () => {
    expect(_deviceLabelFromUA('curl/8.5.0')).toBe('');
    expect(_deviceLabelFromUA(null)).toBe('');
    expect(_deviceLabelFromUA('')).toBe('');
  });
});
