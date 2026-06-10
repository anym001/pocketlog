// Unit tests for the pure helpers extracted into frontend/utils.js.
import { describe, expect, it } from 'vitest';
import utils from '../utils.js';

const { _iso, _daysInMonth, _escAttr, _escText } = utils;

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
