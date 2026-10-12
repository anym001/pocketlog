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

// --- Booking defaults -------------------------------------------------------

// The date a new booking starts on.
//
// Today, as long as the ledger is showing the current month. Browsing an
// earlier month is how you add something you forgot, and defaulting to today
// there put the booking in a month you were not looking at: the app reported
// "saved" and nothing appeared. So the day is placed inside the month on
// screen instead, clamped because the 31st does not exist in June.
//
// `viewMonth` is zero-based, matching appState.view.month and the Date API.
function _defaultBookingDate(viewYear, viewMonth, today) {
  return _iso(viewYear, viewMonth, Math.min(today.getDate(), _daysInMonth(viewYear, viewMonth)));
}

// --- Suggestion ranking -----------------------------------------------------

// Ordering shared by the tag and the category chooser. Both show only their
// top few chips and reach the rest through search, so this comparator decides
// whether the everyday case is a single tap.
//
// The count for the form's *current type* leads: booking an expense should not
// be offered the category (or tag) that only ever rides along with income. The
// overall count breaks ties, so two entries unused with this type still sort by
// how familiar they are rather than arbitrarily. Whatever is left the caller
// settles by name.
//
// `counts` is {all, in, out} as the API reports it; `type` is 'in' | 'out', or
// null to rank by the total alone (the bulk action over a mixed selection).
// Returns a comparator result — negative when `a` should come first.
function _compareUsage(a, b, type) {
  const pick = (c) => {
    const all = Number(c && c.all) || 0;
    if (type === 'in') return [Number(c && c.in) || 0, all];
    if (type === 'out') return [Number(c && c.out) || 0, all];
    return [all, all];
  };
  const [aTyped, aAll] = pick(a);
  const [bTyped, bAll] = pick(b);
  return bTyped - aTyped || bAll - aAll;
}

// --- Search / drill-down filtering -----------------------------------------

// Display title of a booking row: its own description, else the name of the
// recurring rule that produced it, else its category name. Rule-materialised
// bookings carry no description, and an empty title would render the row as
// a blank card with only an icon and an amount.
function _txTitle(desc, ruleName, catName) {
  return [desc, ruleName, catName].map((s) => String(s ?? '').trim()).find(Boolean) || '';
}

// Prefix a formatted, absolute amount with its direction so it never relies
// on colour alone: U+2212 MINUS SIGN for 'out', '+' for 'in'. Any other
// direction (a zero net, an unknown type) leaves the amount unsigned.
function _withSign(formatted, direction) {
  if (direction === 'out') return '\u2212' + formatted;
  if (direction === 'in') return '+' + formatted;
  return formatted;
}

// Direction of a net amount for _withSign: 'in' above zero, 'out' below,
// null (unsigned) at zero. Judged on whole cents so a float residue from
// summing (1e-13) can't print a signed "+0,00 €".
function _netDirection(net) {
  const cents = Math.round(net * 100);
  return cents > 0 ? 'in' : cents < 0 ? 'out' : null;
}

// Filter a transaction pool by an active drill-down (category or tag) or a
// pre-lowercased text query (displayed title, category name, tags). Mirrors
// the search panel's behaviour: a drill-down filter short-circuits the text
// match. `catNameById` supplies the category display name (including the
// localized fallback for a missing category) and the optional `ruleNameById`
// the name of a booking's source rule — passed in as functions so this stays
// free of app state and I18N. A booking without a description is matched on
// its rule name, because that is the title the row shows (see _txTitle).
function _filterTransactions(
  pool,
  { query, categoryFilterId, tagFilterName },
  catNameById,
  ruleNameById = () => '',
) {
  return pool.filter((t) => {
    if (categoryFilterId != null) return t.category_id === categoryFilterId;
    if (tagFilterName != null) return Array.isArray(t.tags) && t.tags.includes(tagFilterName);
    const desc = (t.desc || '').trim();
    if (desc.toLowerCase().includes(query)) return true;
    if (!desc && t.source_rule_id != null) {
      if ((ruleNameById(t.source_rule_id) || '').toLowerCase().includes(query)) return true;
    }
    if (catNameById(t.category_id).toLowerCase().includes(query)) return true;
    if (t.tags && t.tags.some((tag) => tag.toLowerCase().includes(query))) return true;
    return false;
  });
}

// Parse a backend datetime string. The API serialises naive UTC timestamps
// without a timezone suffix ("2026-07-02T05:22:50"); `new Date()` would read
// those as *local* time and shift every displayed timestamp by the UTC
// offset. Appending "Z" pins the parse to UTC; strings that already carry a
// zone (Z or ±hh:mm) pass through untouched.
function _parseServerDate(iso) {
  if (!iso) return new Date(NaN);
  const hasZone = /[zZ]$|[+-]\d\d:?\d\d$/.test(iso);
  return new Date(hasZone ? iso : iso + 'Z');
}

// Human-readable device label ("Browser · OS") from a stored User-Agent
// string, for the signed-in-devices list. Deliberately coarse — the point is
// telling one's own devices apart, not UA forensics. Returns '' when nothing
// recognisable is found so the caller can substitute a localized fallback.
function _deviceLabelFromUA(ua) {
  ua = ua || '';
  let browser = '';
  // Alternative iOS browsers are all WebKit but carry vendor tokens —
  // matched before the generic Chrome/Safari patterns (mirrors
  // settings._detectBrowser for the local device).
  if (/CriOS\//.test(ua)) browser = 'Chrome';
  else if (/FxiOS\//.test(ua)) browser = 'Firefox';
  else if (/EdgiOS\//.test(ua) || /Edg\//.test(ua)) browser = 'Edge';
  else if (/OPR\//.test(ua)) browser = 'Opera';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Safari\//.test(ua) && /Version\//.test(ua)) browser = 'Safari';

  let os = '';
  if (/iPad/.test(ua)) os = 'iPadOS';
  else if (/iPhone|iPod/.test(ua)) os = 'iOS';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/Windows NT/.test(ua)) os = 'Windows';
  else if (/Mac OS X|Macintosh/.test(ua)) os = 'macOS';
  else if (/CrOS/.test(ua)) os = 'ChromeOS';
  else if (/Linux/.test(ua)) os = 'Linux';

  if (browser && os) return browser + ' · ' + os;
  return browser || os || '';
}

// Classify a dead-lettered outbox entry ({method, path, body, status,
// detail}) into renderable pieces for the sync-recovery sheet. Pure — no
// i18n: returns machine keys plus the raw content fields; the caller
// translates and formats. Shape:
//   entity  'transaction' | 'bulk' | 'category' | 'goal' | 'budget' |
//           'recurring' | 'tag' | 'settings' | 'other'
//   verb    'create' | 'update' | 'delete'
//   label   best-effort content identifier (description / name / tag), ''
//   amount  string amount for transactions, else null
//   date    ISO date for transactions, else null
//   code    machine detail code from the server response, '' if none
//   status  HTTP status of the rejection, 0 if unknown
function _failedEntrySummary(entry) {
  const method = (entry && entry.method) || '';
  const path = ((entry && entry.path) || '').split('?')[0];
  const body = (entry && entry.body) || {};
  const verb = method === 'DELETE' ? 'delete' : method === 'PUT' ? 'update' : 'create';

  let entity = 'other';
  let label = '';
  let amount = null;
  let date = null;
  if (path.startsWith('/transactions/bulk')) {
    entity = 'bulk';
    label = Array.isArray(body.ids) ? String(body.ids.length) : '';
  } else if (path.startsWith('/transactions')) {
    entity = 'transaction';
    label = body.desc || body.description || '';
    amount = body.amount != null ? String(body.amount) : null;
    date = body.date || null;
  } else if (path.startsWith('/categories')) {
    entity = 'category';
    label = body.name || '';
  } else if (path.startsWith('/goals')) {
    entity = 'goal';
    label = body.name || '';
  } else if (path.startsWith('/budgets')) {
    entity = 'budget';
  } else if (path.startsWith('/recurring')) {
    entity = 'recurring';
    label = body.name || '';
  } else if (path.startsWith('/tags')) {
    entity = 'tag';
    // /tags/<name> for rename/delete; body.name for create.
    const tail = decodeURIComponent(path.slice('/tags/'.length) || '');
    label = body.new_name || body.name || tail;
  } else if (path.startsWith('/settings')) {
    entity = 'settings';
  }

  // The server detail is stored as the raw response text — usually the JSON
  // error envelope {"detail": "machine_code"}. Anything non-string (Pydantic
  // 422 arrays) or unparsable collapses to ''.
  let code = '';
  try {
    const parsed = JSON.parse(entry.detail || '');
    if (parsed && typeof parsed.detail === 'string') code = parsed.detail;
  } catch (e) {}

  return { entity, verb, label, amount, date, code, status: (entry && entry.status) || 0 };
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
// Mirrors of the server-side tag limits (backend/app/schemas.py). The tag
// chooser enforces them before sending, so a slip surfaces as a hint in the
// form rather than an unreadable 422.
const MAX_TAG_LENGTH = 64;
const MAX_TAGS_PER_TX = 20;

// Clean a freshly typed tag name the way schemas._normalise_tags would:
// control characters out, trimmed, capped. Returns '' for anything that would
// not survive the round trip, so callers can simply skip it.
function _normaliseNewTag(raw) {
  // Filtered by code point rather than a regex: a control-character class
  // reads badly and trips eslint's no-control-regex for no gain.
  const DEL = String.fromCharCode(127);
  return [...String(raw ?? '')]
    .filter((ch) => ch >= ' ' && ch !== DEL)
    .join('')
    .trim()
    .slice(0, MAX_TAG_LENGTH);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    _iso,
    _daysInMonth,
    MAX_TAG_LENGTH,
    MAX_TAGS_PER_TX,
    _normaliseNewTag,
    _escAttr,
    _escText,
    _parseAmountWith,
    _formatAmountWith,
    _compareUsage,
    _defaultBookingDate,
    _filterTransactions,
    _txTitle,
    _withSign,
    _netDirection,
    _passwordErrorKey,
    _importReport,
    _parseServerDate,
    _deviceLabelFromUA,
    _failedEntrySummary,
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
