// App core: icon markup, i18n shorthand, API/CSRF plumbing, report/trend
// state restore, formatting, toast + confirm dialogs, navigation (views,
// drawers, sidebar) and modal focus management.
// Classic script — loaded after state.js, before the feature modules (see index.html).

// ── ICON-MARKUP ───────────────────────────────────────────────────────────────
// For glyphs swapped dynamically via JS (FAB toggle plus/✕, tag pill
// remove). Static glyphs live directly in the HTML markup.
const ICON_SVG = {
  plus: '<svg class="ui-icon" aria-hidden="true"><use href="#icon-plus"/></svg>',
  close: '<svg class="ui-icon" aria-hidden="true"><use href="#icon-close"/></svg>',
};

// ── DECLARATIVE EVENT DELEGATION ──────────────────────────────────────────────
// The CSP is script-src 'self': inline handler attributes (onclick="…") are
// blocked. Instead, elements declare their handler with data attributes and
// the document-level listeners below dispatch them:
//
//   data-action          → click        data-action-change → change
//   data-action-input    → input        data-action-submit → submit
//   data-action-blur     → blur (via focusout)
//   data-action-keydown  → keydown
//
// The attribute value is a global function name, resolved on window at event
// time — so declaration order between modules doesn't matter, and markup
// inserted via innerHTML is covered without per-render wiring. Arguments come
// from `data-args`, a JSON array with three magic tokens:
//
//   "@event"  → the DOM event        "@el"     → the element carrying the
//   "@value"  → el.value               data-action attribute
//   "@value#" → Number(el.value)
//
// `data-stop` additionally stops propagation (for actions nested inside other
// clickable rows). Submit dispatch always calls preventDefault() — every form
// in this app is JS-driven. The handler runs with `this` bound to the
// declaring element, mirroring inline-handler semantics (closeOnBackdrop
// relies on that).
function _resolveActionArgs(el, event) {
  const raw = el.getAttribute('data-args');
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error('data-args is not valid JSON:', raw, el);
    return [];
  }
  if (!Array.isArray(parsed)) return [parsed];
  return parsed.map((a) => {
    if (a === '@event') return event;
    if (a === '@el') return el;
    if (a === '@value') return el.value;
    if (a === '@value#') return Number(el.value);
    return a;
  });
}

function _dispatchAction(el, attr, event) {
  const name = el.getAttribute(attr);
  if (!name) return; // declared but intentionally empty (e.g. submit no-op)
  const fn = window[name];
  if (typeof fn !== 'function') {
    console.error('Unknown action handler:', name, el);
    return;
  }
  if (el.hasAttribute('data-stop')) event.stopPropagation();
  fn.apply(el, _resolveActionArgs(el, event));
}

[
  ['click', 'data-action'],
  ['change', 'data-action-change'],
  ['input', 'data-action-input'],
  ['submit', 'data-action-submit'],
  // Native blur doesn't bubble; focusout is its bubbling twin.
  ['focusout', 'data-action-blur'],
  ['keydown', 'data-action-keydown'],
].forEach(([type, attr]) => {
  document.addEventListener(type, (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const el = target.closest(`[${attr}]`);
    if (!el) return;
    if (type === 'submit') event.preventDefault();
    _dispatchAction(el, attr, event);
  });
});

// Keyboard activation for non-native interactive elements (rows with
// role="button" + data-action). Mirrors native button semantics: Enter and
// Space trigger the action; Space is prevented from scrolling; `!e.repeat`
// avoids re-firing while held. `.is-key-active` gives the keyboard press the
// same visual feedback that mouse `:active` does. Native form controls are
// excluded — they already translate Enter/Space to click themselves (and a
// row's nested <button> must not double-fire).
const _NATIVE_ACTIVATION_TAGS = new Set(['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA']);
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
  if (event.repeat) return;
  const target = event.target instanceof Element ? event.target : null;
  if (!target || _NATIVE_ACTIVATION_TAGS.has(target.tagName)) return;
  const el = target.closest('[data-action]');
  if (!el || el !== target) return; // only the focused element itself
  event.preventDefault();
  el.classList.add('is-key-active');
  setTimeout(() => el.classList.remove('is-key-active'), 150);
  _dispatchAction(el, 'data-action', event);
});

// Proxy for the hidden <input type="file"> pickers: the visible button sits
// in the layout, the input itself stays display:none.
function clickHiddenInput(id) {
  const el = document.getElementById(id);
  if (el) el.click();
}

// ── i18n SHORTHAND ────────────────────────────────────────────────────────────
// `tr()` (not `t()`) is the translation helper: `t` is used pervasively
// as the transaction loop variable in .map((t) => …) callbacks, so a
// global `t` would shadow-collide. tr() delegates to i18n.js and falls
// back to the key when the runtime isn't ready (keeps render safe).
const tr = (key, params) => (window.I18N ? I18N.t(key, params) : key);

// ── API BASE ───────────────────────────────────────────────────────────────────
// Same-origin. The PWA and the FastAPI backend live behind the same
// SWAG vhost — there is no supported deployment where they sit on
// different origins, and CSP `connect-src 'self'` would block such
// a setup anyway.
const API = '/api';
// Drop any leftover apiBase setting from older app versions so the
// localStorage doesn't accumulate dead keys.
try {
  localStorage.removeItem('pocketlog.apiBase');
} catch (e) {}

// Currently displayed period (appState.view.{month,year}) and the booking-form
// draft (appState.form.{type,tags}) live in state.js.

// ── REPORTS-STATE ─────────────────────────────────────────────────────────────
// Which report is currently active (source of truth for panel-charts).
// Persisted in localStorage so a reload shows the last state.
const REPORT_STORAGE_KEY = 'pocketlog.report';
const REPORT_IDS = ['overview', 'course', 'breakdown', 'trend', 'forecast', 'top'];
// Report id → i18n key. Resolved through t() at render time so the
// titles follow the active language.
const REPORT_TITLE_KEYS = {
  overview: 'reports.overview',
  course: 'reports.course',
  breakdown: 'reports.breakdown',
  trend: 'reports.trend',
  forecast: 'reports.forecast',
  top: 'reports.top',
};
// Old report ids (pre-merge) → their successor, so a stored selection still
// lands somewhere sensible: month/year folded into "course", categories/tags
// into "breakdown".
const _REPORT_ID_MIGRATE = {
  month: 'course',
  year: 'course',
  categories: 'breakdown',
  tags: 'breakdown',
};
const reportTitle = (id) => tr(REPORT_TITLE_KEYS[id] || 'reports.overview');
// Reports state lives in appState.reports (state.js). `current` (the active
// report) is restored from localStorage here, defaulting to 'overview'; the
// `range` (period picker) and `rangeLock` (optional 'month'/'year' lock that
// pins the picker for reports only meaningful at one granularity; null = free)
// keep their identical defaults from state.js.
appState.reports.current = (() => {
  let v = localStorage.getItem(REPORT_STORAGE_KEY);
  if (v && _REPORT_ID_MIGRATE[v]) v = _REPORT_ID_MIGRATE[v];
  return REPORT_IDS.includes(v) ? v : 'overview';
})();
// Chart.js instances per report, kept separate so destroy() never hits a foreign instance.
const chartInsts = { course: null, breakdown: null, trend: null };

// ── TREND-STATE ───────────────────────────────────────────────────────────────
const TREND_STORAGE_KEY = 'pocketlog.trend';
const TREND_RANGE_KEY = 'pocketlog.trend.range';
// Trend chart state lives in appState.trend (state.js): kind ('category'|'tag'),
// selection (['cat:42'], up to 3), pickerOpen, pickerFilter, earliestTxDate
// (session cache), yearFrom / yearTo (integers). The IIFE below restores
// kind/selection/year range from localStorage into appState.trend.
(function _restoreTrendState() {
  try {
    const raw = localStorage.getItem(TREND_STORAGE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (s.kind === 'category' || s.kind === 'tag') appState.trend.kind = s.kind;
      if (Array.isArray(s.selection)) {
        appState.trend.selection = s.selection
          .filter((e) => typeof e === 'string' && (e.startsWith('cat:') || e.startsWith('tag:')))
          .slice(0, 3);
      }
    }
  } catch (e) {}
  try {
    const raw = localStorage.getItem(TREND_RANGE_KEY);
    if (raw) {
      const r = JSON.parse(raw);
      if (r && Number.isInteger(r.yearFrom) && Number.isInteger(r.yearTo)) {
        appState.trend.yearFrom = r.yearFrom;
        appState.trend.yearTo = r.yearTo;
      }
    }
  } catch (e) {}
})();
// Per-year transaction cache. Cleared on every write.
const _txCacheByYear = new Map();
function invalidateReportCache() {
  _txCacheByYear.clear();
}
// appState.reports.searchExitTarget — drill-down from the category analysis
// remembers where "Cancel" jumps back to. appState.reports.txPool — the
// last transactions loaded by the active report, consulted by editTransaction
// so a click on a top list finds the real booking (not just the current
// month's from the transactions view). Both default in state.js.

// Core ledger data lives in appState.ledger (state.js): transactions (the
// current view's slice, loaded per API), categories (loaded per API),
// appState.ledger.availableTags (the user's distinct tags, alphabetical) and `all` (the full
// pool used by search). `appState.ledger.all` below maps to appState.ledger.all.
const tagCounts = new Map(); // tag name (case-folded) → number of uses

// ── API HELPER ────────────────────────────────────────────────────────────────
// Same-origin cookie session. The CSRF token is collected on login /
// bootstrap and kept in window._csrfToken. On a 401 we reload hard so
// init() lands cleanly on the login view — no stale app state stays
// in the DOM.
window._csrfToken = '';

// Auth-boundary cleanup: before every 401-induced reload, throw away
// the API cache and the CSRF token held by the SW. Otherwise the next
// page load would hit a cached me response (force-change view without
// a session), or the outbox would send a stale CSRF token along
// (403 on replay → silent data loss).
function _resetAuthClientState() {
  try {
    if (navigator.serviceWorker?.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'CLEAR_API_CACHE' });
    }
  } catch (_) {}
  // Clear the in-page outbox token too (the SW's is cleared via the message
  // above). The drain guard then defers any queued writes until a fresh login
  // re-seeds the token, rather than replaying them with a stale one.
  try {
    window.PocketLogOutbox?.setCsrfToken?.('');
  } catch (_) {}
  window._csrfToken = '';
}

// Nuclear reset: unregister the SW AND wipe every cache. Used by the
// force-change path as an escape hatch when the server response proves
// that the view currently rendered doesn't match the real session
// state — typically a stale SW or an iOS "frozen page cache" still
// holding the old 200/me response even though "clear history and
// website data" already ran. localStorage stays, so theme +
// default view survive.
async function _hardResetClientState() {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister().catch(() => null)));
    }
  } catch (_) {}
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k).catch(() => null)));
    }
  } catch (_) {}
  window._csrfToken = '';
  // Load with a cache-busting param so Safari doesn't simply re-render
  // the BFCache. Sufficient for iOS Safari quirks.
  location.replace('/?reset=' + Date.now());
}

// How long a write may block before we abort it and let the caller queue it
// in the outbox. Without this, a hanging request (iOS airplane mode, "lie-fi")
// never rejects — the fetch stalls until the OS TCP timeout, the save modal
// stays open, and when the network returns the late request surfaces an error
// instead of having been queued. Deliberately LONGER than the service worker's
// own write timeout (sw.js WRITE_TIMEOUT_MS) so that, on an SW-controlled page,
// the SW wins the race and returns its 202 "queued" before this page-side
// abort ever fires; this abort is the fallback for pages with no active SW.
const WRITE_TIMEOUT_MS = 12000;

// Client-side idempotency key for offline-queued creates. crypto.randomUUID is
// available in every secure context (the PWA is HTTPS-only); the fallback keeps
// non-secure dev origins working. The same op-id rides along when the outbox
// replays a queued create, so the server can dedupe a create that already
// reached it before the client aborted (see crud.create_transaction).
function _newOpId() {
  try {
    if (self.crypto && crypto.randomUUID) return crypto.randomUUID();
  } catch (_) {}
  return 'op-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
}

// True when an api() rejection is a network-level failure (fetch rejected or
// the write timed out and was aborted) rather than a real HTTP response. HTTP
// errors carry `.status` (set below); network/abort failures don't. Callers
// use this to decide whether to queue the write offline — replacing the old
// navigator.onLine check, which lies on iOS (reports online in airplane mode).
function _isOfflineWriteError(e) {
  return !!e && e.status == null;
}

async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (method !== 'GET' && window._csrfToken) {
    headers['X-CSRF-Token'] = window._csrfToken;
  }
  const opts = { method, headers, credentials: 'same-origin' };
  if (body) opts.body = JSON.stringify(body);
  // Arm an abort timeout for writes so a stalled request fails fast enough to
  // be queued, instead of hanging until the OS timeout. GETs are left alone —
  // the service worker races them against its own read timeout and falls back
  // to the cache.
  let _writeTimer = null;
  if (method !== 'GET' && typeof AbortController === 'function') {
    const controller = new AbortController();
    opts.signal = controller.signal;
    _writeTimer = setTimeout(() => controller.abort(), WRITE_TIMEOUT_MS);
  }
  let res;
  try {
    res = await fetch(API + path, opts);
  } finally {
    if (_writeTimer) clearTimeout(_writeTimer);
  }
  if (res.status === 401) {
    if (!window._suppressAuthReload) {
      _resetAuthClientState();
      location.reload();
    }
    throw new Error('session expired');
  }
  if (!res.ok) {
    // Try to surface the backend's `detail` string on the error
    // object so callers can disambiguate 409s (e.g. "category in
    // use" vs "category has recurring rule"). The existing
    // ``e.message.includes('409')`` pattern keeps working
    // because the formatted message is unchanged.
    let detail = '';
    try {
      const body = await res.clone().json();
      if (body && typeof body.detail === 'string') detail = body.detail;
    } catch (_) {}
    const err = new Error(`API ${method} ${path} → ${res.status}`);
    err.status = res.status;
    err.detail = detail;
    throw err;
  }
  if (method !== 'GET') invalidateReportCache();
  if (res.status === 204) return null;
  return res.json();
}

// Auth endpoints bypass api() — on 401/429 we want to handle the
// response ourselves without falling into the location.reload() path.
// BUT: if the caller leaves ``opts.reloadOn401 !== false`` and a 401
// arrives, we still do the hard reload — otherwise the user is stuck
// in a view their session state no longer matches.
async function authFetch(method, path, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (opts.csrf !== false && method !== 'GET' && window._csrfToken) {
    headers['X-CSRF-Token'] = window._csrfToken;
  }
  const init = { method, headers, credentials: 'same-origin' };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(API + path, init);
  if (res.status === 401 && opts.reloadOn401 !== false) {
    _resetAuthClientState();
    location.reload();
  }
  return res;
}

// Push the current CSRF token to every outbox that may replay a queued
// write, so the replay carries an X-CSRF-Token the server accepts:
//   - the service worker's outbox (Background Sync replay), and
//   - the in-page outbox (db.js, a classic script with its own module
//     state), which drains on the `online` event whenever Background Sync
//     isn't available — notably iOS Safari.
// Miss the page-side token and an offline edit replays without the header,
// the server rejects it with 403, drain dead-letters it, and the change
// looks reverted on reconnect.
// Shared offline-write helper. When api() reports a queued write (HTTP 202 —
// the service worker stored it in the outbox instead of reaching the server),
// reflect the change locally via applyLocally(), tell the user it's saved
// offline, and bump the sync badge. Returns true when it handled a queued
// write, so the caller skips its normal reload-from-cache path (which offline
// would just re-render the stale data and make the change look lost).
function _handleQueuedWrite(result, applyLocally) {
  if (!result || !result.queued) return false;
  try {
    applyLocally();
  } catch (_) {}
  if (typeof updateSyncBadge === 'function') updateSyncBadge();
  toast(tr('common.queuedOffline'));
  return true;
}

function _propagateCsrfToken(token) {
  const t = token || '';
  try {
    window.PocketLogOutbox?.setCsrfToken?.(t);
  } catch (_) {}
  try {
    if (navigator.serviceWorker?.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'SET_CSRF', token: t });
    }
  } catch (_) {}
}

// Password policy: 12 chars + 4 character classes. Mirrors the
// server-side rule in schemas.validate_password_complexity — both
// places must stay in sync. Unicode-property regex so "Ä", "ß", "é"
// count as letters like on the server (and not as special
// characters).
const PWD_MIN_LENGTH = 12;
function validateNewPassword(pw) {
  if (pw.length < PWD_MIN_LENGTH) {
    return tr('pwd.tooShort', { n: PWD_MIN_LENGTH });
  }
  if (!/\p{Lu}/u.test(pw)) {
    return tr('pwd.needUpper');
  }
  if (!/\p{Ll}/u.test(pw)) {
    return tr('pwd.needLower');
  }
  if (!/\d/.test(pw)) {
    return tr('pwd.needDigit');
  }
  if (!/[^\p{L}\p{N}]/u.test(pw)) {
    return tr('pwd.needSpecial');
  }
  return null;
}

// Map a backend 422 (Pydantic) password error to a translated message.
// The frontend pre-validates, so this only fires if a weak password
// somehow reaches the API — keeps the coded backend response (no German)
// translatable end-to-end. Returns null if no password error is present.
// The code→key mapping lives in utils.js (_passwordErrorKey, unit-tested);
// this wrapper only supplies the translation.
function _passwordErrorMessage(data) {
  const mapped = _passwordErrorKey(data);
  return mapped ? tr(mapped.key, mapped.params) : null;
}

// ── FORMATTING ────────────────────────────────────────────────────────────────
// Locale + currency come from i18n.js (the active language drives the
// number/date locale; currency is a separate ISO code, display-only).
// Resolved per-call so a language/currency switch takes effect on the
// next render without rebuilding cached formatters.
const _locale = () => (window.I18N ? I18N.getLocale() : 'de-DE');
const _currencyCode = () => (window.I18N ? I18N.getCurrency() : 'EUR');
const fmtCurrency = (n) =>
  new Intl.NumberFormat(_locale(), { style: 'currency', currency: _currencyCode() }).format(n);
// Month names are derived from the active locale via Intl rather than
// hardcoded, so they follow the language setting. Rebuilt on startup
// and on every i18n:changed (see registerI18nListener).
// Localised month names live in appState.calendar.{months,monthsShort} (state.js).
function rebuildMonthNames() {
  const loc = _locale();
  const long = new Intl.DateTimeFormat(loc, { month: 'long' });
  const short = new Intl.DateTimeFormat(loc, { month: 'short' });
  appState.calendar.months = [];
  appState.calendar.monthsShort = [];
  for (let m = 0; m < 12; m++) {
    const d = new Date(2021, m, 1);
    appState.calendar.months.push(long.format(d));
    // Some locales append a dot to the short month ("Jan."); drop it
    // for the compact chart axis labels.
    appState.calendar.monthsShort.push(short.format(d).replace(/\.$/, ''));
  }
}
rebuildMonthNames();

// ── TOAST + CONFIRM (replaces native alert/confirm) ──────────────────────────
function toast(message, type = 'info') {
  const host = document.getElementById('toastHost');
  if (!host) return;
  const el = document.createElement('div');
  el.className = 'toast' + (type === 'error' ? ' error' : '');
  el.textContent = message;
  if (type === 'error') el.setAttribute('role', 'alert');
  host.appendChild(el);
  const dwell = type === 'error' ? 5000 : 3200;
  setTimeout(() => {
    el.classList.add('leaving');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }, dwell);
}

function confirmAction({
  title,
  message = '',
  confirmLabel = tr('common.confirm'),
  cancelLabel = tr('common.cancel'),
  destructive = true,
}) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay open';
    overlay.style.alignItems = 'center';

    const modal = document.createElement('div');
    modal.className = 'modal confirm-modal';
    modal.setAttribute('role', 'alertdialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'confirmTitle');

    const h = document.createElement('h2');
    h.id = 'confirmTitle';
    h.textContent = title;
    modal.appendChild(h);

    if (message) {
      const p = document.createElement('p');
      p.className = 'confirm-msg';
      p.textContent = message;
      modal.appendChild(p);
    }

    const yes = document.createElement('button');
    yes.className = 'submit-btn confirm-yes' + (destructive ? ' btn-destructive' : '');
    yes.type = 'button';
    yes.textContent = confirmLabel;
    modal.appendChild(yes);

    const no = document.createElement('button');
    no.className = 'confirm-cancel';
    no.type = 'button';
    no.textContent = cancelLabel;
    modal.appendChild(no);

    overlay.appendChild(modal);

    // Cycle Tab between yes/no — the alert-dialog has no other focusable
    // controls, so a manual trap is simpler than reusing trapFocusIn().
    const onKey = (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        (document.activeElement === yes ? no : yes).focus();
      }
    };

    const close = (result) => {
      overlay.removeEventListener('keydown', onKey);
      overlay.remove();
      // Only release scroll-lock if no other modal is still open.
      const stillOpen = document.querySelector('.modal-overlay.open');
      if (!stillOpen) document.body.style.overflow = '';
      if (prevFocus && document.contains(prevFocus) && typeof prevFocus.focus === 'function') {
        prevFocus.focus();
      }
      resolve(result);
    };
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(false);
    });
    overlay.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';
    yes.addEventListener('click', () => close(true));
    no.addEventListener('click', () => close(false));
    setTimeout(() => no.focus(), 50);
  });
}

// ── NAVIGATION ────────────────────────────────────────────────────────────────
// Navigation / cross-cutting UI state lives in appState.nav (state.js):
//   activePanel; bookingModalOpenedAt (timestamp of the last booking-modal
//   open, guards closeModalOutside against the ghost click that trails the tap
//   which opened it); searchQuery; categoryFilterId (set when the user taps the
//   "more" icon on a category row — mutually exclusive with text search, which
//   clears it in onSearch); tagFilterName (drill-down from the tag analysis,
//   mutually exclusive with text search and category filter); infoPanelSeq;
//   goalRelayoutTimer.

function _resetSearch() {
  appState.nav.searchQuery = '';
  appState.nav.categoryFilterId = null;
  appState.nav.tagFilterName = null;
  appState.ledger.all = null;
  appState.reports.searchExitTarget = null;
  document.body.classList.remove('searching');
  document.getElementById('searchInput').value = '';
  const fab = document.querySelector('.fab');
  if (fab) {
    fab.innerHTML = ICON_SVG.plus;
    fab.classList.remove('search-exit');
    fab.setAttribute('aria-label', tr('fab.newTransaction'));
    fab.onclick = () => openModal();
  }
}

// Panel registry: the single source of truth for every non-ledger panel.
// `bodyClass` (optional) is the class that hides the ledger chrome (month
// nav, summary tiles, search bar, FAB) while the panel is active — styles.css
// keys off it. `render` (optional) is the view renderer, run on switch. The
// render bodies are arrow-wrapped so the later-loaded feature modules supply
// the functions at call time (cross-file calls are fine at runtime). Add a new
// panel here and its body class + renderer wire up automatically — no more
// scattered if-chains for showPanel to drift out of sync with (the missing
// on-budgets CSS once shipped because the toggle lived apart from its CSS).
const PANELS = {
  charts: { bodyClass: 'in-report', render: () => renderReport() },
  categories: { render: () => renderCategoryView() },
  goals: { bodyClass: 'on-goals', render: () => renderGoalsView() },
  budgets: { bodyClass: 'on-budgets', render: () => renderBudgetsView() },
  recurring: { bodyClass: 'on-recurring', render: () => renderRecurringView() },
};

function showPanel(id) {
  if (
    appState.nav.searchQuery ||
    appState.nav.categoryFilterId != null ||
    appState.nav.tagFilterName != null
  )
    _resetSearch();
  appState.nav.activePanel = id;
  // Toggle every registered chrome class so exactly the active panel's is set.
  for (const [pid, cfg] of Object.entries(PANELS)) {
    if (cfg.bodyClass) document.body.classList.toggle(cfg.bodyClass, pid === id);
  }
  if (id !== 'charts') appState.reports.txPool = null;
  document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
  document.getElementById('panel-' + id).classList.add('active');
  document.querySelectorAll('.drawer-nav-item[data-panel]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.panel === id);
  });
  const cfg = PANELS[id];
  if (cfg && cfg.render) cfg.render();
  closeDrawer();
}

// Called from the "Reports" drawer subpanel. Sets the active report
// (incl. lock mode for the month/year trend) and switches to the
// charts panel.
function openReport(id) {
  if (!REPORT_IDS.includes(id)) id = 'overview';
  if (id === 'trend') appState.trend.pickerOpen = false;
  appState.reports.current = id;
  try {
    localStorage.setItem(REPORT_STORAGE_KEY, id);
  } catch (e) {}
  showPanel('charts');
}

const _drawerStack = [];
const _drawerSubs = [
  'dpReports',
  'dpSettings',
  'dpCats',
  'dpTags',
  'dpImport',
  'dpApiKeys',
  'dpDisplay',
  'dpAdmin',
  'dpInfo',
];

function drawerNav(panelId) {
  const current = _drawerStack.length ? _drawerStack[_drawerStack.length - 1] : 'dpMain';
  document.getElementById(current).dataset.state = 'left';
  document.getElementById(panelId).dataset.state = 'active';
  _drawerStack.push(panelId);
  document.getElementById('drawer').classList.add('sub-active');
  if (panelId === 'dpCats') renderCategories();
  if (panelId === 'dpTags') renderTagList();
  if (panelId === 'dpDisplay') syncDisplaySelects();
  if (panelId === 'dpInfo') renderInfoPanel();
  if (panelId === 'dpAdminUsers') loadAdminUsers();
  if (panelId === 'dpApiKeys') loadApiKeys();
  if (panelId === 'dpAccount') loadSessions();
}

function drawerBack() {
  if (!_drawerStack.length) return;
  const current = _drawerStack.pop();
  const prev = _drawerStack.length ? _drawerStack[_drawerStack.length - 1] : 'dpMain';
  document.getElementById(current).dataset.state = 'right';
  document.getElementById(prev).dataset.state = 'active';
  if (!_drawerStack.length) document.getElementById('drawer').classList.remove('sub-active');
}

function _drawerResetPanels() {
  document.getElementById('dpMain').dataset.state = 'active';
  _drawerSubs.forEach((id) => {
    document.getElementById(id).dataset.state = 'right';
  });
  _drawerStack.length = 0;
  document.getElementById('drawer').classList.remove('sub-active');
}

// ≥768px: drawer is a persistent sidebar — open/close become no-ops
// so a stray call (e.g. from showPanel) doesn't trap focus or lock
// body scroll. Keep this in sync with the @media breakpoint in
// styles.css (see "ADAPTIVE LAYOUT" block).
const _mqTablet = window.matchMedia('(min-width: 768px)');

// Apple-Mail style sidebar toggle (tablet only). The collapsed
// class lives on <html> because the inline restore in index.html
// runs before <body> exists; CSS targets html.sidebar-collapsed.
// The aria-pressed sync mirrors the visual state for screen readers
// — the icon swap (arrows-in ↔ arrows-out) is purely CSS-driven.
function _syncSidebarTogglePressed(collapsed) {
  const btn = document.querySelector('.sidebar-toggle-btn');
  if (btn) btn.setAttribute('aria-pressed', collapsed ? 'true' : 'false');
}

function toggleSidebar() {
  const collapsed = document.documentElement.classList.toggle('sidebar-collapsed');
  _syncSidebarTogglePressed(collapsed);
  try {
    localStorage.setItem('pocketlog.sidebarCollapsed', collapsed ? '1' : '0');
  } catch (e) {}
}

// This script is loaded with `defer`, so the DOM is ready — sync the
// aria-pressed attribute with the class state set by the inline
// head boot script.
_syncSidebarTogglePressed(document.documentElement.classList.contains('sidebar-collapsed'));

function openDrawer() {
  if (_mqTablet.matches) return;
  rememberModalFocus('drawer');
  document.getElementById('drawer').classList.add('open');
  document.getElementById('drawerOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
  trapFocusIn(document.getElementById('drawer'), 'drawer');
}

function closeDrawer() {
  if (_mqTablet.matches) return;
  document.getElementById('drawer').classList.remove('open');
  document.getElementById('drawerOverlay').classList.remove('open');
  document.body.style.overflow = '';
  releaseFocusTrap('drawer');
  restoreModalFocus('drawer');
  // _drawerStack and sub-panel data-state are deliberately kept:
  // re-opening the drawer should land back on the last sub-panel
  // the user was on (e.g. Auswertungen), not always reset to the
  // top level. _drawerResetPanels is reserved for explicit resets.
}

// Rotate / resize crossing the tablet breakpoint while a mobile
// overlay is open would leave the body scroll-locked. Reset state
// when we enter sidebar mode.
_mqTablet.addEventListener('change', (e) => {
  if (!e.matches) return;
  document.getElementById('drawer').classList.remove('open');
  document.getElementById('drawerOverlay').classList.remove('open');
  releaseFocusTrap('drawer');
  // Only release the scroll lock if no modal is still open.
  if (!document.querySelector('.modal-overlay.open')) {
    document.body.style.overflow = '';
  }
});

// Keyboard activation for elements that are interactive but cannot be
// a <button> (e.g. row contains a nested action button). Mirrors native
// button semantics: Enter and Space trigger the click; Space is
// prevented from scrolling. The `!e.repeat` guard avoids re-firing
// while the key is held. `.is-key-active` gives the keyboard press
// the same visual feedback that mouse `:active` does.
function handleRowActivate(e, fn) {
  if ((e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') && !e.repeat) {
    e.preventDefault();
    const el = e.currentTarget;
    el.classList.add('is-key-active');
    setTimeout(() => el.classList.remove('is-key-active'), 150);
    fn();
  }
}

// ── MODAL FOCUS MANAGEMENT ────────────────────────────────────────────────────
// Each modal stores the element that had focus before it opened, so the
// matching close() can restore it. Keyed by modal id to support nesting
// (tag picker opens from inside the booking modal).
const _modalPrevFocus = new Map();
const _modalTrapTeardown = new Map();

function rememberModalFocus(key) {
  _modalPrevFocus.set(key, document.activeElement);
}

function restoreModalFocus(key) {
  const el = _modalPrevFocus.get(key);
  _modalPrevFocus.delete(key);
  if (el && document.contains(el) && typeof el.focus === 'function') {
    el.focus();
  }
}

// Wraps Tab cycling inside the given root element. Returns nothing; call
// releaseFocusTrap(key) to remove the listener when the modal closes.
function trapFocusIn(rootEl, key) {
  const handler = (e) => {
    if (e.key !== 'Tab') return;
    const focusable = rootEl.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    const visible = Array.from(focusable).filter((el) => el.offsetParent !== null);
    if (!visible.length) return;
    const first = visible[0];
    const last = visible[visible.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  rootEl.addEventListener('keydown', handler);
  _modalTrapTeardown.set(key, () => rootEl.removeEventListener('keydown', handler));
}

function releaseFocusTrap(key) {
  const fn = _modalTrapTeardown.get(key);
  if (fn) fn();
  _modalTrapTeardown.delete(key);
}

// Shared open/close tail for the edit modals (goals, budgets, recurring).
// openModalShell: call AFTER the modal's fields are populated — it records the
// previously focused element, reveals the overlay, locks body scroll, moves
// focus to the first field once the open transition starts, and arms the Tab
// focus-trap. closeModalShell reverses it. `key` is the focus-trap/restore
// bucket, `overlayId` the .modal-overlay element, `focusId` the field to focus
// on open. Per-modal state resets (e.g. editingId) stay in the caller. (Named
// *Shell to avoid colliding with booking.js's own openModal/closeModal, which
// share this global script scope.)
function openModalShell(key, overlayId, focusId) {
  rememberModalFocus(key);
  document.getElementById(overlayId).classList.add('open');
  document.body.style.overflow = 'hidden';
  setTimeout(() => document.getElementById(focusId).focus(), 200);
  trapFocusIn(document.querySelector('#' + overlayId + ' .modal'), key);
}

function closeModalShell(key, overlayId) {
  document.getElementById(overlayId).classList.remove('open');
  document.body.style.overflow = '';
  releaseFocusTrap(key);
  restoreModalFocus(key);
}

function changeMonth(d) {
  appState.view.month += d;
  if (appState.view.month > 11) {
    appState.view.month = 0;
    appState.view.year++;
  }
  if (appState.view.month < 0) {
    appState.view.month = 11;
    appState.view.year--;
  }
  loadAndRender();
}

// ── MONTH/YEAR PICKER (header popover) ────────────────────────────────────────
// The month label is a button that opens a popover: a year stepper above a
// 12-month grid, plus a "Today" shortcut. The arrows next to it keep doing
// ±1-month steps; the popover is for jumping further. pickerYear (state.js) is
// the year being browsed and is only committed to view.year when a month is
// picked, so stepping years doesn't reload the ledger.

function _monthPickerCloseOnOutside(e) {
  const pop = document.getElementById('monthPicker');
  const label = document.getElementById('monthLabel');
  if (!pop || pop.contains(e.target) || (label && label.contains(e.target))) return;
  toggleMonthPicker(false);
}

function _monthPickerCloseOnEsc(e) {
  if (e.key === 'Escape') toggleMonthPicker(false);
}

function toggleMonthPicker(open) {
  const next = open === undefined ? !appState.view.pickerOpen : !!open;
  const pop = document.getElementById('monthPicker');
  const label = document.getElementById('monthLabel');
  if (!pop) return;
  appState.view.pickerOpen = next;
  pop.hidden = !next;
  if (label) label.setAttribute('aria-expanded', String(next));
  if (next) {
    appState.view.pickerYear = appState.view.year;
    rememberModalFocus('monthPicker');
    renderMonthPicker();
    trapFocusIn(pop, 'monthPicker');
    // Defer so the click that opened the popover doesn't immediately close it.
    setTimeout(() => {
      document.addEventListener('pointerdown', _monthPickerCloseOnOutside);
      document.addEventListener('keydown', _monthPickerCloseOnEsc);
      const current = pop.querySelector('.mp-month.is-current') || pop.querySelector('.mp-month');
      if (current) current.focus();
    }, 0);
  } else {
    releaseFocusTrap('monthPicker');
    document.removeEventListener('pointerdown', _monthPickerCloseOnOutside);
    document.removeEventListener('keydown', _monthPickerCloseOnEsc);
    restoreModalFocus('monthPicker');
  }
}

function renderMonthPicker() {
  const year = appState.view.pickerYear;
  document.getElementById('mpYear').textContent = String(year);
  const grid = document.getElementById('mpGrid');
  const today = new Date();
  grid.innerHTML = appState.calendar.monthsShort
    .map((name, m) => {
      const isSelected = m === appState.view.month && year === appState.view.year;
      const isToday = m === today.getMonth() && year === today.getFullYear();
      const cls = ['mp-month'];
      if (isSelected) cls.push('is-current');
      if (isToday) cls.push('is-today');
      return `<button type="button" class="${cls.join(' ')}" data-action="pickMonth" data-args="[${m}]"${
        isSelected ? ' aria-current="true"' : ''
      }>${_escText(name)}</button>`;
    })
    .join('');
}

function stepPickerYear(d) {
  appState.view.pickerYear += d;
  renderMonthPicker();
}

function pickMonth(m) {
  appState.view.month = m;
  appState.view.year = appState.view.pickerYear;
  toggleMonthPicker(false);
  loadAndRender();
}

function goToCurrentMonth() {
  const now = new Date();
  appState.view.month = now.getMonth();
  appState.view.year = now.getFullYear();
  toggleMonthPicker(false);
  loadAndRender();
}
