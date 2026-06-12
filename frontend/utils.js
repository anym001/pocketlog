// Pure, stateless view helpers shared across the app's render functions.
//
// Loaded as a classic script *before* app.js (see index.html), so the
// declarations below are globals the app calls directly — call sites are
// unchanged from when these lived inside app.js. The same functions are
// unit-tested in isolation via Vitest (frontend/unit/utils.test.js); the
// module.exports guard at the bottom is a no-op in the browser.
//
// Keep this file free of app state (no module-level `let`, no DOM lookups by
// id, no I18N/locale dependency): only inputs -> outputs belong here.

// ISO date string (YYYY-MM-DD) from a year, a zero-based month and a day —
// matching the JS Date month convention used throughout the report code.
function _iso(y, m, d) {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Number of days in a zero-based month (day 0 of the next month).
function _daysInMonth(y, m) {
  return new Date(y, m + 1, 0).getDate();
}

// Escape a string for use inside a double-quoted HTML attribute.
function _escAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Escape a string for HTML text content. Uses the DOM so the escaping matches
// the browser exactly and null/undefined collapse to an empty string.
function _escText(s) {
  const tmp = document.createElement('div');
  tmp.textContent = s == null ? '' : String(s);
  return tmp.innerHTML;
}

// --- Amount input parsing/formatting --------------------------------------
// Locale-aware cores; the decimal separator comes in as an argument so these
// stay I18N-free. The app-level parseAmount()/_formatAmountInput() wrappers
// (app.js) supply the separator from I18N.

// Parse a free-form amount string. With a comma decimal separator dots are
// thousands separators and the comma is the decimal point; with a dot
// separator it's the reverse. Currency symbols/spaces are stripped so a
// pasted "1.234,56 €" still parses.
function _parseAmountWith(raw, sep) {
  if (raw == null) return NaN;
  let s = String(raw)
    .trim()
    .replace(/[^\d.,-]/g, '');
  if (sep === ',') {
    s = s.replace(/\./g, '').replace(',', '.');
  } else {
    s = s.replace(/,/g, '');
  }
  return parseFloat(s);
}

// Format a number for the amount input with the given decimal separator.
// No thousand separator — keeps round-tripping through _parseAmountWith()
// lossless.
function _formatAmountWith(n, sep) {
  const s = n.toFixed(2);
  return sep === ',' ? s.replace('.', ',') : s;
}

// --- Recurring schedule math (mirrors backend recurring.py) ----------------
// Pure calendar arithmetic for the live "next booking" preview. Dates are
// plain { y, m, d } objects with a 1-based month. The impure preview walker
// (_recurringComputeNextPreview, reads the form + today's date) stays in
// app.js and calls these as globals.

function _recurringDaysInMonth(y, m) {
  return new Date(y, m, 0).getDate(); // m is 1-based → day 0 of next month
}
function _recurringClampDay(y, m, dom) {
  return Math.min(dom, _recurringDaysInMonth(y, m));
}
function _recurringAddMonths(y, m, months) {
  const idx = m - 1 + months;
  return [y + Math.floor(idx / 12), (idx % 12) + 1];
}
function _recurringMon0Weekday(y, m, d) {
  // JS getDay() Sun=0..Sat=6 → backend Mon=0..Sun=6.
  return (new Date(y, m - 1, d).getDay() + 6) % 7;
}
function _recurringCmp(a, b) {
  return a.y * 10000 + a.m * 100 + a.d - (b.y * 10000 + b.m * 100 + b.d);
}
function _recurringMonthStep(frequency) {
  return frequency === 'yearly' ? 12 : frequency === 'quarterly' ? 3 : 1;
}
// First occurrence on/after the START anchor (interval-independent),
// mirroring recurring.first_occurrence_on_or_after.
function _recurringFirstOnOrAfter(frequency, anchor, weekday, dom) {
  if (frequency === 'daily') return { y: anchor.y, m: anchor.m, d: anchor.d };
  if (frequency === 'weekly') {
    const cur = _recurringMon0Weekday(anchor.y, anchor.m, anchor.d);
    const target = weekday == null ? cur : weekday;
    const ahead = (((target - cur) % 7) + 7) % 7;
    const dt = new Date(anchor.y, anchor.m - 1, anchor.d + ahead);
    return { y: dt.getFullYear(), m: dt.getMonth() + 1, d: dt.getDate() };
  }
  const day = dom || anchor.d;
  let cand = { y: anchor.y, m: anchor.m, d: _recurringClampDay(anchor.y, anchor.m, day) };
  if (_recurringCmp(cand, anchor) < 0) {
    const [ny, nm] = _recurringAddMonths(anchor.y, anchor.m, _recurringMonthStep(frequency));
    cand = { y: ny, m: nm, d: _recurringClampDay(ny, nm, day) };
  }
  return cand;
}
// Occurrence strictly after `after`, honouring interval, mirroring
// recurring.next_occurrence.
function _recurringNextOccurrence(frequency, interval, after, weekday, dom) {
  const iv = Math.max(1, interval || 1);
  if (frequency === 'daily') {
    const dt = new Date(after.y, after.m - 1, after.d + iv);
    return { y: dt.getFullYear(), m: dt.getMonth() + 1, d: dt.getDate() };
  }
  if (frequency === 'weekly') {
    const cur = _recurringMon0Weekday(after.y, after.m, after.d);
    const target = weekday == null ? cur : weekday;
    let ahead = (((target - cur) % 7) + 7) % 7;
    if (ahead === 0) ahead = 7;
    const dt = new Date(after.y, after.m - 1, after.d + ahead + (iv - 1) * 7);
    return { y: dt.getFullYear(), m: dt.getMonth() + 1, d: dt.getDate() };
  }
  const [ny, nm] = _recurringAddMonths(after.y, after.m, _recurringMonthStep(frequency) * iv);
  const day = dom || after.d;
  return { y: ny, m: nm, d: _recurringClampDay(ny, nm, day) };
}

// --- Search / drill-down filtering -----------------------------------------

// Filter a transaction pool by an active drill-down (category or tag) or a
// pre-lowercased text query (description, category name, tags). Mirrors the
// search panel's behaviour: a drill-down filter short-circuits the text
// match. `catNameById` supplies the category display name (including the
// localized fallback for a missing category) — passed in as a function so
// this stays free of app state and I18N.
function _filterTransactions(pool, { query, categoryFilterId, tagFilterName }, catNameById) {
  return pool.filter((t) => {
    if (categoryFilterId != null) return t.category_id === categoryFilterId;
    if (tagFilterName != null) return Array.isArray(t.tags) && t.tags.includes(tagFilterName);
    if ((t.desc || '').toLowerCase().includes(query)) return true;
    if (catNameById(t.category_id).toLowerCase().includes(query)) return true;
    if (t.tags && t.tags.some((tag) => tag.toLowerCase().includes(query))) return true;
    return false;
  });
}

// --- Backend error codes → i18n keys ---------------------------------------

// Map a backend 422 (Pydantic) password error onto an i18n key + params.
// Pure core of core.js's _passwordErrorMessage — the wrapper translates.
// Returns null when no password error is present.
function _passwordErrorKey(data) {
  const det = data && data.detail;
  if (!Array.isArray(det)) return null;
  const e = det.find((d) => Array.isArray(d.loc) && d.loc.some((x) => /password/i.test(String(x))));
  if (!e) return null;
  const ctx = e.ctx || {};
  if (e.type === 'string_too_short')
    return { key: 'pwd.tooShort', params: { n: ctx.min_length != null ? ctx.min_length : 12 } };
  if (e.type === 'string_too_long')
    return { key: 'pwd.tooLong', params: { n: ctx.max_length != null ? ctx.max_length : 128 } };
  if (e.type === 'password_complexity') {
    const miss = String(ctx.missing || '')
      .split(/[,\s]+/)
      .filter(Boolean);
    const map = {
      upper: 'pwd.needUpper',
      lower: 'pwd.needLower',
      digit: 'pwd.needDigit',
      special: 'pwd.needSpecial',
    };
    if (miss[0] && map[miss[0]]) return { key: map[miss[0]], params: {} };
  }
  return null;
}

// Shape a CSV import API result into renderable, still-untranslated pieces:
// the summary line entries, the capped per-row error list and the overflow
// count. settings.js turns each {key, params} into text via tr(). The cap
// keeps a mostly-broken file from rendering thousands of error rows.
function _importReport(result, cap = 10) {
  const errs = result.errors || [];
  const summary = [{ key: 'importExport.imported', params: { n: result.imported } }];
  if (result.skipped) summary.push({ key: 'importExport.skipped', params: { n: result.skipped } });
  if (result.deduped) summary.push({ key: 'importExport.deduped', params: { n: result.deduped } });
  if (errs.length) summary.push({ key: 'importExport.errorRows', params: { n: errs.length } });
  return {
    ok: result.imported > 0,
    summary,
    rowErrors: errs
      .slice(0, cap)
      .map((e) => ({ row: e.row, code: e.code, params: e.params || {} })),
    moreErrors: errs.length > cap ? errs.length - cap : 0,
  };
}

// Node/Vitest only — the browser classic-script load skips this (module is
// undefined there) and relies on the global function declarations above.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
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
  };
}
