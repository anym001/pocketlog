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

// Node/Vitest only — the browser classic-script load skips this (module is
// undefined there) and relies on the global function declarations above.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { _iso, _daysInMonth, _escAttr, _escText };
}
