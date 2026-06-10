// ── ICON-MARKUP ───────────────────────────────────────────────────────────────
// Für Glyphen, die dynamisch via JS getauscht werden (FAB-Toggle Plus/✕,
// Tag-Pill-Remove). Statische Glyphen sitzen direkt im HTML-Markup.
const ICON_SVG = {
  plus: '<svg class="ui-icon" aria-hidden="true"><use href="#icon-plus"/></svg>',
  close: '<svg class="ui-icon" aria-hidden="true"><use href="#icon-close"/></svg>',
};

// ── i18n SHORTHAND ────────────────────────────────────────────────────────────
// `tr()` (not `t()`) is the translation helper: `t` is used pervasively
// as the transaction loop variable in .map((t) => …) callbacks, so a
// global `t` would shadow-collide. tr() delegates to i18n.js and falls
// back to the key when the runtime isn't ready (keeps render safe).
const tr = (key, params) => (window.I18N ? I18N.t(key, params) : key);

// ── API-BASIS ─────────────────────────────────────────────────────────────────
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
// Welche Auswertung gerade aktiv ist (Quelle der Wahrheit für panel-charts).
// Persistiert in localStorage, damit ein Reload den letzten Stand zeigt.
const REPORT_STORAGE_KEY = 'pocketlog.report';
const REPORT_IDS = ['overview', 'month', 'year', 'categories', 'tags', 'trend', 'forecast', 'top'];
// Report id → i18n key. Resolved through t() at render time so the
// titles follow the active language.
const REPORT_TITLE_KEYS = {
  overview: 'reports.overview',
  month: 'reports.month',
  year: 'reports.year',
  categories: 'reports.categories',
  tags: 'reports.tags',
  trend: 'reports.trend',
  forecast: 'reports.forecast',
  top: 'reports.top',
};
const reportTitle = (id) => tr(REPORT_TITLE_KEYS[id] || 'reports.overview');
// Reports state lives in appState.reports (state.js). `current` (the active
// report) is restored from localStorage here, defaulting to 'overview'; the
// `range` (period picker) and `rangeLock` (optional 'month'/'year' lock that
// pins the picker for reports only meaningful at one granularity; null = free)
// keep their identical defaults from state.js.
appState.reports.current = (() => {
  const v = localStorage.getItem(REPORT_STORAGE_KEY);
  return REPORT_IDS.includes(v) ? v : 'overview';
})();
// Chart.js-Instanzen pro Report, getrennt damit destroy() keine fremde Instanz trifft.
const chartInsts = { month: null, year: null, categories: null, tags: null, trend: null };

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
// Pro-Jahr-Cache der Transaktionen. Bei jedem write geleert.
const _txCacheByYear = new Map();
function invalidateReportCache() {
  _txCacheByYear.clear();
}
// appState.reports.searchExitTarget — drill-down from the category analysis
// remembers where „Abbrechen" jumps back to. appState.reports.txPool — the
// last transactions loaded by the active report, consulted by editTransaction
// so a click on a top list finds the real booking (not just the current
// month's from the transactions view). Both default in state.js.

// Core ledger data lives in appState.ledger (state.js): transactions (the
// current view's slice, loaded per API), categories (loaded per API),
// appState.ledger.availableTags (the user's distinct tags, alphabetical) and `all` (the full
// pool used by search). `appState.ledger.all` below maps to appState.ledger.all.
const tagCounts = new Map(); // tag-name (case-folded) → Anzahl Verwendungen

// ── API HELPER ────────────────────────────────────────────────────────────────
// Same-origin Cookie-Session. CSRF-Token wird beim Login / Bootstrap
// eingesammelt und in window._csrfToken gehalten. Bei 401 reload-en
// wir hart, damit init() sauber auf die Login-View landet — kein
// veralteter App-State bleibt im DOM.
window._csrfToken = '';

// Auth-Boundary-Cleanup: vor jedem 401-induzierten Reload den
// API-Cache und den im SW gehaltenen CSRF-Token wegwerfen. Sonst
// würde der nächste Page-Load auf eine gecachte me-Response treffen
// (Force-Change-View ohne Session), oder die Outbox einen stale
// CSRF-Token mitschicken (403 beim Replay → silent Datenverlust).
function _resetAuthClientState() {
  try {
    if (navigator.serviceWorker?.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'CLEAR_API_CACHE' });
    }
  } catch (_) {}
  window._csrfToken = '';
}

// Nuklearer Reset: SW unregistrieren UND alle Caches platt machen.
// Wird vom Force-Change-Pfad als Escape-Hatch genutzt, wenn die
// Server-Antwort beweist, dass die gerade gerenderte View zum echten
// Session-State nicht passt — typisch ein alter SW oder ein
// iOS-„Frozen-Page-Cache", der noch die alte 200/me-Response
// festhält, obwohl „Verlauf und Websitedaten löschen" schon
// durchgelaufen ist. localStorage bleibt drin, damit Theme +
// Default-View überleben.
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
  // Mit cache-busting-Param laden, damit Safari den BFCache nicht
  // einfach wieder hinrendert. Reicht für iOS Safari-Eigenheiten.
  location.replace('/?reset=' + Date.now());
}

async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (method !== 'GET' && window._csrfToken) {
    headers['X-CSRF-Token'] = window._csrfToken;
  }
  const opts = { method, headers, credentials: 'same-origin' };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(API + path, opts);
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

// Auth-Endpoints umgehen api() — bei 401/429 wollen wir die Antwort
// selbst behandeln, ohne in den location.reload()-Pfad zu fallen.
// ABER: wenn der Caller ``opts.reloadOn401 !== false`` lässt und
// eine 401 kommt, machen wir trotzdem den harten Reload — sonst
// bleibt der User in einer View hängen, zu der sein Session-State
// nicht mehr passt.
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

function _broadcastCsrfToSw(token) {
  try {
    if (navigator.serviceWorker?.controller) {
      navigator.serviceWorker.controller.postMessage({
        type: 'SET_CSRF',
        token: token || '',
      });
    }
  } catch (_) {}
}

// Passwort-Policy: 12 Zeichen + 4 Zeichenklassen. Spiegelt die
// Server-seitige Regel in schemas.validate_password_complexity —
// beide Stellen müssen synchron bleiben. Unicode-property-Regex,
// damit „Ä", „ß", „é" wie auf dem Server als Buchstaben zählen
// (und nicht als Sonderzeichen).
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
function _passwordErrorMessage(data) {
  const det = data && data.detail;
  if (!Array.isArray(det)) return null;
  const e = det.find((d) => Array.isArray(d.loc) && d.loc.some((x) => /password/i.test(String(x))));
  if (!e) return null;
  const ctx = e.ctx || {};
  if (e.type === 'string_too_short')
    return tr('pwd.tooShort', { n: ctx.min_length != null ? ctx.min_length : 12 });
  if (e.type === 'string_too_long')
    return tr('pwd.tooLong', { n: ctx.max_length != null ? ctx.max_length : 128 });
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
    if (miss[0] && map[miss[0]]) return tr(map[miss[0]]);
  }
  return null;
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

function showPanel(id) {
  if (
    appState.nav.searchQuery ||
    appState.nav.categoryFilterId != null ||
    appState.nav.tagFilterName != null
  )
    _resetSearch();
  appState.nav.activePanel = id;
  document.body.classList.toggle('in-report', id === 'charts');
  document.body.classList.toggle('on-goals', id === 'goals');
  document.body.classList.toggle('on-recurring', id === 'recurring');
  if (id !== 'charts') appState.reports.txPool = null;
  document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
  document.getElementById('panel-' + id).classList.add('active');
  document.querySelectorAll('.drawer-nav-item[data-panel]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.panel === id);
  });
  if (id === 'charts') renderReport();
  if (id === 'categories') renderCategoryView();
  if (id === 'goals') renderGoalsView();
  if (id === 'recurring') renderRecurringView();
  closeDrawer();
}

// Wird aus dem Drawer-Subpanel „Auswertungen" aufgerufen. Setzt den aktiven
// Report (inkl. Lock-Mode bei Monat-/Jahresverlauf) und schaltet auf das
// Charts-Panel.
function openReport(id) {
  if (!REPORT_IDS.includes(id)) id = 'overview';
  if (id === 'trend') appState.trend.pickerOpen = false;
  appState.reports.current = id;
  try {
    localStorage.setItem(REPORT_STORAGE_KEY, id);
  } catch (e) {}
  if (id === 'month' && appState.reports.range.kind !== 'month')
    setRangeKind('month', { skipRender: true });
  if (id === 'year' && appState.reports.range.kind !== 'year')
    setRangeKind('year', { skipRender: true });
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

// app.js is loaded with `defer`, so the DOM is ready — sync the
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
// ── LOAD & RENDER ─────────────────────────────────────────────────────────────
function normalizeTx(t) {
  // Tags come pre-resolved from the server (M2M-backed since
  // 0008_transaction_tags) — each name is the canonical row in
  // the tags table, so no client-side casing fix-up is needed.
  return { ...t, amount: Number(t.amount), tags: (t.tags || []).slice() };
}

async function loadAndRender() {
  document.getElementById('monthLabel').textContent =
    `${appState.calendar.months[appState.view.month]} ${appState.view.year}`;
  try {
    const raw = await api(
      'GET',
      `/transactions?year=${appState.view.year}&month=${appState.view.month + 1}`,
    );
    appState.ledger.transactions = raw.map(normalizeTx);
  } catch (e) {
    console.error('Fehler beim Laden:', e);
    appState.ledger.transactions = [];
  }
  renderAll();
  if (appState.nav.searchQuery) {
    try {
      const all = await api('GET', '/transactions');
      appState.ledger.all = all.map(normalizeTx);
    } catch (e) {
      appState.ledger.all = [];
    }
    applySearch();
  }
}

function renderAll() {
  document.getElementById('monthLabel').textContent =
    `${appState.calendar.months[appState.view.month]} ${appState.view.year}`;
  const out = appState.ledger.transactions
    .filter((t) => t.type === 'out')
    .reduce((a, t) => a + t.amount, 0);
  const inc = appState.ledger.transactions
    .filter((t) => t.type === 'in')
    .reduce((a, t) => a + t.amount, 0);
  // No +/− sign on the summary cards — the label and the
  // positive/negative color already convey direction, and dropping the
  // sign keeps long amounts from overflowing the card's right edge.
  // Matches the report-view summary cards (fmtCurrency for in/out).
  document.getElementById('totalOut').textContent = fmtCurrency(out);
  document.getElementById('totalIn').textContent = fmtCurrency(inc);
  applySearch();
  if (appState.nav.activePanel === 'categories') renderCategoryView();
}

function applySearch() {
  const q = appState.nav.searchQuery;
  const catFilter = appState.nav.categoryFilterId;
  const tagFilter = appState.nav.tagFilterName;
  if (!q && catFilter == null && tagFilter == null) {
    renderTransactions(appState.ledger.transactions);
    return;
  }
  // The drill-down from the monthly view leaves `appState.ledger.all` unset,
  // so we naturally fall back to the month-scoped `transactions` pool.
  // When the drill-down comes from a report, `appState.ledger.all` holds the
  // report range — same logic, just a wider pool.
  const pool = appState.ledger.all ?? appState.ledger.transactions;
  const filtered = pool.filter((t) => {
    if (catFilter != null) return t.category_id === catFilter;
    if (tagFilter != null) return Array.isArray(t.tags) && t.tags.includes(tagFilter);
    if ((t.desc || '').toLowerCase().includes(q)) return true;
    const cat = getCatById(t.category_id);
    if (cat.name.toLowerCase().includes(q)) return true;
    if (t.tags && t.tags.some((tag) => tag.toLowerCase().includes(q))) return true;
    return false;
  });
  renderTransactions(filtered, document.getElementById('searchResultsList'));
}

async function _setSearchPanelActive(active) {
  const fab = document.querySelector('.fab');
  if (active) {
    document.body.classList.add('searching');
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    document.getElementById('panel-search').classList.add('active');
    fab.innerHTML = ICON_SVG.close;
    fab.classList.add('search-exit');
    fab.setAttribute('aria-label', tr('fab.exitSearch'));
    fab.onclick = clearSearch;
    // Only load the global pool for text search — category drill-down
    // stays month-scoped via the already-loaded `transactions`.
    if (appState.nav.searchQuery && !appState.ledger.all) {
      try {
        const raw = await api('GET', '/transactions');
        appState.ledger.all = raw.map(normalizeTx);
      } catch (e) {
        appState.ledger.all = [];
      }
    }
    applySearch();
  } else {
    appState.ledger.all = null;
    document.body.classList.remove('searching');
    document.getElementById('panel-search').classList.remove('active');
    document.getElementById('panel-' + appState.nav.activePanel).classList.add('active');
    fab.innerHTML = ICON_SVG.plus;
    fab.classList.remove('search-exit');
    fab.setAttribute('aria-label', tr('fab.newTransaction'));
    fab.onclick = () => openModal();
  }
}

async function onSearch(val) {
  // Typing in the search input cancels any active drill-down filter
  // so the panel switches back to plain text-match behaviour.
  if (appState.nav.categoryFilterId != null) appState.nav.categoryFilterId = null;
  if (appState.nav.tagFilterName != null) appState.nav.tagFilterName = null;
  const wasEmpty = !appState.nav.searchQuery;
  appState.nav.searchQuery = val.trim().toLowerCase();
  if (appState.nav.searchQuery && wasEmpty) await _setSearchPanelActive(true);
  else if (!appState.nav.searchQuery && !wasEmpty) _setSearchPanelActive(false);
  else applySearch();
}

function clearSearch() {
  const wasActive =
    !!appState.nav.searchQuery ||
    appState.nav.categoryFilterId != null ||
    appState.nav.tagFilterName != null;
  const exitTo = appState.reports.searchExitTarget;
  appState.reports.searchExitTarget = null;
  _resetSearch();
  if (wasActive) _setSearchPanelActive(false);
  if (exitTo) showPanel(exitTo);
}

function getCatById(id) {
  return (
    appState.ledger.categories.find((c) => c.id === Number(id)) || {
      name: tr('categories.fallbackName'),
      icon: 'package',
      color: '#9e9b96',
    }
  );
}

function renderTransactions(txs, el = document.getElementById('transactionList')) {
  if (!txs.length) {
    el.innerHTML = appState.nav.searchQuery
      ? `<div class="empty-state"><svg class="icon" aria-hidden="true"><use href="#icon-search"/></svg><p>${tr('tx.emptySearch', { query: _escText(appState.nav.searchQuery) })}<br>${tr('tx.emptySearchHint')}</p></div>`
      : `<div class="empty-state"><svg class="icon" aria-hidden="true"><use href="#icon-inbox-empty"/></svg><p>${tr('tx.emptyMonth')}<br>${tr('tx.emptyMonthHint')}</p></div>`;
    return;
  }
  // Group by date
  const groups = {};
  txs.forEach((t) => {
    (groups[t.date] = groups[t.date] || []).push(t);
  });
  el.innerHTML = Object.entries(groups)
    .map(([date, list]) => {
      const d = new Date(date + 'T12:00:00');
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const dDay = new Date(date + 'T00:00:00');
      const label =
        dDay.getTime() === today.getTime()
          ? tr('date.today')
          : dDay.getTime() === today.getTime() - 86400000
            ? tr('date.yesterday')
            : d.toLocaleDateString(_locale(), {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
                year: 'numeric',
              });
      return (
        `<div class="section-title">${label}</div>` +
        list
          .map((t) => {
            const cat = getCatById(t.category_id);
            const tagsHtml = (t.tags || [])
              .map((tg) => `<span class="t-tag">${_escText(tg)}</span>`)
              .join('');
            const note = (t.desc || '').trim();
            // Badge sits as a sibling of .t-note inside .t-info,
            // not inside .t-note itself — .t-note ellipsizes,
            // which would clip the badge precisely on the rows
            // that need the "from rule" signal most.
            const recurringBadge = t.source_rule_id
              ? `<span class="tx-recurring-badge" role="img" aria-label="${_escAttr(tr('recurring.fromRule'))}" title="${_escAttr(tr('recurring.fromRule'))}"><svg class="ui-icon" aria-hidden="true"><use href="#icon-arrows-clockwise"/></svg></span>`
              : '';
            return `<div class="tx-row" data-id="${t.id}">
        <button class="tx-action" type="button" aria-label="${_escAttr(tr('tx.deleteAria'))}">${tr('common.delete')}</button>
        <div class="transaction">
          <div class="t-icon" style="--cat-color:${cat.color}">${catIconSvg(cat.icon)}</div>
          <span class="visually-hidden">${_escText(cat.name)}</span>
          <div class="t-info">
            <div class="t-note-row">
              <span class="t-note">${_escText(note)}</span>${recurringBadge}
            </div>
            <div class="t-tags">${tagsHtml}</div>
          </div>
          <div class="t-amount ${t.type}">${fmtCurrency(Math.abs(t.amount))}</div>
        </div>
      </div>`;
          })
          .join('')
      );
    })
    .join('');
  attachSwipeHandlers(el);
}

function renderCategoryView() {
  const el = document.getElementById('categoryViewList');
  if (!el) return;

  if (!appState.ledger.categories.length) {
    el.innerHTML = `<div class="empty-state"><svg class="icon" aria-hidden="true"><use href="#icon-inbox-empty"/></svg><p>${tr('categories.emptyView')}<br>${tr('categories.emptyViewHint')}</p></div>`;
    return;
  }

  // Net amount per category from current month's transactions
  const totals = {};
  appState.ledger.transactions.forEach((t) => {
    const key = t.category_id ?? 0;
    if (!totals[key]) totals[key] = 0;
    totals[key] += t.type === 'out' ? -t.amount : t.amount;
  });

  // All categories, sorted alphabetically — zero if no transactions this month
  const rows = appState.ledger.categories
    .map((cat) => ({
      id: cat.id,
      name: cat.name,
      icon: cat.icon,
      color: cat.color,
      net: totals[cat.id] ?? 0,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, _locale(), { sensitivity: 'base' }));

  el.innerHTML = rows
    .map(
      (r) => `
    <div class="cat-view-row" role="button" tabindex="0"
      aria-label="${_escAttr(tr('categories.editAria', { name: r.name }))}"
      onclick="openModalForCategory(${r.id})"
      onkeydown="handleRowActivate(event, () => openModalForCategory(${r.id}))">
      <span class="cat-view-icon" style="--cat-color:${r.color}">${catIconSvg(r.icon)}</span>
      <span class="cat-view-name">${_escText(r.name)}</span>
      <span class="cat-view-amount ${r.net > 0 ? 'positive' : r.net < 0 ? 'negative' : ''}">${fmtCurrency(Math.abs(r.net))}</span>
      <button
        type="button"
        class="cat-view-more"
        aria-label="${_escAttr(tr('categories.viewTxAria', { name: r.name }))}"
        onclick="event.stopPropagation(); showTransactionsForCategory(${r.id})"
      ><svg class="ui-icon" aria-hidden="true"><use href="#icon-more-vertical"/></svg></button>
    </div>
  `,
    )
    .join('');
}

function openModalForCategory(catId) {
  openModal(null);
  document.getElementById('inputCat').value = catId;
}

async function showTransactionsForCategory(catId) {
  const cat = getCatById(catId);
  // Reuses the search-results panel as the host UI, but the actual
  // filter is exact-by-id (applySearch checks appState.nav.categoryFilterId
  // before the substring search path).
  appState.nav.categoryFilterId = catId;
  appState.nav.searchQuery = '';
  document.getElementById('searchInput').value = cat.name;
  await _setSearchPanelActive(true);
}

// ── SWIPE-TO-DELETE ───────────────────────────────────────────────────────────
// Must match the CSS token --swipe-action-w. The CSS owns the visible
// delete-button width; this constant clamps the drag to the same value
// so the rest position when the user releases matches their finger.
const SWIPE_ACTION_WIDTH = 92;
const SWIPE_OPEN_THRESHOLD = 40; // Pixel, ab denen die Action offen einrastet
const TAP_TOLERANCE = 6; // Pixel-Slop, unter dem ein Pointer-Down als Tap zählt

function closeAllSwipes(except) {
  document.querySelectorAll('.tx-row.swiped').forEach((r) => {
    if (r !== except) r.classList.remove('swiped');
  });
}

function attachSwipeHandlers(container) {
  container.querySelectorAll('.tx-row').forEach((row) => {
    const inner = row.querySelector('.transaction');
    const action = row.querySelector('.tx-action');
    let startX = 0,
      startY = 0,
      dx = 0,
      dragging = false,
      committedAxis = null, // 'x' once we've decided the gesture is a swipe
      openOnStart = false;

    inner.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      startX = e.clientX;
      startY = e.clientY;
      dx = 0;
      dragging = true;
      committedAxis = null;
      openOnStart = row.classList.contains('swiped');
      row.classList.add('dragging');
      try {
        inner.setPointerCapture(e.pointerId);
      } catch (_) {}
    });

    inner.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const rawDx = e.clientX - startX;
      const rawDy = e.clientY - startY;
      // Discriminate axis only once the finger has moved past a small
      // slop, so a vertical scroll never briefly shifts the card and
      // reveals the red delete action behind it. Once committed to a
      // direction, stay there for the rest of the gesture.
      if (committedAxis == null) {
        const ax = Math.abs(rawDx);
        const ay = Math.abs(rawDy);
        if (ax < 8 && ay < 8) return; // still in slop
        if (ay >= ax) {
          // Vertical intent — release the gesture and let the page scroll.
          endDrag(true);
          return;
        }
        committedAxis = 'x';
      }
      let delta = rawDx;
      if (openOnStart) delta -= SWIPE_ACTION_WIDTH;
      dx = Math.min(0, Math.max(-SWIPE_ACTION_WIDTH, delta));
      inner.style.transform = `translateX(${dx}px)`;
    });

    function endDrag(cancelled) {
      if (!dragging) return;
      dragging = false;
      row.classList.remove('dragging');
      inner.style.transform = '';

      if (cancelled) {
        // Wurde vom Browser abgebrochen (z.B. vertikaler Scroll): Status nicht ändern
        return;
      }

      const movedFar = dx < -SWIPE_OPEN_THRESHOLD;
      if (movedFar) {
        closeAllSwipes(row);
        row.classList.add('swiped');
      } else if (Math.abs(dx) < TAP_TOLERANCE) {
        // Tap
        if (openOnStart) {
          row.classList.remove('swiped');
        } else {
          closeAllSwipes();
          editTransaction(Number(row.dataset.id));
        }
      } else {
        row.classList.remove('swiped');
      }
    }

    inner.addEventListener('pointerup', () => endDrag(false));
    inner.addEventListener('pointercancel', () => endDrag(true));

    const deleteRow = async () => {
      const id = Number(row.dataset.id);
      const ok = await confirmAction({
        title: tr('tx.deleteConfirm'),
        confirmLabel: tr('common.delete'),
      });
      if (!ok) {
        row.classList.remove('swiped');
        return;
      }
      try {
        await api('DELETE', `/transactions/${id}`);
        await loadAndRender();
      } catch (err) {
        if (await _enqueueOfflineDelete(id)) {
          row.classList.remove('swiped');
          // Optimistisch entfernen, Sync übernimmt der SW
          appState.ledger.transactions = appState.ledger.transactions.filter((t) => t.id !== id);
          renderAll();
          updateSyncBadge();
          return;
        }
        toast(tr('tx.deleteFailed') + err.message, 'error');
        row.classList.remove('swiped');
      }
    };

    action.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteRow();
    });
  });
}

// Beim Tippen außerhalb einer offenen Zeile diese wieder schließen.
// Einmaliger globaler Listener (nicht pro Render neu registrieren).
document.addEventListener(
  'pointerdown',
  (e) => {
    if (!e.target.closest('.tx-row')) closeAllSwipes();
  },
  { capture: true },
);

// ── CHARTS ────────────────────────────────────────────────────────────────────
function getChartColors() {
  // Read the effective theme from data-dark — same source CSS uses.
  const dark = document.documentElement.getAttribute('data-dark') === 'true';
  return {
    grid: dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
    text: dark ? '#a09d98' : '#6b6760',
  };
}

// Liest einen CSS-Custom-Property-Wert aus dem aktiven Theme. Wenn `alpha` < 1
// wird der Hex-Wert nach rgba() konvertiert, damit Chart.js eine transparente
// Variante zeichnen kann. Nur Hex-Tokens (#RRGGBB) werden unterstützt — alle
// Reports-Akzente sind als Hex hinterlegt.
function cssColor(name, alpha = 1) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (alpha >= 1 || !v.startsWith('#')) return v;
  const n = parseInt(v.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

// ── REPORTS — RANGE & DATA ────────────────────────────────────────────────────
// _iso() and _daysInMonth() live in utils.js (loaded before this file).

function computeRange(kind, a) {
  if (kind === 'month') {
    const last = _daysInMonth(a.y, a.m);
    return { from: _iso(a.y, a.m, 1), to: _iso(a.y, a.m, last) };
  }
  if (kind === 'quarter') {
    const startM = a.q * 3;
    const endM = startM + 2;
    const last = _daysInMonth(a.y, endM);
    return { from: _iso(a.y, startM, 1), to: _iso(a.y, endM, last) };
  }
  if (kind === 'year') {
    return { from: _iso(a.y, 0, 1), to: _iso(a.y, 11, 31) };
  }
  // custom: from/to bleiben wie zuletzt eingegeben.
  return { from: appState.reports.range.from, to: appState.reports.range.to };
}

function applyRange(opts = {}) {
  const r = computeRange(appState.reports.range.kind, appState.reports.range.anchor);
  if (appState.reports.range.kind !== 'custom') {
    appState.reports.range.from = r.from;
    appState.reports.range.to = r.to;
  }
  updatePickerUI();
  if (!opts.skipRender && appState.nav.activePanel === 'charts') renderReport();
}

function setRangeKind(kind, opts = {}) {
  if (appState.reports.rangeLock && kind !== appState.reports.rangeLock) return;
  if (!['month', 'quarter', 'year', 'custom'].includes(kind)) return;
  appState.reports.range.kind = kind;
  if (kind === 'custom' && (!appState.reports.range.from || !appState.reports.range.to)) {
    // Beim Wechsel auf „Eigen" mit den aktuellen Monatsgrenzen vorbelegen.
    const r = computeRange('month', appState.reports.range.anchor);
    appState.reports.range.from = r.from;
    appState.reports.range.to = r.to;
  }
  applyRange(opts);
}

function shiftRange(delta) {
  const a = appState.reports.range.anchor;
  if (appState.reports.range.kind === 'month') {
    let m = a.m + delta,
      y = a.y;
    while (m < 0) {
      m += 12;
      y--;
    }
    while (m > 11) {
      m -= 12;
      y++;
    }
    a.m = m;
    a.y = y;
    a.q = Math.floor(m / 3);
  } else if (appState.reports.range.kind === 'quarter') {
    let q = a.q + delta,
      y = a.y;
    while (q < 0) {
      q += 4;
      y--;
    }
    while (q > 3) {
      q -= 4;
      y++;
    }
    a.q = q;
    a.y = y;
    a.m = q * 3;
  } else if (appState.reports.range.kind === 'year') {
    a.y += delta;
  } else {
    return; // Custom hat keinen Stepper
  }
  applyRange();
}

function onCustomRangeChange() {
  const from = document.getElementById('rangeFrom').value;
  const to = document.getElementById('rangeTo').value;
  if (!from || !to) return;
  if (from > to) {
    toast(tr('reports.endAfterStart'));
    return;
  }
  appState.reports.range.from = from;
  appState.reports.range.to = to;
  renderReport();
}

function setRangeLock(kind) {
  appState.reports.rangeLock = kind;
  const tabs = document.querySelectorAll('#rangeKindTabs button');
  tabs.forEach((b) => {
    const allowed = !kind || b.dataset.kind === kind;
    b.disabled = !allowed;
    b.setAttribute('aria-disabled', String(!allowed));
  });
}

function _rangeStepperLabel() {
  const a = appState.reports.range.anchor;
  if (appState.reports.range.kind === 'month') return `${appState.calendar.months[a.m]} ${a.y}`;
  if (appState.reports.range.kind === 'quarter') return `Q${a.q + 1} ${a.y}`;
  if (appState.reports.range.kind === 'year') return `${a.y}`;
  return '';
}

function _rangeSubtitle(txCount) {
  const noun = txCount === 1 ? tr('tx.countOne') : tr('tx.countOther');
  if (appState.reports.range.kind === 'custom') {
    const fmt = (iso) => {
      const [y, m, d] = iso.split('-');
      return new Date(Number(y), Number(m) - 1, Number(d)).toLocaleDateString(_locale());
    };
    return `${fmt(appState.reports.range.from)} – ${fmt(appState.reports.range.to)} · ${txCount} ${noun}`;
  }
  return `${_rangeStepperLabel()} · ${txCount} ${noun}`;
}

function updatePickerUI() {
  document.querySelectorAll('#rangeKindTabs button').forEach((b) => {
    const active = b.dataset.kind === appState.reports.range.kind;
    b.setAttribute('aria-selected', String(active));
    b.classList.toggle('is-active', active);
  });
  const stepper = document.getElementById('rangeStepper');
  const custom = document.getElementById('rangeCustom');
  if (appState.reports.range.kind === 'custom') {
    stepper.hidden = true;
    custom.hidden = false;
    document.getElementById('rangeFrom').value = appState.reports.range.from || '';
    document.getElementById('rangeTo').value = appState.reports.range.to || '';
  } else {
    stepper.hidden = false;
    custom.hidden = true;
    document.getElementById('rangeStepperLabel').textContent = _rangeStepperLabel();
  }
}

async function _loadYearTxs(year) {
  if (_txCacheByYear.has(year)) return _txCacheByYear.get(year);
  try {
    const raw = await api('GET', `/transactions?year=${year}`);
    const txs = raw.map(normalizeTx);
    _txCacheByYear.set(year, txs);
    return txs;
  } catch (e) {
    return [];
  }
}

async function loadRangeTxs(from, to) {
  if (!from || !to) return [];
  const y1 = parseInt(from.slice(0, 4), 10);
  const y2 = parseInt(to.slice(0, 4), 10);
  const years = [];
  for (let y = y1; y <= y2; y++) years.push(y);
  const pools = await Promise.all(years.map(_loadYearTxs));
  const all = pools.flat();
  return all.filter((t) => t.date >= from && t.date <= to);
}

// ── REPORTS — RENDER DISPATCH ─────────────────────────────────────────────────

async function renderReport(id = appState.reports.current) {
  if (!REPORT_IDS.includes(id)) id = 'overview';
  appState.reports.current = id;
  try {
    localStorage.setItem(REPORT_STORAGE_KEY, id);
  } catch (e) {}
  document.body.setAttribute('data-report', id);
  if (id === 'trend') {
    await _ensureTrendDefaultRange();
  }
  const locks = { month: 'month', year: 'year' };
  setRangeLock(locks[id] || null);
  if (appState.reports.rangeLock && appState.reports.range.kind !== appState.reports.rangeLock) {
    appState.reports.range.kind = appState.reports.rangeLock;
    applyRange({ skipRender: true });
  }
  updatePickerUI();
  document.getElementById('reportTitle').textContent = reportTitle(id);

  Object.keys(chartInsts).forEach((k) => {
    if (chartInsts[k]) {
      chartInsts[k].destroy();
      chartInsts[k] = null;
    }
  });

  const body = document.getElementById('reportBody');
  body.innerHTML = '';

  // Trend uses its own private year range and never touches appState.reports.range.
  const rangeFrom =
    id === 'trend' ? `${appState.trend.yearFrom}-01-01` : appState.reports.range.from;
  const rangeTo = id === 'trend' ? `${appState.trend.yearTo}-12-31` : appState.reports.range.to;
  const txs = await loadRangeTxs(rangeFrom, rangeTo);
  appState.reports.txPool = txs;
  document.getElementById('reportRangeLabel').textContent = _rangeSubtitle(txs.length);

  if (id === 'overview') await renderReportOverview(body, txs);
  else if (id === 'month') renderReportMonth(body, txs);
  else if (id === 'year') await renderReportYear(body, txs);
  else if (id === 'categories') renderReportCategories(body, txs);
  else if (id === 'tags') renderReportTags(body, txs);
  else if (id === 'trend') await renderReportTrend(body, txs);
  else if (id === 'forecast') await renderReportForecast(body, txs);
  else if (id === 'top') renderReportTop(body, txs);
}

// ── REPORTS — SHARED HELPERS ──────────────────────────────────────────────────

// _sumByType() and _totalsByCategory() live in reportsData.js (loaded before
// this file).

function _catRowMarkup(catId, amount, max, opts = {}) {
  const cat = getCatById(catId);
  if (!cat) return '';
  const pct = max > 0 ? (amount / max) * 100 : 0;
  const drill = opts.drillDown
    ? `role="button" tabindex="0" onclick="drillDownCategory(${catId})" onkeydown="handleRowActivate(event, () => drillDownCategory(${catId}))"`
    : '';
  return `<div class="cat-row" ${drill}>
          <div class="cat-icon" style="--cat-color:${cat.color}">${catIconSvg(cat.icon)}</div>
          <div class="cat-info">
            <div class="cat-name">${_escText(cat.name)}</div>
            <div class="cat-bar-wrap"><div class="cat-bar" style="width:${pct}%;background:${cat.color}"></div></div>
          </div>
          <div class="cat-amount">${fmtCurrency(-Math.abs(amount))}</div>
        </div>`;
}

function _txRowMarkup(t) {
  const cat = getCatById(t.category_id);
  const dateLbl = (() => {
    const [y, m, d] = t.date.split('-');
    return `${d}.${m}.${y}`;
  })();
  const tagsHtml = (t.tags || [])
    .map((tag) => `<span class="t-tag">${_escText(tag)}</span>`)
    .join('');
  return `<div class="report-tx-row" role="button" tabindex="0"
          onclick="editTransaction(${t.id})"
          onkeydown="handleRowActivate(event, () => editTransaction(${t.id}))">
          <div class="cat-icon" style="--cat-color:${cat.color}">${catIconSvg(cat.icon)}</div>
          <div class="report-tx-main">
            <div class="report-tx-desc">${_escText(t.desc || cat.name)}</div>
            <div class="t-tags">${tagsHtml}</div>
            <div class="report-tx-meta">${dateLbl}</div>
          </div>
          <div class="report-tx-amount ${t.type === 'out' ? 'negative' : 'positive'}">${fmtCurrency(Math.abs(t.amount))}</div>
        </div>`;
}

function _emptyState(msg) {
  return `<p class="empty-state-hint center">${msg}</p>`;
}

// ── REPORTS — OVERVIEW ────────────────────────────────────────────────────────

async function renderReportOverview(body, txs) {
  const totals = _sumByType(txs);
  const balance = totals.in - totals.out;
  const cats = _totalsByCategory(txs, 'out').slice(0, 3);
  const tags = _totalsByTag(txs, 'out').slice(0, 3);
  const topTx = [...txs]
    .filter((t) => t.type === 'out')
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 3);
  const maxCat = cats[0]?.amount || 1;
  const maxTag = tags[0]?.amount || 1;

  body.innerHTML = `
          <div class="report-kpis">
            <div class="summary-card"><div class="label">${tr('reports.income')}</div><div class="amount positive">${fmtCurrency(totals.in)}</div></div>
            <div class="summary-card"><div class="label">${tr('reports.expenses')}</div><div class="amount negative">${fmtCurrency(totals.out)}</div></div>
            <div class="summary-card"><div class="label">${tr('reports.balance')}</div><div class="amount ${balance >= 0 ? 'positive' : 'negative'}">${fmtCurrency(Math.abs(balance))}</div></div>
          </div>

          <div class="report-section">
            <h3 class="report-section-title">${tr('reports.topCategories')}</h3>
            <div id="overviewCats">${cats.length ? cats.map((c) => _catRowMarkup(c.catId, c.amount, maxCat, { drillDown: true })).join('') : _emptyState(tr('reports.noExpenses'))}</div>
          </div>

          <div class="report-section">
            <h3 class="report-section-title">${tr('reports.topTags')}</h3>
            <div id="overviewTags">${tags.length ? tags.map((t2) => _tagRowMarkup(t2.name, t2.amount, maxTag, { drillDown: true })).join('') : _emptyState(tr('reports.noTaggedExpenses'))}</div>
          </div>

          <div class="report-section">
            <h3 class="report-section-title">${tr('reports.top')}</h3>
            <div id="overviewTop">${topTx.length ? topTx.map(_txRowMarkup).join('') : _emptyState(tr('reports.noExpenses'))}</div>
          </div>

        `;
}

// ── REPORTS — MONTH ───────────────────────────────────────────────────────────

function renderReportMonth(body, txs) {
  const a = appState.reports.range.anchor;
  const days = _daysInMonth(a.y, a.m);
  const labels = Array.from({ length: days }, (_, i) => i + 1);
  const byDay = {};
  txs.forEach((t) => {
    const d = new Date(t.date).getDate();
    if (!byDay[d]) byDay[d] = { out: 0, in: 0 };
    byDay[d][t.type] += t.amount;
  });
  const outData = labels.map((d) => byDay[d]?.out || 0);
  const inData = labels.map((d) => byDay[d]?.in || 0);
  const totals = _sumByType(txs);

  body.innerHTML = `
          <div class="report-section">
            <div class="report-canvas-wrap"><canvas id="monthChart" role="img" aria-labelledby="reportTitle" aria-describedby="monthChartSummary"></canvas></div>
            <p id="monthChartSummary" class="visually-hidden" aria-live="polite">${tr('reports.monthSummary', { month: appState.calendar.months[a.m], year: a.y, income: fmtCurrency(totals.in), expenses: fmtCurrency(totals.out) })}</p>
          </div>
          <div class="report-kpis">
            <div class="summary-card"><div class="label">${tr('reports.income')}</div><div class="amount positive">${fmtCurrency(totals.in)}</div></div>
            <div class="summary-card"><div class="label">${tr('reports.expenses')}</div><div class="amount negative">${fmtCurrency(totals.out)}</div></div>
            <div class="summary-card"><div class="label">${tr('reports.balance')}</div><div class="amount ${totals.in - totals.out >= 0 ? 'positive' : 'negative'}">${fmtCurrency(Math.abs(totals.in - totals.out))}</div></div>
          </div>
        `;

  const c = getChartColors();
  chartInsts.month = new Chart(document.getElementById('monthChart'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: tr('reports.expenses'),
          data: outData,
          backgroundColor: cssColor('--accent', 0.7),
          borderRadius: 4,
          borderSkipped: false,
        },
        {
          label: tr('reports.income'),
          data: inData,
          backgroundColor: cssColor('--green', 0.7),
          borderRadius: 4,
          borderSkipped: false,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: c.text, font: { family: 'DM Sans', size: 11 } } } },
      scales: {
        x: { ticks: { color: c.text, font: { size: 10 } }, grid: { color: c.grid } },
        y: {
          ticks: { color: c.text, font: { size: 10 }, callback: (v) => fmtCurrency(v) },
          grid: { color: c.grid },
        },
      },
    },
  });
}

// ── REPORTS — YEAR ────────────────────────────────────────────────────────────

async function renderReportYear(body, txs) {
  const a = appState.reports.range.anchor;
  const aggregate = (pool) =>
    Array.from({ length: 12 }, (_, m) => {
      const tx = pool.filter((t) => new Date(t.date).getMonth() === m);
      return {
        out: tx.filter((t) => t.type === 'out').reduce((s, t) => s + t.amount, 0),
        in: tx.filter((t) => t.type === 'in').reduce((s, t) => s + t.amount, 0),
      };
    });
  const monthly = aggregate(txs);
  const prevTxs = await _loadYearTxs(a.y - 1);
  const hasPrev = prevTxs.length > 0;
  const prevMonthly = hasPrev ? aggregate(prevTxs) : null;
  const totals = _sumByType(txs);

  body.innerHTML = `
          <div class="report-section">
            <div class="report-canvas-wrap"><canvas id="yearChart" role="img" aria-labelledby="reportTitle" aria-describedby="yearChartSummary"></canvas></div>
            <p id="yearChartSummary" class="visually-hidden" aria-live="polite">${tr('reports.yearSummary', { year: a.y, income: fmtCurrency(totals.in), expenses: fmtCurrency(totals.out) })}</p>
          </div>
          <div class="report-kpis">
            <div class="summary-card"><div class="label">${tr('reports.income')}</div><div class="amount positive">${fmtCurrency(totals.in)}</div></div>
            <div class="summary-card"><div class="label">${tr('reports.expenses')}</div><div class="amount negative">${fmtCurrency(totals.out)}</div></div>
            <div class="summary-card"><div class="label">${tr('reports.balance')}</div><div class="amount ${totals.in - totals.out >= 0 ? 'positive' : 'negative'}">${fmtCurrency(Math.abs(totals.in - totals.out))}</div></div>
          </div>
        `;

  const c = getChartColors();
  const datasets = [
    {
      label: tr('reports.expensesYear', { year: a.y }),
      data: monthly.map((m) => m.out),
      borderColor: cssColor('--accent'),
      backgroundColor: cssColor('--accent', 0.1),
      tension: 0.4,
      fill: true,
      pointRadius: 3,
    },
    {
      label: tr('reports.incomeYear', { year: a.y }),
      data: monthly.map((m) => m.in),
      borderColor: cssColor('--green'),
      backgroundColor: cssColor('--green', 0.1),
      tension: 0.4,
      fill: true,
      pointRadius: 3,
    },
  ];
  if (prevMonthly) {
    datasets.push({
      label: tr('reports.expensesYear', { year: a.y - 1 }),
      data: prevMonthly.map((m) => m.out),
      borderColor: cssColor('--accent', 0.5),
      borderDash: [5, 4],
      backgroundColor: 'transparent',
      tension: 0.4,
      fill: false,
      pointRadius: 0,
    });
  }
  chartInsts.year = new Chart(document.getElementById('yearChart'), {
    type: 'line',
    data: { labels: appState.calendar.monthsShort, datasets },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: c.text, font: { family: 'DM Sans', size: 11 } } } },
      scales: {
        x: { ticks: { color: c.text, font: { size: 10 } }, grid: { color: c.grid } },
        y: {
          ticks: { color: c.text, font: { size: 10 }, callback: (v) => fmtCurrency(v) },
          grid: { color: c.grid },
        },
      },
    },
  });
}

// ── REPORTS — CATEGORIES ──────────────────────────────────────────────────────

function renderReportCategories(body, txs) {
  const sorted = _totalsByCategory(txs, 'out');
  if (!sorted.length) {
    body.innerHTML = _emptyState(tr('reports.noExpenses'));
    return;
  }
  const total = sorted.reduce((s, c) => s + c.amount, 0);
  const max = sorted[0].amount;

  body.innerHTML = `
          <div class="report-section">
            <div class="donut-wrap">
              <canvas id="categoriesDonut" role="img" aria-label="${_escAttr(tr('reports.expensesPerCategory'))}"></canvas>
              <div class="donut-center">
                <div class="donut-center-value">${fmtCurrency(total)}</div>
                <div class="donut-center-label">${tr('reports.expensesTotal')}</div>
              </div>
            </div>
          </div>
          <div class="report-section">
            ${sorted.map((c) => _catRowMarkup(c.catId, c.amount, max, { drillDown: true })).join('')}
          </div>
        `;

  chartInsts.categories = new Chart(document.getElementById('categoriesDonut'), {
    type: 'doughnut',
    data: {
      labels: sorted.map((c) => getCatById(c.catId)?.name || ''),
      datasets: [
        {
          data: sorted.map((c) => c.amount),
          backgroundColor: sorted.map((c) => getCatById(c.catId)?.color || cssColor('--accent')),
          borderWidth: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      cutout: '64%',
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${fmtCurrency(ctx.parsed)}` } },
      },
    },
  });
}

async function drillDownCategory(catId, fromIso, toIso) {
  appState.reports.searchExitTarget = 'charts';
  appState.nav.categoryFilterId = catId;
  const from = fromIso || appState.reports.range.from;
  const to = toIso || appState.reports.range.to;
  appState.ledger.all = await loadRangeTxs(from, to);
  document.body.classList.add('searching');
  await _setSearchPanelActive(true);
  applySearch();
}

// ── REPORTS — TAGS ────────────────────────────────────────────────────────────

// Stable hue per tag — same name always maps to the same color. Avoids
// a per-tag color setting while keeping the donut visually distinct.
function _tagColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  }
  return `hsl(${Math.abs(h) % 360}deg 58% 52%)`;
}

// Sum amounts per tag for the given type. A transaction with multiple
// tags contributes its full amount to each tag (tags are categorical
// labels, not splits) — mirrors how Top-Kategorien aggregates.
function _totalsByTag(txs, type = 'out') {
  const totals = {};
  for (const t of txs) {
    if (t.type !== type) continue;
    if (!Array.isArray(t.tags) || !t.tags.length) continue;
    for (const tag of t.tags) {
      totals[tag] = (totals[tag] || 0) + t.amount;
    }
  }
  return Object.entries(totals)
    .map(([name, amount]) => ({ name, amount }))
    .sort((a, b) => b.amount - a.amount);
}

// _escAttr() and _escText() live in utils.js (loaded before this file).

function _tagRowMarkup(name, amount, max, opts = {}) {
  const color = _tagColor(name);
  const pct = max > 0 ? (amount / max) * 100 : 0;
  const attrName = _escAttr(name);
  const drill = opts.drillDown ? `role="button" tabindex="0" data-tag-drill="${attrName}"` : '';
  return `<div class="cat-row" ${drill}>
          <div class="cat-icon" style="--cat-color:${color}">#</div>
          <div class="cat-info">
            <div class="cat-name">${_escText(name)}</div>
            <div class="cat-bar-wrap"><div class="cat-bar" style="width:${pct}%;background:${color}"></div></div>
          </div>
          <div class="cat-amount">${fmtCurrency(-Math.abs(amount))}</div>
        </div>`;
}

function renderReportTags(body, txs) {
  const sorted = _totalsByTag(txs, 'out');
  if (!sorted.length) {
    body.innerHTML = _emptyState(tr('reports.noTagExpenses'));
    return;
  }
  const total = sorted.reduce((s, t) => s + t.amount, 0);
  const max = sorted[0].amount;

  body.innerHTML = `
          <div class="report-section">
            <div class="donut-wrap">
              <canvas id="tagsDonut" role="img" aria-label="${_escAttr(tr('reports.expensesPerTag'))}"></canvas>
              <div class="donut-center">
                <div class="donut-center-value">${fmtCurrency(total)}</div>
                <div class="donut-center-label">${tr('reports.expensesTotal')}</div>
              </div>
            </div>
          </div>
          <div class="report-section">
            ${sorted.map((t) => _tagRowMarkup(t.name, t.amount, max, { drillDown: true })).join('')}
          </div>
        `;

  chartInsts.tags = new Chart(document.getElementById('tagsDonut'), {
    type: 'doughnut',
    data: {
      labels: sorted.map((t) => t.name),
      datasets: [
        {
          data: sorted.map((t) => t.amount),
          backgroundColor: sorted.map((t) => _tagColor(t.name)),
          borderWidth: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      cutout: '64%',
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${fmtCurrency(ctx.parsed)}` } },
      },
    },
  });

  body.querySelectorAll('[data-tag-drill]').forEach((el) => {
    const name = el.dataset.tagDrill;
    el.addEventListener('click', () => drillDownTag(name));
    el.addEventListener('keydown', (ev) => handleRowActivate(ev, () => drillDownTag(name)));
  });
}

async function drillDownTag(name, fromIso, toIso) {
  appState.reports.searchExitTarget = 'charts';
  appState.nav.tagFilterName = name;
  const from = fromIso || appState.reports.range.from;
  const to = toIso || appState.reports.range.to;
  appState.ledger.all = await loadRangeTxs(from, to);
  document.body.classList.add('searching');
  await _setSearchPanelActive(true);
  applySearch();
}

// ── REPORTS — TREND ───────────────────────────────────────────────────────────

function _persistTrendState() {
  try {
    localStorage.setItem(
      TREND_STORAGE_KEY,
      JSON.stringify({ kind: appState.trend.kind, selection: appState.trend.selection }),
    );
  } catch (e) {}
}

function _persistTrendRange() {
  try {
    localStorage.setItem(
      TREND_RANGE_KEY,
      JSON.stringify({ yearFrom: appState.trend.yearFrom, yearTo: appState.trend.yearTo }),
    );
  } catch (e) {}
}

async function _findEarliestTxDate() {
  if (appState.trend.earliestTxDate) return appState.trend.earliestTxDate;
  const today = new Date();
  let year = today.getFullYear();
  let earliest = null;
  let consecutiveEmpty = 0;
  const floor = year - 20;
  while (consecutiveEmpty < 2 && year >= floor) {
    const yearTxs = await _loadYearTxs(year);
    if (!yearTxs.length) {
      consecutiveEmpty++;
    } else {
      consecutiveEmpty = 0;
      for (const t of yearTxs) {
        if (!earliest || t.date < earliest) earliest = t.date;
      }
    }
    year--;
  }
  if (!earliest) {
    // Noch keine Buchung — default ein Jahr zurück, damit der Picker eine sinnvolle Range zeigt.
    const fallback = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate());
    earliest = _iso(fallback.getFullYear(), fallback.getMonth(), fallback.getDate());
  }
  appState.trend.earliestTxDate = earliest;
  return earliest;
}

async function _ensureTrendDefaultRange() {
  // appState.trend.earliestTxDate immer auflösen — der Jahres-Picker im Render
  // braucht minYear, auch wenn die Range aus localStorage kommt.
  const earliest = await _findEarliestTxDate();
  if (appState.trend.yearFrom && appState.trend.yearTo) return;
  const today = new Date();
  appState.trend.yearFrom = parseInt(earliest.slice(0, 4), 10);
  appState.trend.yearTo = today.getFullYear();
  _persistTrendRange();
}

function _monthSpan(fromIso, toIso) {
  const fy = parseInt(fromIso.slice(0, 4), 10);
  const fm = parseInt(fromIso.slice(5, 7), 10);
  const ty = parseInt(toIso.slice(0, 4), 10);
  const tm = parseInt(toIso.slice(5, 7), 10);
  return (ty - fy) * 12 + (tm - fm) + 1;
}

function _autoGranularity(fromIso, toIso) {
  const months = _monthSpan(fromIso, toIso);
  if (months < 24) return 'month';
  if (months <= 60) return 'quarter';
  return 'year';
}

// Trend math (_bucketKey, _bucketAxis, _movingAverage, _tagLineColor,
// _trendMatchesEntity, _monthlyTotals, _trendStats) lives in reportsData.js
// (loaded before this file). The impure trend helpers that remain below —
// _bucketLabel, _trendEntityFromId, _pickDefaultTrendEntity, _trendSeries —
// read app globals (appState.calendar.monthsShort, categories) and so stay here.

function _bucketLabel(key, granularity) {
  if (granularity === 'year') return key;
  if (granularity === 'quarter') {
    const [y, q] = key.split('-');
    return `${q} ${y}`;
  }
  const [y, m] = key.split('-');
  return `${appState.calendar.monthsShort[parseInt(m, 10) - 1]} ${y.slice(2)}`;
}

function _trendEntityFromId(id) {
  if (!id) return null;
  if (id.startsWith('cat:')) {
    const catId = parseInt(id.slice(4), 10);
    const cat = appState.ledger.categories.find((c) => c.id === catId);
    if (!cat) return null;
    return { kind: 'category', id, catId, name: cat.name, color: cat.color };
  }
  if (id.startsWith('tag:')) {
    const name = id.slice(4);
    return { kind: 'tag', id, name, color: _tagLineColor(name) };
  }
  return null;
}

function _pickDefaultTrendEntity(txs, kind) {
  if (kind === 'category') {
    for (const r of _totalsByCategory(txs, 'out')) {
      if (appState.ledger.categories.find((c) => c.id === r.catId)) return `cat:${r.catId}`;
    }
  } else {
    const top = _totalsByTag(txs, 'out')[0];
    if (top) return `tag:${top.name}`;
  }
  return null;
}

function _trendSeries(txs, entityId, granularity, bucketKeys) {
  const entity = _trendEntityFromId(entityId);
  if (!entity) return null;
  const sums = new Map(bucketKeys.map((k) => [k, 0]));
  for (const t of txs) {
    if (!_trendMatchesEntity(t, entity)) continue;
    const key = _bucketKey(t.date, granularity);
    if (sums.has(key)) sums.set(key, sums.get(key) + t.amount);
  }
  return {
    entity,
    label: entity.kind === 'tag' ? `#${entity.name}` : entity.name,
    color: entity.color,
    data: bucketKeys.map((k) => sums.get(k) || 0),
  };
}

function _trendPeakLabel(key) {
  const [y, m] = key.split('-');
  return `${appState.calendar.months[parseInt(m, 10) - 1]} ${y}`;
}

function _trendChipMarkup(id, name, color, selected) {
  const sel = selected ? 'is-selected' : '';
  return `<button type="button" class="trend-chip ${sel}" data-trend-id="${_escAttr(id)}">
          <span class="dot" style="background:${color}"></span>${_escText(name)}
        </button>`;
}

function _trendPickerOptions(txs, kind, selectedId, filter) {
  const options = [];
  if (kind === 'category') {
    const ranked = _totalsByCategory(txs, 'out');
    const seen = new Set();
    for (const r of ranked) {
      const cat = appState.ledger.categories.find((c) => c.id === r.catId);
      if (!cat) continue;
      seen.add(r.catId);
      options.push({ id: `cat:${r.catId}`, label: cat.name, color: cat.color });
    }
    const rest = appState.ledger.categories
      .filter((c) => !seen.has(c.id))
      .sort((a, b) => a.name.localeCompare(b.name, _locale()));
    for (const c of rest) {
      options.push({ id: `cat:${c.id}`, label: c.name, color: c.color });
    }
  } else {
    for (const r of _totalsByTag(txs, 'out')) {
      options.push({ id: `tag:${r.name}`, label: `#${r.name}`, color: _tagLineColor(r.name) });
    }
  }
  // Mit Suchquery: alle Treffer aus dem vollen Set, kein Top-N-Cap.
  const q = (filter || '').trim().toLowerCase();
  if (q) {
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }
  // Ohne Query: Top 10 nach Summe. Wenn die aktive Auswahl außerhalb
  // der Top 10 liegt, den letzten Slot durch sie ersetzen — sonst wäre
  // die im active-row sichtbare Auswahl im aufgeklappten Picker nicht zu sehen.
  const TOP_N = 10;
  const limited = options.slice(0, TOP_N);
  if (selectedId && !limited.some((o) => o.id === selectedId)) {
    const selectedOpt = options.find((o) => o.id === selectedId);
    if (selectedOpt) {
      limited.pop();
      limited.push(selectedOpt);
    }
  }
  return limited;
}

function _trendStatsMarkup(stats) {
  if (!stats || stats.monthCount === 0) return '';
  const meanCard = `<div class="stat-card">
          <div class="trend-stat-label">${tr('reports.trendMean')}</div>
          <div class="trend-stat-value">${fmtCurrency(stats.mean)}</div>
          <div class="trend-stat-sub">${tr('reports.perMonth')}</div>
        </div>`;
  const peakCard =
    stats.peak && stats.peak.value > 0
      ? `<div class="stat-card">
              <div class="trend-stat-label">${tr('reports.trendPeak')}</div>
              <div class="trend-stat-value">${fmtCurrency(stats.peak.value)}</div>
              <div class="trend-stat-sub">${_trendPeakLabel(stats.peak.key)}</div>
            </div>`
      : '';
  const yoyCard =
    stats.yoy && stats.yoy.pct !== null
      ? `<div class="stat-card wide">
              <div class="trend-stat-label">${tr('reports.trendYoy')}</div>
              <div class="trend-stat-value">${stats.yoy.firstYear} → ${stats.yoy.lastYear}
                <span class="trend-stat-delta">${stats.yoy.pct >= 0 ? '+' : ''}${stats.yoy.pct.toFixed(0)} %</span>
              </div>
              <div class="trend-stat-sub">${tr('forecast.perMonth', { from: fmtCurrency(stats.yoy.firstMean), to: fmtCurrency(stats.yoy.lastMean) })}</div>
            </div>`
      : '';
  return `<div class="trend-stats">${meanCard}${peakCard}${yoyCard}</div>`;
}

function setTrendKind(kind) {
  if (kind !== 'category' && kind !== 'tag') return;
  if (appState.trend.kind === kind) return;
  appState.trend.kind = kind;
  appState.trend.selection = [];
  appState.trend.pickerOpen = false;
  appState.trend.pickerFilter = '';
  _persistTrendState();
  renderReport();
}

function selectTrendEntity(id) {
  appState.trend.selection = [id];
  appState.trend.pickerOpen = false;
  appState.trend.pickerFilter = '';
  _persistTrendState();
  renderReport();
}

function toggleTrendPicker(open) {
  appState.trend.pickerOpen = open === undefined ? !appState.trend.pickerOpen : !!open;
  const activeRow = document.getElementById('trendActiveRow');
  const picker = document.getElementById('trendPickerOpen');
  if (activeRow) activeRow.hidden = appState.trend.pickerOpen;
  if (picker) picker.hidden = !appState.trend.pickerOpen;
  if (appState.trend.pickerOpen && picker) {
    const input = picker.querySelector('input');
    if (input) input.focus();
  }
}

function filterTrendChips(value) {
  appState.trend.pickerFilter = value;
  const container = document.getElementById('trendPickerChips');
  if (!container) return;
  const selectedId = appState.trend.selection[0] || null;
  const options = _trendPickerOptions(
    appState.reports.txPool || [],
    appState.trend.kind,
    selectedId,
    value,
  );
  container.innerHTML = options
    .map((o) => _trendChipMarkup(o.id, o.label, o.color, selectedId && o.id === selectedId))
    .join('');
  _bindTrendChipHandlers(container);
}

async function setTrendYear(field, value) {
  const today = new Date().getFullYear();
  const minYear = appState.trend.earliestTxDate
    ? parseInt(appState.trend.earliestTxDate.slice(0, 4), 10)
    : today - 20;
  value = Math.round(Math.max(minYear, Math.min(today, value)));
  if (field === 'from') {
    appState.trend.yearFrom = value;
    if (appState.trend.yearTo < appState.trend.yearFrom)
      appState.trend.yearTo = appState.trend.yearFrom;
  } else {
    appState.trend.yearTo = value;
    if (appState.trend.yearFrom > appState.trend.yearTo)
      appState.trend.yearFrom = appState.trend.yearTo;
  }
  _persistTrendRange();
  await renderReport('trend');
}

async function renderReportTrend(body, txs) {
  // Beim ersten Öffnen oder nach Kategorie-Löschung: Selection neu setzen
  let selected = appState.trend.selection[0]
    ? _trendEntityFromId(appState.trend.selection[0])
    : null;
  if (selected && selected.kind !== appState.trend.kind) selected = null;
  if (!selected) {
    const def = _pickDefaultTrendEntity(txs, appState.trend.kind);
    if (def) {
      appState.trend.selection = [def];
      _persistTrendState();
      selected = _trendEntityFromId(def);
    } else {
      appState.trend.selection = [];
    }
  }

  const today = new Date().getFullYear();
  const minYear = appState.trend.earliestTxDate
    ? parseInt(appState.trend.earliestTxDate.slice(0, 4), 10)
    : today - 20;
  const yearOptions = (selectedYear) => {
    let html = '';
    for (let y = minYear; y <= today; y++) {
      html += `<option value="${y}"${y === selectedYear ? ' selected' : ''}>${y}</option>`;
    }
    return html;
  };

  const yearPickerMarkup = `<div class="range-custom trend-year-picker">
            <label class="range-custom-field">
              <span>${tr('reports.rangeFrom')}</span>
              <select aria-label="${_escAttr(tr('reports.fromYear'))}" onchange="setTrendYear('from', +this.value)">${yearOptions(appState.trend.yearFrom || today)}</select>
            </label>
            <label class="range-custom-field">
              <span>${tr('reports.rangeTo')}</span>
              <select aria-label="${_escAttr(tr('reports.toYear'))}" onchange="setTrendYear('to', +this.value)">${yearOptions(appState.trend.yearTo || today)}</select>
            </label>
          </div>`;

  const options = _trendPickerOptions(
    txs,
    appState.trend.kind,
    selected && selected.id,
    appState.trend.pickerFilter,
  );
  const chipsMarkup = options
    .map((o) => _trendChipMarkup(o.id, o.label, o.color, selected && o.id === selected.id))
    .join('');
  const searchPlaceholder =
    appState.trend.kind === 'category' ? tr('reports.searchCategory') : tr('reports.searchTag');

  const segmentedMarkup = `<div class="segmented" role="tablist" aria-label="${_escAttr(tr('reports.trendSelect'))}">
            <button type="button" role="tab" aria-selected="${appState.trend.kind === 'category'}" class="${appState.trend.kind === 'category' ? 'is-active' : ''}" onclick="setTrendKind('category')">${tr('reports.kindCategories')}</button>
            <button type="button" role="tab" aria-selected="${appState.trend.kind === 'tag'}" class="${appState.trend.kind === 'tag' ? 'is-active' : ''}" onclick="setTrendKind('tag')">${tr('reports.kindTags')}</button>
          </div>`;

  const activeMarkup = selected
    ? `<div class="trend-active-row" id="trendActiveRow"${appState.trend.pickerOpen ? ' hidden' : ''}>
              <div class="trend-active-info">
                <span class="trend-active-dot" style="background:${selected.color}"></span>
                <div class="trend-active-text">
                  <div class="trend-active-label">${_escText(selected.kind === 'tag' ? `#${selected.name}` : selected.name)}</div>
                  <span class="trend-active-sub">${tr('reports.largestItem')}</span>
                </div>
              </div>
              <button type="button" class="trend-switch-btn" onclick="toggleTrendPicker(true)">${tr('reports.switch')}</button>
            </div>`
    : '';

  const pickerOpenMarkup = `<div class="trend-picker-open" id="trendPickerOpen"${appState.trend.pickerOpen || !selected ? '' : ' hidden'}>
            <div class="search-wrap">
              <svg class="ui-icon" aria-hidden="true"><use href="#icon-search" /></svg>
              <input type="search" placeholder="${searchPlaceholder}" value="${_escAttr(appState.trend.pickerFilter)}" oninput="filterTrendChips(this.value)" autocomplete="off" />
            </div>
            <div class="tag-picker-chips" id="trendPickerChips">${chipsMarkup}</div>
          </div>`;

  if (!selected) {
    body.innerHTML = `
            ${yearPickerMarkup}
            <div class="report-section">${segmentedMarkup}${pickerOpenMarkup}</div>
            <div class="report-section">${_emptyState(appState.trend.kind === 'category' ? tr('reports.noCategoriesInRange') : tr('reports.noTagsInRange'))}</div>
          `;
    _bindTrendChipHandlers(body);
    return;
  }

  // Granularität fix Monat — Legende skaliert über autoSkip/maxTicksLimit.
  // Bei toIso > heute auf den aktuellen Monat kappen, damit weder die
  // Chart-Linie auf null abstürzt noch der laufende Jahres-Mittelwert
  // durch zukünftige Nullmonate verwässert wird.
  const granularity = 'month';
  const todayDate = new Date();
  const todayIso = _iso(todayDate.getFullYear(), todayDate.getMonth(), todayDate.getDate());
  const trendFromIso = `${appState.trend.yearFrom}-01-01`;
  const trendToIso = `${appState.trend.yearTo}-12-31`;
  const effectiveTo = trendToIso > todayIso ? todayIso : trendToIso;
  const bucketKeys = _bucketAxis(trendFromIso, effectiveTo, granularity);
  const bucketLabels = bucketKeys.map((k) => _bucketLabel(k, granularity));
  const series = _trendSeries(txs, selected.id, granularity, bucketKeys);
  const monthlyMap = _monthlyTotals(txs, selected);
  const stats = _trendStats(monthlyMap, trendFromIso, effectiveTo);

  body.innerHTML = `
          ${yearPickerMarkup}
          <div class="report-section">${segmentedMarkup}${activeMarkup}${pickerOpenMarkup}</div>
          <div class="report-section">
            <div class="report-canvas-wrap"><canvas id="trendChart" role="img" aria-labelledby="reportTitle" aria-describedby="trendChartSummary"></canvas></div>
            <p id="trendChartSummary" class="visually-hidden" aria-live="polite">${tr('reports.trendSummary', { label: _escText(series.label), mean: fmtCurrency(stats?.mean || 0) })}</p>
          </div>
          ${_trendStatsMarkup(stats)}
        `;
  _bindTrendChipHandlers(body);

  const c = getChartColors();
  const datasets = [
    {
      label: series.label,
      data: series.data,
      borderColor: series.color,
      backgroundColor: 'transparent',
      tension: 0.25,
      pointRadius: 3,
      borderWidth: 2.5,
      fill: false,
    },
  ];
  // Glättungs-Fenster wächst mit dem Zeitraum, damit die zweite Linie
  // auch über mehrere Jahre noch glättet statt 1:1 auf der Rohlinie zu liegen.
  const maWindow = bucketKeys.length > 60 ? 12 : bucketKeys.length > 24 ? 6 : 3;
  if (bucketKeys.length >= maWindow * 2) {
    const smoothed = _movingAverage(series.data, maWindow);
    datasets.push({
      label: tr('reports.smoothing', { label: series.label }),
      data: smoothed,
      borderColor: series.color,
      borderDash: [4, 3],
      backgroundColor: 'transparent',
      tension: 0,
      pointRadius: 0,
      borderWidth: 1.5,
      fill: false,
    });
  }

  chartInsts.trend = new Chart(document.getElementById('trendChart'), {
    type: 'line',
    data: { labels: bucketLabels, datasets },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${fmtCurrency(ctx.parsed.y)}`,
          },
        },
      },
      scales: {
        x: {
          ticks: {
            color: c.text,
            font: { size: 10 },
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 12,
          },
          grid: { color: c.grid },
        },
        y: {
          ticks: { color: c.text, font: { size: 10 }, callback: (v) => fmtCurrency(v) },
          grid: { color: c.grid },
        },
      },
    },
  });
}

function _bindTrendChipHandlers(scope) {
  scope.querySelectorAll('[data-trend-id]').forEach((el) => {
    el.addEventListener('click', () => selectTrendEntity(el.dataset.trendId));
    el.addEventListener('keydown', (ev) =>
      handleRowActivate(ev, () => selectTrendEntity(el.dataset.trendId)),
    );
  });
}

// ── REPORTS — FORECAST ────────────────────────────────────────────────────────

async function renderReportForecast(body, rangeTxs) {
  const today = new Date();
  const todayY = today.getFullYear();
  const todayM = today.getMonth();
  const msDay = 86400000;

  // Historie: letzte 12 vollständige Monate vor dem aktuellen Monat.
  // Anker bewusst „heute", nicht der Zielmonat — so basiert die
  // Prognose auf den jüngsten echten Daten, auch wenn der User in
  // die Zukunft schaut.
  const histEndDate = new Date(todayY, todayM, 0);
  const histStartDate = new Date(todayY, todayM - 12, 1);
  const histStartIso = _iso(histStartDate.getFullYear(), histStartDate.getMonth(), 1);
  const histEndIso = _iso(histEndDate.getFullYear(), histEndDate.getMonth(), histEndDate.getDate());
  const histTxs = await loadRangeTxs(histStartIso, histEndIso);
  const histOut = histTxs.filter((t) => t.type === 'out');

  if (histOut.length === 0) {
    body.innerHTML = _emptyState(tr('forecast.notEnough'));
    return;
  }

  const histDays = Math.round((histEndDate - histStartDate) / msDay) + 1;
  const dailyAvg = histOut.reduce((s, t) => s + t.amount, 0) / histDays;

  // Gewählter Zeitraum aus dem Time-Picker.
  const rangeFromIso = appState.reports.range.from;
  const rangeToIso = appState.reports.range.to;
  const rangeFromDate = new Date(rangeFromIso + 'T00:00:00');
  const rangeToDate = new Date(rangeToIso + 'T00:00:00');
  const daysTotal = Math.round((rangeToDate - rangeFromDate) / msDay) + 1;
  const todayStartOfDay = new Date(todayY, todayM, today.getDate());
  let daysPassed;
  if (todayStartOfDay < rangeFromDate) {
    daysPassed = 0;
  } else if (todayStartOfDay >= rangeToDate) {
    daysPassed = daysTotal;
  } else {
    daysPassed = Math.round((todayStartOfDay - rangeFromDate) / msDay) + 1;
  }
  if (daysPassed > daysTotal) daysPassed = daysTotal;

  const rangeOut = (rangeTxs || []).filter((t) => t.type === 'out');
  const rangeSum = rangeOut.reduce((s, t) => s + t.amount, 0);

  // Prognose: vergangene Tage = Ist, restliche Tage = Tagesdurchschnitt.
  let projected;
  if (daysPassed === 0) {
    projected = dailyAvg * daysTotal;
  } else if (daysPassed >= daysTotal) {
    projected = rangeSum;
  } else {
    projected = rangeSum + dailyAvg * (daysTotal - daysPassed);
  }

  // Pro Kategorie: Ø skaliert auf Range-Länge, Status pace-bereinigt.
  const histByCat = {};
  for (const t of histOut) {
    histByCat[t.category_id] = (histByCat[t.category_id] || 0) + t.amount;
  }
  const curByCat = {};
  for (const t of rangeOut) {
    curByCat[t.category_id] = (curByCat[t.category_id] || 0) + t.amount;
  }
  const rows = Object.entries(histByCat)
    .map(([id, sum]) => ({
      catId: parseInt(id, 10),
      avg: (sum / histDays) * daysTotal,
      current: curByCat[id] || 0,
    }))
    .sort((a, b) => b.avg - a.avg);

  const statusFor = (cur, avg) => {
    if (avg <= 0 || daysPassed === 0) return { label: '', cls: '' };
    const pace = (cur / daysPassed) * daysTotal;
    const ratio = pace / avg;
    if (ratio < 0.9) return { label: tr('forecast.statusUnder'), cls: 'is-ok' };
    if (ratio < 1.1) return { label: tr('forecast.statusOn'), cls: 'is-neutral' };
    return { label: tr('forecast.statusOver'), cls: 'is-warn' };
  };

  // Labels skalieren mit Time-Picker-Kind.
  const kind = appState.reports.range.kind;
  const cardLabel =
    kind === 'month'
      ? tr('forecast.projMonth')
      : kind === 'quarter'
        ? tr('forecast.projQuarter')
        : kind === 'year'
          ? tr('forecast.projYear')
          : tr('forecast.proj');
  const avgColLabel =
    kind === 'month'
      ? tr('forecast.avgMonth')
      : kind === 'quarter'
        ? tr('forecast.avgQuarter')
        : kind === 'year'
          ? tr('forecast.avgYear')
          : tr('forecast.avgPeriod');
  const periodLabel =
    kind === 'custom'
      ? (() => {
          const fmt = (iso) => {
            const [y, m, d] = iso.split('-');
            return new Date(Number(y), Number(m) - 1, Number(d)).toLocaleDateString(_locale());
          };
          return `${fmt(rangeFromIso)} – ${fmt(rangeToIso)}`;
        })()
      : _rangeStepperLabel();

  body.innerHTML = `
          <div class="report-section">
            <div class="forecast-card">
              <div class="forecast-card-label">${cardLabel}</div>
              <div class="forecast-card-value">${fmtCurrency(projected)}</div>
              <div class="forecast-card-hint">${periodLabel} · ${tr('forecast.basis', { day: daysPassed, total: daysTotal })}</div>
            </div>
          </div>
          <div class="report-section">
            <h3 class="report-section-title">${tr('forecast.perCategory')}</h3>
            <table class="forecast-table">
              <thead><tr><th>${tr('forecast.colCategory')}</th><th class="num">${avgColLabel}</th><th class="num">${tr('forecast.colCurrent')}</th><th class="num">${tr('forecast.colStatus')}</th></tr></thead>
              <tbody>
                ${rows
                  .map((r) => {
                    const cat = getCatById(r.catId);
                    if (!cat) return '';
                    const s = statusFor(r.current, r.avg);
                    return `<tr class="is-clickable" role="button" tabindex="0"
                    onclick="drillDownCategory(${r.catId}, '${rangeFromIso}', '${rangeToIso}')"
                    onkeydown="handleRowActivate(event, () => drillDownCategory(${r.catId}, '${rangeFromIso}', '${rangeToIso}'))">
                    <td><span class="forecast-cat-name"><span class="forecast-cat-dot" style="background:${cat.color}"></span>${_escText(cat.name)}</span></td>
                    <td class="num">${fmtCurrency(r.avg)}</td>
                    <td class="num">${fmtCurrency(r.current)}</td>
                    <td class="num"><span class="forecast-status ${s.cls}">${s.label}</span></td>
                  </tr>`;
                  })
                  .join('')}
              </tbody>
            </table>
          </div>
        `;
}

// ── REPORTS — TOP EXPENSES ────────────────────────────────────────────────────

function renderReportTop(body, txs) {
  const top = txs
    .filter((t) => t.type === 'out')
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 10);
  if (!top.length) {
    body.innerHTML = _emptyState(tr('reports.noExpenses'));
    return;
  }
  body.innerHTML = `<div class="report-section">${top.map(_txRowMarkup).join('')}</div>`;
}

// ── MODAL ─────────────────────────────────────────────────────────────────────
function openModal(tx) {
  rememberModalFocus('booking');
  appState.form.tags = tx?.tags ? tx.tags.slice() : [];
  document.getElementById('inputAmount').value =
    tx?.amount != null ? _formatAmountInput(Number(tx.amount)) : '';
  document.getElementById('inputDesc').value = tx?.desc || '';
  document.getElementById('inputDate').value = tx?.date || new Date().toISOString().split('T')[0];
  const catSel = document.getElementById('inputCat');
  // Alphabetical de_DE sort — consistent with renderCategories()
  // and renderCategoryView() so the user sees the same order
  // wherever they look at categories.
  catSel.innerHTML = [...appState.ledger.categories]
    .sort((a, b) => a.name.localeCompare(b.name, _locale(), { sensitivity: 'base' }))
    .map((c) => `<option value="${c.id}">${_escText(c.name)}</option>`)
    .join('');
  if (tx) catSel.value = tx.category_id;
  setType(tx?.type || 'out', document.querySelector('.type-btn.out'));
  renderTagPills();
  renderTagSuggestions();
  document.querySelector('.modal h2').textContent = tx ? tr('tx.editTitle') : tr('tx.newTitle');
  // Amount label carries the active currency symbol; placeholder uses
  // the locale decimal separator.
  const lblAmount = document.getElementById('lblAmount');
  if (lblAmount)
    lblAmount.textContent = tr('tx.amount', { symbol: window.I18N ? I18N.currencySymbol() : '€' });
  document.getElementById('inputAmount').placeholder = _formatAmountInput(0);
  document.getElementById('deleteBtn').style.display = tx ? 'block' : 'none';
  document.getElementById('modalOverlay').classList.add('open');
  appState.nav.bookingModalOpenedAt = Date.now();
  document.body.style.overflow = 'hidden';
  setTimeout(() => document.getElementById('inputAmount').focus(), 300);
  document.getElementById('modalOverlay').dataset.editId = tx?.id || '';
  trapFocusIn(document.querySelector('#modalOverlay .modal'), 'booking');
}
function closeModal() {
  document.getElementById('modalOverlay').classList.remove('open');
  document.body.style.overflow = '';
  releaseFocusTrap('booking');
  restoreModalFocus('booking');
}
// Ledger rows open this modal on `pointerup` (the swipe handler).
// The browser then synthesizes a trailing `click` at the same spot,
// which now lands on the freshly shown overlay backdrop and would
// close the modal immediately (the "flicker, nothing happens, second
// tap works" bug). Ignore backdrop clicks for a brief window after
// opening so only a deliberate later tap dismisses it.
function closeModalOutside(e) {
  if (Date.now() - appState.nav.bookingModalOpenedAt < 400) return;
  if (e.target === document.getElementById('modalOverlay')) closeModal();
}
function editTransaction(id) {
  const num = Number(id);
  const pools = [appState.ledger.all, appState.reports.txPool, appState.ledger.transactions];
  for (const p of pools) {
    if (!p) continue;
    const t = p.find((t) => t.id === num);
    if (t) return openModal(t);
  }
  // Falls die TX in keinem Pool liegt (etwa weil sie gerade per Sync entfernt
  // wurde): kein stilles Öffnen der Neuanlage — Hinweis geben.
  toast(tr('tx.notFound'));
}

// Offline-delete fallback shared by the swipe-to-delete row and the edit
// modal: when offline, queue the DELETE in the outbox for the SW to replay
// and report that it was handled. Returns false when online (or no outbox),
// so the caller surfaces the original error instead.
async function _enqueueOfflineDelete(id) {
  if (!navigator.onLine || !window.PocketLogOutbox) return false;
  await window.PocketLogOutbox.enqueue({ method: 'DELETE', path: `/transactions/${id}` });
  return true;
}

async function deleteCurrentTransaction() {
  const editId = document.getElementById('modalOverlay').dataset.editId;
  if (!editId) return;
  if (!(await confirmAction({ title: tr('tx.deleteConfirm'), confirmLabel: tr('common.delete') })))
    return;
  try {
    await api('DELETE', `/transactions/${editId}`);
    closeModal();
    await loadAndRender();
  } catch (e) {
    if (await _enqueueOfflineDelete(editId)) {
      closeModal();
      updateSyncBadge();
      return;
    }
    toast(tr('tx.deleteFailed') + e.message, 'error');
  }
}

function setType(type, btn) {
  appState.form.type = type;
  document.querySelectorAll('.type-btn').forEach((b) => b.classList.remove('active'));
  document.querySelector('.type-btn.' + type).classList.add('active');
  document.getElementById('submitBtn').className = 'submit-btn' + (type === 'in' ? ' green' : '');
  document.getElementById('submitBtn').textContent =
    type === 'out' ? tr('tx.saveExpense') : tr('tx.saveIncome');
}

// The amount field is type="text" so iOS shows the decimal keypad.
// Parsing is locale-aware: in a comma-decimal locale (de) dots are
// thousands separators and the comma is the decimal point; in a
// dot-decimal locale (en) it's the reverse. We also strip currency
// symbols/spaces so a pasted "1.234,56 €" still parses.
function parseAmount(raw) {
  if (raw == null) return NaN;
  let s = String(raw)
    .trim()
    .replace(/[^\d.,-]/g, '');
  const sep = window.I18N ? I18N.decimalSeparator() : ',';
  if (sep === ',') {
    s = s.replace(/\./g, '').replace(',', '.');
  } else {
    s = s.replace(/,/g, '');
  }
  return parseFloat(s);
}

// Display the amount in the input with the locale decimal separator
// so it matches the formatted output everywhere else (fmtCurrency).
// No thousand separator — keeps round-tripping through parseAmount()
// lossless.
function _formatAmountInput(n) {
  const s = n.toFixed(2);
  const sep = window.I18N ? I18N.decimalSeparator() : ',';
  return sep === ',' ? s.replace('.', ',') : s;
}

function normalizeAmountInput() {
  const inp = document.getElementById('inputAmount');
  const n = parseAmount(inp.value);
  if (!isNaN(n)) inp.value = _formatAmountInput(n);
}

function removeTag(t) {
  appState.form.tags = appState.form.tags.filter((x) => x !== t);
  renderTagPills();
  renderTagSuggestions();
}
function renderTagPills() {
  const wrap = document.getElementById('tagsWrap');
  const btn = document.getElementById('tagPickerBtn');
  wrap.innerHTML = appState.form.tags
    .map(
      (t) =>
        `<span class="tag-pill">${_escText(t)}<button type="button" data-remove-tag="${_escAttr(t)}" aria-label="${_escAttr(tr('tags.removeAria', { name: t }))}">${ICON_SVG.close}</button></span>`,
    )
    .join('');
  wrap.querySelectorAll('[data-remove-tag]').forEach((el) => {
    el.addEventListener('click', () => removeTag(el.dataset.removeTag));
  });
  wrap.appendChild(btn);
}

async function addTransaction() {
  const amount = parseAmount(document.getElementById('inputAmount').value);
  const desc = document.getElementById('inputDesc').value.trim();
  const cat = parseInt(document.getElementById('inputCat').value);
  const date = document.getElementById('inputDate').value;
  if (!amount || !date) {
    toast(tr('tx.amountDateRequired'), 'error');
    return;
  }
  const body = {
    amount,
    desc,
    category_id: cat || null,
    date,
    type: appState.form.type,
    tags: appState.form.tags,
  };
  const editId = document.getElementById('modalOverlay').dataset.editId;
  const method = editId ? 'PUT' : 'POST';
  const path = editId ? `/transactions/${editId}` : '/transactions';
  try {
    await api(method, path, body);
    mergeIntoAvailableTags(appState.form.tags);
    closeModal();
    await Promise.all([loadAndRender(), loadTags()]);
  } catch (e) {
    if (!navigator.onLine && window.PocketLogOutbox) {
      await window.PocketLogOutbox.enqueue({ method, path, body });
      mergeIntoAvailableTags(appState.form.tags);
      closeModal();
      updateSyncBadge();
      return;
    }
    toast(tr('tx.saveFailed') + e.message, 'error');
  }
}

function mergeIntoAvailableTags(tags) {
  if (!Array.isArray(tags) || !tags.length) return;
  const lower = new Set(appState.ledger.availableTags.map((t) => t.toLowerCase()));
  let changed = false;
  for (const t of tags) {
    const v = (t || '').trim().toLowerCase();
    if (!v) continue;
    tagCounts.set(v, (tagCounts.get(v) || 0) + 1);
    if (!lower.has(v)) {
      appState.ledger.availableTags.push(v);
      lower.add(v);
      changed = true;
    }
  }
  if (changed) {
    appState.ledger.availableTags.sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' }),
    );
    renderTagList();
  }
}

// ── CATEGORIES ────────────────────────────────────────────────────────────────
const CAT_CREATE_COLORS = ['#D97757', '#6b7aa1', '#788C5D', '#c47ab0', '#e0a44a', '#87867F'];

async function loadCategories() {
  try {
    appState.ledger.categories = await api('GET', '/categories');
  } catch (e) {
    appState.ledger.categories = [];
  }
}

async function loadTags() {
  try {
    const tags = await api('GET', '/tags');
    const list = Array.isArray(tags) ? tags : [];
    appState.ledger.availableTags = list.map((t) => (typeof t === 'string' ? t : t.name));
    tagCounts.clear();
    for (const t of list) {
      if (typeof t === 'string') continue;
      tagCounts.set(t.name.toLowerCase(), Number(t.count) || 0);
    }
  } catch (e) {
    appState.ledger.availableTags = [];
    tagCounts.clear();
  }
  renderTagList();
}

function renderTagSuggestions() {
  const box = document.getElementById('tagSuggestions');
  if (!box) return;
  const selected = new Set(appState.form.tags.map((x) => x.toLowerCase()));
  const remaining = appState.ledger.availableTags.filter((t) => !selected.has(t.toLowerCase()));
  // Pick the 10 most-used (last 30 days), then render alphabetically
  // so users can scan the row without re-learning order each open.
  remaining.sort((a, b) => {
    const ca = tagCounts.get(a.toLowerCase()) || 0;
    const cb = tagCounts.get(b.toLowerCase()) || 0;
    if (cb !== ca) return cb - ca;
    return a.localeCompare(b, undefined, { sensitivity: 'base' });
  });
  const top = remaining.slice(0, 10);
  top.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  box.innerHTML = top
    .map(
      (t) =>
        `<button type="button" class="tag-suggestion" data-add-tag="${_escAttr(t)}">+ ${_escText(t)}</button>`,
    )
    .join('');
  box.querySelectorAll('[data-add-tag]').forEach((el) => {
    el.addEventListener('click', () => addTagFromSuggestion(el.dataset.addTag));
  });
}

function addTagFromSuggestion(t) {
  if (!t) return;
  const key = t.toLowerCase();
  if (!appState.form.tags.some((x) => x.toLowerCase() === key)) appState.form.tags.push(t);
  renderTagPills();
  renderTagSuggestions();
}

// ── TAG PICKER MODAL ──────────────────────────────────────────────────────────
// Tag-picker staging state lives in appState.tagPicker (state.js):
//   selection     — staged tags; apply to appState.form.tags only on „Fertig"
//   context       — which modal opened the picker: 'transaction' | 'recurring'
//   recurringTags — tags staged in the recurring rule editor

function renderRecurringTagPills() {
  const wrap = document.getElementById('recTagsWrap');
  const btn = document.getElementById('recTagPickerBtn');
  if (!wrap || !btn) return;
  wrap.innerHTML = appState.tagPicker.recurringTags
    .map(
      (t) =>
        `<span class="tag-pill">${_escText(t)}<button type="button" data-remove-rec-tag="${_escAttr(t)}" aria-label="${_escAttr(tr('tags.removeAria', { name: t }))}">${ICON_SVG.close}</button></span>`,
    )
    .join('');
  wrap.querySelectorAll('[data-remove-rec-tag]').forEach((el) => {
    el.addEventListener('click', () => removeRecurringTag(el.dataset.removeRecTag));
  });
  wrap.appendChild(btn);
}
function removeRecurringTag(t) {
  appState.tagPicker.recurringTags = appState.tagPicker.recurringTags.filter((x) => x !== t);
  renderRecurringTagPills();
}

function openTagPicker() {
  openTagPickerFor('transaction');
}
function openTagPickerFor(context) {
  appState.tagPicker.context = context;
  rememberModalFocus('tagPicker');
  appState.tagPicker.selection =
    context === 'recurring' ? [...appState.tagPicker.recurringTags] : [...appState.form.tags];
  document.getElementById('tagPickerFilter').value = '';
  document.getElementById('tagPickerNew').value = '';
  const chips = document.getElementById('tagPickerChips');
  chips.style.minHeight = '';
  renderTagPickerChips();
  document.getElementById('tagPickerOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
  // Lock chip-area height to the unfiltered render so the modal
  // doesn't snap shut while the user is narrowing the filter.
  requestAnimationFrame(() => {
    chips.style.minHeight = chips.offsetHeight + 'px';
  });
  trapFocusIn(document.querySelector('#tagPickerOverlay .modal'), 'tagPicker');
}
function closeTagPicker() {
  document.getElementById('tagPickerOverlay').classList.remove('open');
  document.getElementById('tagPickerChips').style.minHeight = '';
  // Keep scroll-lock if either parent modal is still open.
  const bookingOpen = document.getElementById('modalOverlay').classList.contains('open');
  const recurringOpen = document.getElementById('recurringModalOverlay').classList.contains('open');
  if (!bookingOpen && !recurringOpen) {
    document.body.style.overflow = '';
  }
  appState.tagPicker.selection = [];
  releaseFocusTrap('tagPicker');
  restoreModalFocus('tagPicker');
}
function closeTagPickerOutside(e) {
  if (e.target === document.getElementById('tagPickerOverlay')) closeTagPicker();
}
function commitTagPicker() {
  if (appState.tagPicker.context === 'recurring') {
    appState.tagPicker.recurringTags = [...appState.tagPicker.selection];
    closeTagPicker();
    renderRecurringTagPills();
  } else {
    appState.form.tags = [...appState.tagPicker.selection];
    closeTagPicker();
    renderTagPills();
    renderTagSuggestions();
  }
}
function renderTagPickerChips() {
  const box = document.getElementById('tagPickerChips');
  if (!box) return;
  const q = (document.getElementById('tagPickerFilter').value || '').trim().toLowerCase();
  const filtered = q
    ? appState.ledger.availableTags.filter((t) => t.toLowerCase().includes(q))
    : appState.ledger.availableTags;
  const selected = new Set(appState.tagPicker.selection.map((x) => x.toLowerCase()));
  box.innerHTML = filtered
    .map((t) => {
      const isSel = selected.has(t.toLowerCase());
      return `<button type="button" class="tag-picker-chip${isSel ? ' selected' : ''}" data-pick-tag="${_escAttr(t)}">${_escText(t)}</button>`;
    })
    .join('');
  box.querySelectorAll('[data-pick-tag]').forEach((el) => {
    el.addEventListener('click', () => togglePickerTag(el.dataset.pickTag));
  });
}
function togglePickerTag(t) {
  const i = appState.tagPicker.selection.findIndex((x) => x.toLowerCase() === t.toLowerCase());
  if (i >= 0) appState.tagPicker.selection.splice(i, 1);
  else appState.tagPicker.selection.push(t);
  renderTagPickerChips();
}
function handleTagPickerNew(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    addTagFromPicker();
  }
}
function addTagFromPicker() {
  const inp = document.getElementById('tagPickerNew');
  const val = inp.value.trim();
  if (!val) return;
  const key = val.toLowerCase();
  const existing = appState.ledger.availableTags.find((t) => t.toLowerCase() === key);
  const name = existing || val;
  if (!existing) {
    appState.ledger.availableTags.push(name);
    appState.ledger.availableTags.sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' }),
    );
  }
  if (!appState.tagPicker.selection.some((x) => x.toLowerCase() === key)) {
    appState.tagPicker.selection.push(name);
  }
  inp.value = '';
  renderTagPickerChips();
}

function renderCategories() {
  const box = document.getElementById('catList');
  if (!box) return;
  if (!appState.ledger.categories.length) {
    box.innerHTML = `<p class="empty-state-hint">${tr('categories.none')}</p>`;
    return;
  }
  const sorted = [...appState.ledger.categories].sort((a, b) =>
    a.name.localeCompare(b.name, _locale(), { sensitivity: 'base' }),
  );
  box.innerHTML = '';
  sorted.forEach((c) => {
    const row = document.createElement('div');
    row.className = 'drawer-nav-item cat-pill-edit';
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    row.setAttribute('aria-label', tr('categories.editAria', { name: c.name }));
    row.onclick = () => openCatModal(c.id);
    row.onkeydown = (e) => handleRowActivate(e, () => openCatModal(c.id));
    const iconWrap = document.createElement('div');
    iconWrap.className = 'drawer-nav-icon-wrap';
    iconWrap.style.setProperty('--nav-icon-bg', c.color);
    iconWrap.innerHTML = catIconSvg(c.icon);
    const label = document.createElement('span');
    label.className = 'drawer-nav-label';
    label.textContent = c.name;
    row.appendChild(iconWrap);
    row.appendChild(label);
    box.appendChild(row);
  });
}

const CAT_COLOR_PRESETS = [
  { hex: '#D97757', name: 'Terracotta' },
  { hex: '#6b7aa1', name: 'Blau' },
  { hex: '#788C5D', name: 'Olive' },
  { hex: '#c47ab0', name: 'Mauve' },
  { hex: '#e0a44a', name: 'Senf' },
  { hex: '#87867F', name: 'Grau' },
  { hex: '#B85C3E', name: 'Rost' },
  { hex: '#8a6a4a', name: 'Kakao' },
  { hex: '#a45ab0', name: 'Violett' },
  { hex: '#6a8a8a', name: 'Petrol' },
];

// Picker catalogue. IDs map 1:1 to <symbol id="cat-…"> entries in the
// Phosphor sprite (frontend/icons/categories/sprite.svg). Order inside
// a group is the order the picker renders.
const CAT_ICON_GROUPS = [
  {
    titleKey: 'catIcons.home',
    ids: [
      'house',
      'buildings',
      'door',
      'bed',
      'armchair',
      'couch',
      'chair',
      'television',
      'lightbulb',
      'fan',
      'oven',
      'plug',
      'key',
      'wrench',
      'hammer',
      'paint-brush',
      'broom',
      'fire',
    ],
  },
  {
    titleKey: 'catIcons.clothing',
    ids: [
      't-shirt',
      'dress',
      'hoodie',
      'pants',
      'sneaker',
      'eyeglasses',
      'watch',
      'backpack',
      'handbag',
      'baby',
      'coat-hanger',
      'washing-machine',
      'scissors',
      'shower',
      'drop',
      'toilet-paper',
    ],
  },
  {
    titleKey: 'catIcons.food',
    ids: [
      'shopping-cart',
      'basket',
      'bag',
      'bag-simple',
      'bread',
      'egg',
      'carrot',
      'fish',
      'orange',
      'avocado',
      'pepper',
      'hamburger',
      'pizza',
      'cookie',
      'cake',
      'ice-cream',
      'bowl-food',
      'bowl-steam',
      'coffee',
      'beer-stein',
      'wine',
      'martini',
      'fork-knife',
      'knife',
    ],
  },
  {
    titleKey: 'catIcons.mobility',
    ids: [
      'car',
      'taxi',
      'bus',
      'truck',
      'motorcycle',
      'scooter',
      'bicycle',
      'train',
      'train-regional',
      'airplane',
      'boat',
      'gas-pump',
      'map-pin',
      'road-horizon',
    ],
  },
  {
    titleKey: 'catIcons.leisure',
    ids: [
      'film-strip',
      'camera',
      'game-controller',
      'dice-five',
      'music-note',
      'guitar',
      'headphones',
      'microphone',
      'palette',
      'confetti',
      'book',
      'books',
      'gift',
      'ticket',
      'soccer-ball',
      'basketball',
      'tennis-ball',
      'tree-palm',
    ],
  },
  {
    titleKey: 'catIcons.health',
    ids: [
      'pill',
      'first-aid-kit',
      'bandaids',
      'heartbeat',
      'stethoscope',
      'syringe',
      'hospital',
      'brain',
      'virus',
      'mask-happy',
      'tooth',
      'dog',
      'cat',
    ],
  },
  {
    titleKey: 'catIcons.office',
    ids: [
      'briefcase',
      'graduation-cap',
      'chalkboard',
      'book-open',
      'pencil',
      'envelope',
      'calendar',
      'clipboard',
      'calculator',
      'laptop',
      'folder',
      'files',
      'magnifying-glass',
      'newspaper-clipping',
      'paperclip',
    ],
  },
  {
    titleKey: 'catIcons.finance',
    ids: [
      'wallet',
      'credit-card',
      'bank',
      'vault',
      'coins',
      'coin',
      'coin-vertical',
      'piggy-bank',
      'currency-eur',
      'currency-dollar',
      'hand-coins',
      'receipt',
      'invoice',
      'money',
      'trend-up',
      'trend-down',
      'chart-line',
      'percent',
    ],
  },
  {
    titleKey: 'catIcons.other',
    ids: [
      'package',
      'star',
      'heart',
      'sparkle',
      'magic-wand',
      'globe',
      'bell',
      'alarm',
      'sun',
      'moon',
      'cloud',
      'snowflake',
      'umbrella',
      'mountains',
      'tree',
      'plant',
      'leaf',
      'flower-tulip',
      'butterfly',
      'smiley',
      'anchor',
      'tag',
      'question',
    ],
  },
];
const CAT_ICON_FALLBACK = 'package';
const CAT_ICON_VALID = new Set(CAT_ICON_GROUPS.flatMap((g) => g.ids));

// Renders one sprite glyph. Unknown IDs (e.g. legacy emoji glyphs that
// somehow survived migration) gracefully fall back to the box icon
// rather than referencing a missing symbol.
function catIconSvg(id) {
  const safe = CAT_ICON_VALID.has(id) ? id : CAT_ICON_FALLBACK;
  return `<svg class="cat-glyph" aria-hidden="true"><use href="#cat-${safe}"/></svg>`;
}

// Fetch the sprite once at boot and inject it inline so document-local
// <use href="#cat-…"> references resolve everywhere (transaction rows,
// category breakdown, picker). The file is cache-first via the SW.
async function loadCategoryIconSprite() {
  if (document.getElementById('cat-icon-sprite')) return;
  try {
    const res = await fetch('/icons/categories/sprite.svg');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    // Strip the XML prolog if present — invalid as inline HTML.
    const cleaned = text.replace(/<\?xml[^?]*\?>/, '').trim();
    const host = document.createElement('div');
    host.id = 'cat-icon-sprite';
    host.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
    host.setAttribute('aria-hidden', 'true');
    host.innerHTML = cleaned;
    document.body.insertBefore(host, document.body.firstChild);
  } catch (e) {
    console.warn('Category icon sprite failed to load:', e);
  }
}

// Category create/edit modal draft lives in appState.catEdit (state.js);
// seed the icon default from CAT_ICON_FALLBACK (defined above).
appState.catEdit.icon = CAT_ICON_FALLBACK;

function openCatModal(id) {
  rememberModalFocus('cat');
  const deleteBtn = document.getElementById('catDeleteBtn');
  const title = document.getElementById('catModalTitle');
  if (id) {
    const c = appState.ledger.categories.find((x) => x.id === id);
    if (!c) return;
    appState.catEdit.id = c.id;
    appState.catEdit.color = c.color || '#9e9b96';
    appState.catEdit.icon = CAT_ICON_VALID.has(c.icon) ? c.icon : CAT_ICON_FALLBACK;
    document.getElementById('catEditName').value = c.name || '';
    title.textContent = tr('categories.editTitle');
    deleteBtn.style.display = '';
  } else {
    appState.catEdit.id = null;
    appState.catEdit.color =
      CAT_CREATE_COLORS[appState.ledger.categories.length % CAT_CREATE_COLORS.length];
    appState.catEdit.icon = CAT_ICON_FALLBACK;
    document.getElementById('catEditName').value = '';
    title.textContent = tr('categories.newTitle');
    deleteBtn.style.display = 'none';
  }
  renderCatColorSwatches();
  renderCatIconPreview();
  document.getElementById('catModalOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
  setTimeout(() => document.getElementById('catEditName').focus(), 200);
  trapFocusIn(document.querySelector('#catModalOverlay .modal'), 'cat');
}

function renderCatIconPreview() {
  const el = document.getElementById('catEditIconPreview');
  if (!el) return;
  el.style.color = appState.catEdit.color;
  el.innerHTML = catIconSvg(appState.catEdit.icon);
}

function renderCatColorSwatches() {
  const presets = [...CAT_COLOR_PRESETS];
  const hasCurrent = presets.some(
    (p) => p.hex.toLowerCase() === appState.catEdit.color.toLowerCase(),
  );
  if (!hasCurrent)
    presets.push({ hex: appState.catEdit.color, name: tr('categories.customColorName') });
  const box = document.getElementById('catEditColors');
  box.innerHTML =
    presets
      .map((p) => {
        const isActive = p.hex.toLowerCase() === appState.catEdit.color.toLowerCase();
        return `<button type="button" class="color-swatch${isActive ? ' active' : ''}" style="background:${p.hex}" aria-label="${_escAttr(tr('categories.pickColorAria', { name: p.name }))}" aria-pressed="${isActive}" onclick="pickCatColor('${p.hex}')"></button>`;
      })
      .join('') +
    `<label class="color-swatch-custom" title="${_escAttr(tr('categories.customColorName'))}">
     <input type="color" value="${appState.catEdit.color}" onchange="pickCatColor(this.value)" aria-label="${_escAttr(tr('categories.customColor'))}">
   </label>`;
}

function pickCatColor(c) {
  appState.catEdit.color = c;
  renderCatColorSwatches();
  renderCatIconPreview();
}

function closeCatModal() {
  document.getElementById('catModalOverlay').classList.remove('open');
  document.body.style.overflow = '';
  appState.catEdit.id = null;
  releaseFocusTrap('cat');
  restoreModalFocus('cat');
}
function closeCatModalOutside(e) {
  if (e.target === document.getElementById('catModalOverlay')) closeCatModal();
}

// ── ICON PICKER ───────────────────────────────────────────────────────────────
function openIconPicker() {
  rememberModalFocus('iconPicker');
  renderIconPicker();
  const overlay = document.getElementById('iconPickerOverlay');
  overlay.classList.add('open');
  // Body scroll-lock already set by the cat modal; keep it.
  // Always open scrolled to the top — the browser otherwise keeps
  // whatever scrollTop the modal-body had on the previous open.
  overlay.querySelector('.modal-body').scrollTop = 0;
  trapFocusIn(overlay.querySelector('.modal'), 'iconPicker');
}

function closeIconPicker() {
  document.getElementById('iconPickerOverlay').classList.remove('open');
  releaseFocusTrap('iconPicker');
  restoreModalFocus('iconPicker');
}

function closeIconPickerOutside(e) {
  if (e.target === document.getElementById('iconPickerOverlay')) closeIconPicker();
}

function renderIconPicker() {
  const host = document.getElementById('iconPickerSections');
  host.innerHTML = CAT_ICON_GROUPS.map((g) => {
    const cells = g.ids
      .map((id) => {
        const active = id === appState.catEdit.icon ? ' active' : '';
        const pressed = active ? 'true' : 'false';
        return `<button type="button" class="icon-picker-cell${active}"
              aria-pressed="${pressed}" aria-label="${id}"
              onclick="pickIcon('${id}')">${catIconSvg(id)}</button>`;
      })
      .join('');
    return `<section class="icon-picker-section">
            <h3 class="icon-picker-section-title">${tr(g.titleKey)}</h3>
            <div class="icon-picker-grid">${cells}</div>
          </section>`;
  }).join('');
}

function pickIcon(id) {
  appState.catEdit.icon = CAT_ICON_VALID.has(id) ? id : CAT_ICON_FALLBACK;
  renderCatIconPreview();
  closeIconPicker();
}

async function saveCategoryEdit() {
  const name = document.getElementById('catEditName').value.trim();
  const icon = CAT_ICON_VALID.has(appState.catEdit.icon)
    ? appState.catEdit.icon
    : CAT_ICON_FALLBACK;
  if (!name) {
    toast(tr('common.nameRequired'), 'error');
    return;
  }
  if (!/^#[0-9a-fA-F]{6}$/.test(appState.catEdit.color)) {
    toast(tr('categories.invalidColor'), 'error');
    return;
  }
  try {
    if (appState.catEdit.id) {
      await api('PUT', `/categories/${appState.catEdit.id}`, {
        name,
        icon,
        color: appState.catEdit.color,
      });
    } else {
      await api('POST', '/categories', { name, icon, color: appState.catEdit.color });
    }
    closeCatModal();
    await loadCategories();
    renderCategories();
    await loadAndRender();
  } catch (e) {
    if (e.message && e.message.includes('409')) {
      toast(tr('categories.exists'), 'error');
    } else {
      toast(tr('tx.saveFailed') + e.message, 'error');
    }
  }
}

async function deleteCategoryEdit() {
  if (!appState.catEdit.id) return;
  const ok = await confirmAction({
    title: tr('categories.deleteConfirm'),
    confirmLabel: tr('common.delete'),
  });
  if (!ok) return;
  try {
    await api('DELETE', `/categories/${appState.catEdit.id}`);
    closeCatModal();
    await loadCategories();
    renderCategories();
    await loadAndRender();
  } catch (e) {
    if (e && e.status === 409) {
      // Three distinct reasons land here; pick the right copy
      // so a user with a recurring rule isn't sent looking for
      // phantom transactions.
      if (e.detail && e.detail.includes('recurring')) {
        toast(tr('categories.deleteHasRecurring'), 'error');
      } else if (e.detail && e.detail.includes('goal')) {
        toast(tr('goals.categoryTaken'), 'error');
      } else {
        toast(tr('categories.deleteInUse'), 'error');
      }
    } else {
      toast(tr('tx.deleteFailed') + e.message, 'error');
    }
  }
}

// ── GOALS (Ziele: Sparziele + Schulden-Tracker) ───────────────────────────────
// A goal is a derived view: progress is computed from the linked
// category's transactions dated on/after start_date — the API stores
// no aggregate. 'save_up' counts `in`-type up to target; 'pay_down'
// counts `out`-type down from initial_amount toward target.
// Goals list + edit-modal draft live in appState.goals (state.js).

async function loadGoals() {
  try {
    appState.goals.list = await api('GET', '/goals');
  } catch (e) {
    appState.goals.list = [];
  }
}

// _goalProgress() lives in reportsData.js (loaded before this file).

async function renderGoalsView() {
  const el = document.getElementById('goalsViewList');
  if (!el) return;
  if (!appState.goals.list.length) {
    el.innerHTML = `<div class="empty-state"><svg class="cat-glyph goals-empty-glyph" aria-hidden="true"><use href="#cat-piggy-bank"/></svg><p>${tr('goals.emptyView')}<br>${tr('goals.emptyViewHint')}</p></div>`;
    return;
  }
  // Progress spans each goal's whole life, not the current month, so we
  // fetch one combined range from the earliest start_date to today and
  // compute every goal off that single pool.
  const minStart = appState.goals.list.reduce(
    (m, g) => (g.start_date < m ? g.start_date : m),
    appState.goals.list[0].start_date,
  );
  const now = new Date();
  const todayIso = _iso(now.getFullYear(), now.getMonth(), now.getDate());
  let pool = [];
  try {
    pool = await loadRangeTxs(minStart, todayIso);
  } catch (e) {
    pool = [];
  }
  const sorted = [...appState.goals.list].sort((a, b) =>
    a.name.localeCompare(b.name, _locale(), { sensitivity: 'base' }),
  );
  el.innerHTML = sorted
    .map((g) => {
      const p = _goalProgress(g, pool);
      const pctLabel = Math.round(p.rawPct) + '%';
      const stateClass = p.complete ? ' complete' : '';
      const dirClass = g.direction === 'pay_down' ? ' debt' : ' savings';
      let primaryHtml;
      if (g.direction === 'pay_down') {
        if (p.complete) {
          primaryHtml = _escText(tr('goals.completed'));
        } else if (p.targetCents > 0) {
          // Restziel set → show remaining debt AND the target floor.
          // Split into two non-breaking segments so "· Ziel € X" wraps
          // as a whole onto a second line when the row is too narrow
          // (iPhone portrait), instead of breaking mid-amount.
          const main = _escText(
            tr('goals.remaining', { amount: fmtCurrency(p.primaryCents / 100) }),
          );
          const target = _escText(
            tr('goals.targetSuffix', { target: fmtCurrency(p.targetCents / 100) }),
          );
          primaryHtml = `<span class="goal-primary-seg">${main}</span> <span class="goal-primary-seg goal-primary-target">${target}</span>`;
        } else {
          primaryHtml = _escText(
            tr('goals.remaining', { amount: fmtCurrency(p.primaryCents / 100) }),
          );
        }
      } else {
        primaryHtml = p.complete
          ? _escText(tr('goals.completed'))
          : _escText(
              tr('goals.savedOf', {
                current: fmtCurrency(p.primaryCents / 100),
                target: fmtCurrency(p.targetCents / 100),
              }),
            );
      }
      const progressWord =
        g.direction === 'pay_down'
          ? tr('goals.progressPaid', { pct: pctLabel })
          : tr('goals.progressSaved', { pct: pctLabel });
      return `<div class="goal-card${stateClass}${dirClass}" role="button" tabindex="0"
              aria-label="${_escAttr(tr('goals.editAria', { name: g.name }))}"
              onclick="openGoalModal(${g.id})"
              onkeydown="handleRowActivate(event, () => openGoalModal(${g.id}))">
              <div class="goal-card-head">
                <span class="goal-card-icon" style="--cat-color:${g.color}">${catIconSvg(g.icon)}</span>
                <span class="goal-card-name">${_escText(g.name)}</span>
              </div>
              <div class="goal-progress-track"><div class="goal-progress-fill" style="width:${p.pct}%"></div></div>
              <div class="goal-card-meta">
                <span class="goal-card-primary">${primaryHtml}</span>
                <span class="goal-card-sub">${_escText(progressWord)}</span>
              </div>
            </div>`;
    })
    .join('');
  // The debt "· Ziel € X" suffix is a non-breaking unit that drops to a
  // second line when the row is too narrow. Flag that wrapped state so the
  // CSS can hide the leading "·" (see _relayoutGoalTargets). Run after
  // layout, and again once web fonts settle (they change text width).
  requestAnimationFrame(_relayoutGoalTargets);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(_relayoutGoalTargets);
}

// Toggle `.is-wrapped` on each goal card's primary line depending on
// whether its "· Ziel € X" suffix sits on a second line. Hiding the
// separator only ever shortens that second line, so this can't feed back
// into the wrap decision (no oscillation). Timer in appState.nav.goalRelayoutTimer.
function _relayoutGoalTargets() {
  document.querySelectorAll('.goal-card-primary').forEach((primary) => {
    const target = primary.querySelector('.goal-primary-target');
    if (!target) return;
    const main = primary.querySelector('.goal-primary-seg:not(.goal-primary-target)');
    if (!main) return;
    primary.classList.toggle('is-wrapped', target.offsetTop > main.offsetTop);
  });
}

function _goalAmountValue(id) {
  return parseAmount(document.getElementById(id).value);
}

function populateGoalCategorySelect(selectedId) {
  const sel = document.getElementById('goalEditCategory');
  if (!sel) return;
  const sorted = [...appState.ledger.categories].sort((a, b) =>
    a.name.localeCompare(b.name, _locale(), { sensitivity: 'base' }),
  );
  // Fall back to the alphabetically first option when no valid category
  // is requested (e.g. creating a new goal), so the preselection matches
  // the top of the list rather than the unsorted seed order.
  const effectiveId = sorted.some((c) => c.id === selectedId)
    ? selectedId
    : sorted[0] && sorted[0].id;
  sel.innerHTML = sorted
    .map(
      (c) =>
        `<option value="${c.id}"${c.id === effectiveId ? ' selected' : ''}>${_escText(c.name)}</option>`,
    )
    .join('');
}

function onGoalDirectionChange() {
  const dir = document.getElementById('goalEditDirection').value;
  // Re-label the amount fields so the meaning is unambiguous per
  // direction (start debt vs. already saved; pay-off vs. save target).
  document.getElementById('goalInitialLabel').textContent =
    dir === 'pay_down' ? tr('goals.initialDebt') : tr('goals.initialSaved');
  document.getElementById('goalTargetLabel').textContent =
    dir === 'pay_down' ? tr('goals.targetRemaining') : tr('goals.targetAmount');
}

function renderGoalColorSwatches() {
  const presets = [...CAT_COLOR_PRESETS];
  const hasCurrent = presets.some(
    (p) => p.hex.toLowerCase() === appState.goals.editingColor.toLowerCase(),
  );
  if (!hasCurrent)
    presets.push({ hex: appState.goals.editingColor, name: tr('categories.customColorName') });
  const box = document.getElementById('goalEditColors');
  box.innerHTML =
    presets
      .map((p) => {
        const isActive = p.hex.toLowerCase() === appState.goals.editingColor.toLowerCase();
        return `<button type="button" class="color-swatch${isActive ? ' active' : ''}" style="background:${p.hex}" aria-label="${_escAttr(tr('categories.pickColorAria', { name: p.name }))}" aria-pressed="${isActive}" onclick="pickGoalColor('${p.hex}')"></button>`;
      })
      .join('') +
    `<label class="color-swatch-custom" title="${_escAttr(tr('categories.customColorName'))}">
     <input type="color" value="${appState.goals.editingColor}" onchange="pickGoalColor(this.value)" aria-label="${_escAttr(tr('categories.customColor'))}">
   </label>`;
}

function pickGoalColor(c) {
  appState.goals.editingColor = c;
  renderGoalColorSwatches();
}

function openGoalModal(id) {
  if (!appState.ledger.categories.length) {
    toast(tr('goals.needCategory'), 'error');
    return;
  }
  rememberModalFocus('goal');
  const deleteBtn = document.getElementById('goalDeleteBtn');
  const title = document.getElementById('goalModalTitle');
  if (id) {
    const g = appState.goals.list.find((x) => x.id === id);
    if (!g) return;
    appState.goals.editingId = g.id;
    appState.goals.editingColor = g.color || '#9e9b96';
    document.getElementById('goalEditName').value = g.name || '';
    document.getElementById('goalEditDirection').value = g.direction;
    populateGoalCategorySelect(g.category_id);
    document.getElementById('goalEditInitial').value = _formatAmountInput(Number(g.initial_amount));
    document.getElementById('goalEditTarget').value = _formatAmountInput(Number(g.target_amount));
    document.getElementById('goalEditStartDate').value = g.start_date;
    title.textContent = tr('goals.editTitle');
    deleteBtn.style.display = '';
  } else {
    appState.goals.editingId = null;
    appState.goals.editingColor =
      CAT_CREATE_COLORS[appState.goals.list.length % CAT_CREATE_COLORS.length];
    document.getElementById('goalEditName').value = '';
    document.getElementById('goalEditDirection').value = 'save_up';
    populateGoalCategorySelect(null); // defaults to the first sorted option
    document.getElementById('goalEditInitial').value = '';
    document.getElementById('goalEditTarget').value = '';
    const now = new Date();
    document.getElementById('goalEditStartDate').value = _iso(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    );
    title.textContent = tr('goals.newTitle');
    deleteBtn.style.display = 'none';
  }
  onGoalDirectionChange();
  renderGoalColorSwatches();
  document.getElementById('goalModalOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
  setTimeout(() => document.getElementById('goalEditName').focus(), 200);
  trapFocusIn(document.querySelector('#goalModalOverlay .modal'), 'goal');
}

function closeGoalModal() {
  document.getElementById('goalModalOverlay').classList.remove('open');
  document.body.style.overflow = '';
  appState.goals.editingId = null;
  releaseFocusTrap('goal');
  restoreModalFocus('goal');
}
function closeGoalModalOutside(e) {
  if (e.target === document.getElementById('goalModalOverlay')) closeGoalModal();
}

async function saveGoalEdit() {
  const name = document.getElementById('goalEditName').value.trim();
  const direction = document.getElementById('goalEditDirection').value;
  const categoryId = parseInt(document.getElementById('goalEditCategory').value, 10);
  const initial = _goalAmountValue('goalEditInitial');
  const target = _goalAmountValue('goalEditTarget');
  const startDate = document.getElementById('goalEditStartDate').value;
  if (!name) {
    toast(tr('common.nameRequired'), 'error');
    return;
  }
  if (!Number.isInteger(categoryId)) {
    toast(tr('goals.needCategory'), 'error');
    return;
  }
  if (Number.isNaN(initial) || Number.isNaN(target) || !startDate) {
    toast(tr('goals.invalidAmounts'), 'error');
    return;
  }
  // Mirror the backend cross-field rules so the user gets an inline
  // hint instead of a raw 422.
  if (direction === 'save_up' && target <= initial) {
    toast(tr('goals.saveTargetTooLow'), 'error');
    return;
  }
  if (direction === 'pay_down' && (initial <= 0 || target >= initial)) {
    toast(tr('goals.debtTargetInvalid'), 'error');
    return;
  }
  const payload = {
    name,
    direction,
    category_id: categoryId,
    initial_amount: initial.toFixed(2),
    target_amount: target.toFixed(2),
    start_date: startDate,
    icon: direction === 'pay_down' ? 'hand-coins' : 'piggy-bank',
    color: appState.goals.editingColor,
  };
  try {
    if (appState.goals.editingId) {
      await api('PUT', `/goals/${appState.goals.editingId}`, payload);
    } else {
      await api('POST', '/goals', payload);
    }
    closeGoalModal();
    await loadGoals();
    if (appState.nav.activePanel === 'goals') await renderGoalsView();
  } catch (e) {
    if (e.message && e.message.includes('409')) {
      toast(tr('goals.categoryTaken'), 'error');
    } else if (e.message && e.message.includes('422')) {
      toast(tr('goals.invalidAmounts'), 'error');
    } else {
      toast(tr('tx.saveFailed') + e.message, 'error');
    }
  }
}

async function deleteGoalEdit() {
  if (!appState.goals.editingId) return;
  const ok = await confirmAction({
    title: tr('goals.deleteConfirm'),
    confirmLabel: tr('common.delete'),
  });
  if (!ok) return;
  try {
    await api('DELETE', `/goals/${appState.goals.editingId}`);
    closeGoalModal();
    await loadGoals();
    if (appState.nav.activePanel === 'goals') await renderGoalsView();
  } catch (e) {
    toast(tr('tx.deleteFailed') + e.message, 'error');
  }
}

// ── RECURRING (Wiederkehrende Buchungen) ──────────────────────────────────────
// Rules are templates; the backend auto-materializes due
// occurrences into the transactions table on every /auth/me
// and /transactions read. The view here only manages the
// template + skip list. New rows pop into the regular
// transactions list with a small clockwise badge.

// Recurring rules list + edit-modal draft live in appState.recurring (state.js).

async function loadRecurringRules() {
  try {
    appState.recurring.rules = await api('GET', '/recurring');
  } catch (e) {
    appState.recurring.rules = [];
  }
}

const _RECURRING_WEEKDAY_KEYS = [
  'recurring.weekdays.mon',
  'recurring.weekdays.tue',
  'recurring.weekdays.wed',
  'recurring.weekdays.thu',
  'recurring.weekdays.fri',
  'recurring.weekdays.sat',
  'recurring.weekdays.sun',
];

function _recurringSummary(rule) {
  // For interval=1 use a separate key per frequency
  // (recurring.summary.monthlyOne = "Monatlich am Tag 15") so
  // the German rendering doesn't say „Alle 1 Monate" and the
  // English doesn't say "Every 1 month(s)".
  const n = rule.interval || 1;
  const suffix = n === 1 ? 'One' : '';
  const key = 'recurring.summary.' + rule.frequency + suffix;
  const params = { n };
  if (rule.frequency === 'weekly') {
    const wd = rule.weekday == null ? 0 : Number(rule.weekday);
    params.weekday = tr(_RECURRING_WEEKDAY_KEYS[wd] || _RECURRING_WEEKDAY_KEYS[0]);
  } else if (rule.frequency !== 'daily') {
    params.day = rule.day_of_month || 1;
  }
  return tr(key, params);
}

function _recurringFormatDate(iso) {
  if (!iso) return '';
  try {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(_locale(), {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch (e) {
    return iso;
  }
}

// ---- Live "next booking" preview (mirrors backend recurring.py) ----
// Interval-independent, anchored at max(today, start_date) so it
// matches the cursor the backend recomputes on save.
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
// The next booking that will actually happen: walk the schedule from
// the start date through its rhythm (interval-aware) until the first
// occurrence after today — exactly what create + catch-up produce —
// then apply the end-date / count limit. Returns an ISO date or null.
function _recurringComputeNextPreview(f) {
  if (!f.startDate) return null;
  const [sy, sm, sd] = f.startDate.split('-').map(Number);
  const now = new Date();
  const today = { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() };
  let cur = _recurringFirstOnOrAfter(f.frequency, { y: sy, m: sm, d: sd }, f.weekday, f.dayOfMonth);
  let count = 0;
  let guard = 0;
  while (cur && _recurringCmp(cur, today) <= 0 && guard++ < 5000) {
    count += 1;
    if (f.maxOccurrences && count >= f.maxOccurrences) {
      cur = null;
      break;
    }
    cur = _recurringNextOccurrence(f.frequency, f.interval, cur, f.weekday, f.dayOfMonth);
  }
  if (cur && f.endDate) {
    const [ey, em, ed] = f.endDate.split('-').map(Number);
    if (_recurringCmp(cur, { y: ey, m: em, d: ed }) > 0) cur = null;
  }
  if (!cur) return null;
  const mm = String(cur.m).padStart(2, '0');
  const dd = String(cur.d).padStart(2, '0');
  return `${cur.y}-${mm}-${dd}`;
}
// Recompute the status hint live from the current form inputs.
// Paused (editing an inactive rule) takes precedence over the date.
function _refreshRecurringPreview() {
  const line = document.getElementById('recEditStatusHint');
  const btn = document.getElementById('recSkipNextBtn');
  if (!line) return;
  const f = _recurringPayloadFromForm();
  if (!f.active) {
    line.textContent = tr('recurring.pausedHint');
    line.hidden = false;
    if (btn) btn.disabled = true;
    return;
  }
  if (!f.startDate) {
    line.hidden = true;
    return;
  }
  const nextIso = _recurringComputeNextPreview(f);
  line.textContent = nextIso
    ? tr('recurring.nextRun', { date: _recurringFormatDate(nextIso) })
    : tr('recurring.nextRunNone');
  line.hidden = false;
  // Restore skip button to server-cursor state when toggling back to active.
  if (btn && appState.recurring.editingId) {
    const cur = appState.recurring.rules.find((x) => x.id === appState.recurring.editingId);
    btn.disabled = !cur?.next_occurrence_date;
  }
}

async function renderRecurringView() {
  const el = document.getElementById('recurringViewList');
  if (!el) return;
  if (!appState.recurring.rules.length) {
    el.innerHTML = `<div class="empty-state"><svg class="cat-glyph goals-empty-glyph" aria-hidden="true"><use href="#icon-arrows-clockwise"/></svg><p>${tr('recurring.emptyView')}<br>${tr('recurring.emptyViewHint')}</p></div>`;
    return;
  }
  const sorted = [...appState.recurring.rules].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return a.name.localeCompare(b.name, _locale(), { sensitivity: 'base' });
  });
  el.innerHTML = sorted
    .map((r) => {
      const summary = _recurringSummary(r);
      // Use server cursor when available (exact, honours skips); fall back to
      // the schedule walk so active rules with a future start date always
      // show a date rather than the "Pausiert" fallback text.
      const _nextDate =
        r.next_occurrence_date ||
        (r.active
          ? _recurringComputeNextPreview({
              frequency: r.frequency,
              interval: r.interval,
              weekday: r.weekday,
              dayOfMonth: r.day_of_month,
              startDate: r.start_date,
              endDate: r.end_date,
              maxOccurrences: r.max_occurrences,
              active: true,
            })
          : null);
      const statusLine =
        r.active && _nextDate
          ? tr('recurring.nextRunCard', { date: _recurringFormatDate(_nextDate) })
          : tr('recurring.inactive');
      // No +/− sign — the colour (green income / red expense) carries
      // the direction, matching the ledger summary cards.
      const amount = fmtCurrency(Math.abs(r.amount));
      const inactiveCls = r.active ? '' : ' is-inactive';
      const cat = appState.ledger.categories.find((c) => c.id === r.category_id);
      const catColor = cat?.color || 'var(--accent)';
      return `<div class="recurring-card${inactiveCls}">
              <button type="button" class="recurring-card-main"
                aria-label="${_escAttr(r.name)}"
                onclick="openRecurringModal(${r.id})">
                <span class="recurring-card-icon" style="--cat-color:${_escAttr(catColor)}" aria-hidden="true">
                  ${catIconSvg(cat?.icon)}
                </span>
                <span class="recurring-card-body">
                  <span class="recurring-card-name">${_escText(r.name)}</span>
                  <span class="recurring-card-sub">${_escText(summary)}</span>
                  <span class="recurring-card-sub">${_escText(statusLine)}</span>
                </span>
                <span class="recurring-card-amount ${r.type}">${amount}</span>
              </button>
            </div>`;
    })
    .join('');
}

function populateRecurringCategorySelect(selectedId) {
  const sel = document.getElementById('recEditCategory');
  if (!sel) return;
  const sorted = [...appState.ledger.categories].sort((a, b) =>
    a.name.localeCompare(b.name, _locale(), { sensitivity: 'base' }),
  );
  const effectiveId = sorted.some((c) => c.id === selectedId)
    ? selectedId
    : sorted[0] && sorted[0].id;
  sel.innerHTML = sorted
    .map(
      (c) =>
        `<option value="${c.id}"${c.id === effectiveId ? ' selected' : ''}>${_escText(c.name)}</option>`,
    )
    .join('');
}

// Validity is a single choice (unlimited / date / count). Toggling
// it shows exactly one of the end-date / max-occurrences fields and
// keeps the .segmented tabs in sync. The save path maps the active
// kind to a payload where end_date and max_occurrences are mutually
// exclusive.
function setRecurringValidity(kind) {
  appState.recurring.validity = kind;
  document.querySelectorAll('#recValidityTabs button').forEach((b) => {
    const active = b.dataset.kind === kind;
    b.setAttribute('aria-selected', String(active));
    b.classList.toggle('is-active', active);
  });
  document.getElementById('recEditEndDateGroup').hidden = kind !== 'date';
  document.getElementById('recEditMaxGroup').hidden = kind !== 'count';
  _refreshRecurringPreview();
}

function _renderRecurringSkipsList(rule) {
  const list = document.getElementById('recEditSkipsList');
  if (!list) return;
  const skips = (rule && rule.skips) || [];
  if (!skips.length) {
    // Real <li> instead of a ::after pseudo so screen readers
    // hear the empty-state text. The .is-empty class lets the
    // CSS de-style the row (no separator background, muted).
    list.innerHTML = `<li class="is-empty">${_escText(tr('recurring.skipsEmpty'))}</li>`;
    return;
  }
  list.innerHTML = skips
    .slice()
    .sort()
    .map(
      // ``iso`` comes from RecurringRuleOut.skips (typed
      // ``list[date]``, server-serialized as YYYY-MM-DD), so it
      // is already non-attacker-controlled. _escAttr is
      // defence-in-depth: if the schema ever weakens, this stops
      // an inline JS injection sink in the onclick attribute.
      // counter-clockwise icon (restore) — not trash —
      // because the action is constructive: the skipped
      // occurrence comes back.
      (iso) =>
        `<li>
                <span>${_escText(_recurringFormatDate(iso))}</span>
                <button type="button" aria-label="${_escAttr(tr('recurring.unskip'))}" onclick="unskipRecurringOccurrence('${_escAttr(iso)}')">
                  <svg class="ui-icon" aria-hidden="true"><use href="#icon-arrow-counter-clockwise"/></svg>
                </button>
              </li>`,
    )
    .join('');
}

// Consolidated status line under the start date (edit only). A
// paused rule takes precedence over the next-run date; the skip
// button is only usable when there is a live next occurrence.
function _updateRecurringStatusHint(rule) {
  const line = document.getElementById('recEditStatusHint');
  const btn = document.getElementById('recSkipNextBtn');
  if (!line) return;
  if (rule && rule.active === false) {
    line.textContent = tr('recurring.pausedHint');
    line.hidden = false;
    if (btn) btn.disabled = true;
  } else {
    // Prefer the server cursor (exact, honours skips); fall back to the
    // schedule walk for active rules whose cursor is not yet set
    // (e.g. a future-start rule the catch-up hasn't touched yet).
    const nextIso =
      (rule && rule.next_occurrence_date) ||
      (rule && rule.active
        ? _recurringComputeNextPreview({
            frequency: rule.frequency,
            interval: rule.interval,
            weekday: rule.weekday,
            dayOfMonth: rule.day_of_month,
            startDate: rule.start_date,
            endDate: rule.end_date,
            maxOccurrences: rule.max_occurrences,
            active: true,
          })
        : null);
    line.textContent = nextIso
      ? tr('recurring.nextRun', { date: _recurringFormatDate(nextIso) })
      : tr('recurring.nextRunNone');
    line.hidden = false;
    if (btn) btn.disabled = !rule?.next_occurrence_date;
  }
}

function openRecurringModal(id) {
  if (!appState.ledger.categories.length) {
    toast(tr('recurring.needCategory'), 'error');
    return;
  }
  rememberModalFocus('recurring');
  const deleteBtn = document.getElementById('recDeleteBtn');
  const title = document.getElementById('recurringModalTitle');
  const skipsGroup = document.getElementById('recEditSkipsGroup');
  const today = new Date();
  if (id) {
    const r = appState.recurring.rules.find((x) => x.id === id);
    if (!r) return;
    appState.recurring.editingId = r.id;
    document.getElementById('recEditName').value = r.name || '';
    document.getElementById('recEditType').value = r.type || 'out';
    document.getElementById('recEditAmount').value = _formatAmountInput(Number(r.amount));
    populateRecurringCategorySelect(r.category_id);
    document.getElementById('recEditDescription').value = r.desc || '';
    document.getElementById('recEditFrequency').value = r.frequency;
    document.getElementById('recEditInterval').value = r.interval || 1;
    // The booking day/weekday derive from the start date on save, so
    // no separate weekday / day-of-month inputs are populated here.
    document.getElementById('recEditStartDate').value = r.start_date;
    document.getElementById('recEditEndDate').value = r.end_date || '';
    document.getElementById('recEditMaxOccurrences').value = r.max_occurrences || '';
    // Validity precedence: count > date > unlimited. A legacy rule
    // carrying both collapses to "count" and the other field clears
    // on the next save.
    setRecurringValidity(r.max_occurrences != null ? 'count' : r.end_date ? 'date' : 'unlimited');
    document.getElementById('recEditActive').checked = r.active !== false;
    appState.tagPicker.recurringTags = r.tags ? [...r.tags] : [];
    renderRecurringTagPills();
    title.textContent = tr('recurring.editTitle');
    deleteBtn.style.display = '';
    skipsGroup.hidden = false;
    _updateRecurringStatusHint(r);
    _renderRecurringSkipsList(r);
  } else {
    appState.recurring.editingId = null;
    document.getElementById('recEditName').value = '';
    document.getElementById('recEditType').value = 'out';
    document.getElementById('recEditAmount').value = '';
    populateRecurringCategorySelect(null);
    document.getElementById('recEditDescription').value = '';
    document.getElementById('recEditFrequency').value = 'monthly';
    document.getElementById('recEditInterval').value = 1;
    document.getElementById('recEditStartDate').value = _iso(
      today.getFullYear(),
      today.getMonth(),
      today.getDate(),
    );
    document.getElementById('recEditEndDate').value = '';
    document.getElementById('recEditMaxOccurrences').value = '';
    setRecurringValidity('unlimited');
    document.getElementById('recEditActive').checked = true;
    appState.tagPicker.recurringTags = [];
    renderRecurringTagPills();
    _refreshRecurringPreview();
    title.textContent = tr('recurring.newTitle');
    deleteBtn.style.display = 'none';
    skipsGroup.hidden = true;
  }
  document.getElementById('recurringModalOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
  setTimeout(() => document.getElementById('recEditName').focus(), 200);
  trapFocusIn(document.querySelector('#recurringModalOverlay .modal'), 'recurring');
}

function closeRecurringModal() {
  document.getElementById('recurringModalOverlay').classList.remove('open');
  document.body.style.overflow = '';
  appState.recurring.editingId = null;
  releaseFocusTrap('recurring');
  restoreModalFocus('recurring');
}

function closeRecurringModalOutside(e) {
  if (e.target === document.getElementById('recurringModalOverlay')) closeRecurringModal();
}

function _recurringPayloadFromForm() {
  const name = document.getElementById('recEditName').value.trim();
  const type = document.getElementById('recEditType').value;
  const amount = parseAmount(document.getElementById('recEditAmount').value);
  const categoryId = parseInt(document.getElementById('recEditCategory').value, 10);
  const description = document.getElementById('recEditDescription').value.trim();
  const frequency = document.getElementById('recEditFrequency').value;
  const interval = Math.max(1, parseInt(document.getElementById('recEditInterval').value, 10) || 1);
  const startDate = document.getElementById('recEditStartDate').value;
  const validity = appState.recurring.validity;
  const endDate =
    validity === 'date' ? document.getElementById('recEditEndDate').value || null : null;
  const maxRaw = document.getElementById('recEditMaxOccurrences').value;
  const maxOccurrences = validity === 'count' && maxRaw ? parseInt(maxRaw, 10) : null;
  const active = document.getElementById('recEditActive')?.checked !== false;
  // Derive the booking anchor from the start date: weekday for weekly
  // (JS Sun=0..Sat=6 → backend Mon=0..Sun=6), day-of-month for the
  // month-based frequencies (31 is clamped server-side).
  let weekday = null;
  let dayOfMonth = null;
  if (startDate) {
    const parts = startDate.split('-').map(Number);
    if (frequency === 'weekly') {
      weekday = (new Date(parts[0], parts[1] - 1, parts[2]).getDay() + 6) % 7;
    } else if (frequency !== 'daily') {
      dayOfMonth = parts[2];
    }
  }
  return {
    name,
    type,
    amount,
    categoryId,
    description,
    frequency,
    interval,
    weekday,
    dayOfMonth,
    startDate,
    endDate,
    maxOccurrences,
    active,
    validity,
  };
}

async function saveRecurringEdit() {
  const f = _recurringPayloadFromForm();
  if (!f.name) {
    toast(tr('common.nameRequired'), 'error');
    return;
  }
  if (Number.isNaN(f.amount) || f.amount <= 0) {
    toast(tr('recurring.amountRequired'), 'error');
    return;
  }
  if (!Number.isInteger(f.categoryId)) {
    toast(tr('recurring.categoryRequired'), 'error');
    return;
  }
  if (!f.startDate) {
    toast(tr('tx.amountDateRequired'), 'error');
    return;
  }
  if (f.validity === 'date') {
    if (!f.endDate) {
      toast(tr('recurring.endDateRequired'), 'error');
      return;
    }
    if (f.endDate < f.startDate) {
      toast(tr('recurring.endBeforeStart'), 'error');
      return;
    }
  }
  if (f.validity === 'count' && (!f.maxOccurrences || f.maxOccurrences < 1)) {
    toast(tr('recurring.countRequired'), 'error');
    return;
  }
  const payload = {
    name: f.name,
    type: f.type,
    amount: f.amount.toFixed(2),
    category_id: f.categoryId,
    desc: f.description,
    tags: appState.tagPicker.recurringTags,
    frequency: f.frequency,
    interval: f.interval,
    weekday: f.weekday,
    day_of_month: f.dayOfMonth,
    start_date: f.startDate,
    end_date: f.endDate,
    max_occurrences: f.maxOccurrences,
    active: f.active,
  };
  try {
    if (appState.recurring.editingId) {
      await api('PUT', `/recurring/${appState.recurring.editingId}`, payload);
    } else {
      const created = await api('POST', '/recurring', payload);
      const count = created && created.materialized_count;
      if (count > 0) {
        // Same wording as the startup catch-up toast: a backdated rule
        // materializes its past bookings server-side on create.
        toast(
          count === 1
            ? tr('recurring.materializedBannerOne')
            : tr('recurring.materializedBanner', { count }),
        );
      }
    }
    closeRecurringModal();
    await loadRecurringRules();
    if (appState.nav.activePanel === 'recurring') await renderRecurringView();
    // Re-fetch the ledger right away: a backdated create materializes
    // its past bookings server-side in the same request, and the GET
    // also runs the catch-up, so the new rows are visible immediately
    // instead of only on the next app open.
    _invalidateLocalTxCache();
    await loadAndRender();
  } catch (e) {
    const msg = e && e.message ? e.message : '';
    if (msg.includes('409')) {
      toast(tr('recurring.duplicateName'), 'error');
    } else if (msg.includes('422')) {
      toast(tr('recurring.saveFailed'), 'error');
    } else {
      toast(tr('recurring.saveFailed') + ' ' + msg, 'error');
    }
  }
}

async function deleteRecurringEdit() {
  if (!appState.recurring.editingId) return;
  const ok = await confirmAction({
    title: tr('recurring.deleteConfirm'),
    message: tr('recurring.deleteBody'),
    confirmLabel: tr('common.delete'),
  });
  if (!ok) return;
  try {
    await api('DELETE', `/recurring/${appState.recurring.editingId}`);
    closeRecurringModal();
    await loadRecurringRules();
    if (appState.nav.activePanel === 'recurring') await renderRecurringView();
    _invalidateLocalTxCache();
  } catch (e) {
    toast(tr('tx.deleteFailed') + e.message, 'error');
  }
}

async function skipNextRecurringOccurrence() {
  if (!appState.recurring.editingId) return;
  try {
    const res = await api('POST', `/recurring/${appState.recurring.editingId}/skip-next`);
    if (res && res.skipped_date) {
      toast(tr('recurring.skipNextDone', { date: _recurringFormatDate(res.skipped_date) }));
    }
    await loadRecurringRules();
    const refreshed = appState.recurring.rules.find((x) => x.id === appState.recurring.editingId);
    _updateRecurringStatusHint(refreshed);
    _renderRecurringSkipsList(refreshed);
    if (appState.nav.activePanel === 'recurring') await renderRecurringView();
  } catch (e) {
    toast(tr('recurring.skipNextFailed'), 'error');
  }
}

async function unskipRecurringOccurrence(iso) {
  if (!appState.recurring.editingId || !iso) return;
  try {
    await api('DELETE', `/recurring/${appState.recurring.editingId}/skip/${iso}`);
    await loadRecurringRules();
    const refreshed = appState.recurring.rules.find((x) => x.id === appState.recurring.editingId);
    _renderRecurringSkipsList(refreshed);
  } catch (e) {
    toast(tr('recurring.unskipFailed'), 'error');
  }
}

function _invalidateLocalTxCache() {
  // Tells the next switch to the transactions panel to refetch.
  // The codebase uses different names in different builds; both
  // assignments are no-ops if the variable doesn't exist.
  try {
    appState.ledger.transactions = [];
  } catch (_) {}
  try {
    appState.ledger.all = null;
  } catch (_) {}
  // Also clear the per-year report aggregate cache. api() does
  // this automatically on every non-GET, but the outbox replay
  // path skips api() — without this the reports view would
  // render stale aggregates after a rule materialized rows
  // during a background sync.
  try {
    invalidateReportCache();
  } catch (_) {}
}

// ── TAGS (Einstellungen) ──────────────────────────────────────────────────────
// Tag rename modal draft lives in appState.tagEdit.name (state.js).

function renderTagList() {
  const box = document.getElementById('tagList');
  if (!box) return;
  if (!appState.ledger.availableTags.length) {
    box.innerHTML = `<p class="empty-state-hint">${tr('tags.none')}</p>`;
    return;
  }
  box.innerHTML = appState.ledger.availableTags
    .map(
      (t) => `<div class="tag-pill cat-pill-edit" data-tag="${_escAttr(t)}">${_escText(t)}</div>`,
    )
    .join('');
  box.querySelectorAll('[data-tag]').forEach((el) => {
    el.addEventListener('click', () => openTagModal(el.dataset.tag));
  });
}

function openTagModal(name) {
  rememberModalFocus('tag');
  const deleteBtn = document.getElementById('tagDeleteBtn');
  const title = document.getElementById('tagModalTitle');
  if (name) {
    appState.tagEdit.name = name;
    document.getElementById('tagEditName').value = name;
    title.textContent = tr('tags.editTitle');
    deleteBtn.style.display = '';
  } else {
    appState.tagEdit.name = null;
    document.getElementById('tagEditName').value = '';
    title.textContent = tr('tags.newTitle');
    deleteBtn.style.display = 'none';
  }
  document.getElementById('tagModalOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
  setTimeout(() => document.getElementById('tagEditName').focus(), 200);
  trapFocusIn(document.querySelector('#tagModalOverlay .modal'), 'tag');
}

function closeTagModal() {
  document.getElementById('tagModalOverlay').classList.remove('open');
  document.body.style.overflow = '';
  appState.tagEdit.name = null;
  releaseFocusTrap('tag');
  restoreModalFocus('tag');
}
function closeTagModalOutside(e) {
  if (e.target === document.getElementById('tagModalOverlay')) closeTagModal();
}

async function saveTagEdit() {
  const newName = document.getElementById('tagEditName').value.trim();
  if (!newName) {
    toast(tr('common.nameRequired'), 'error');
    return;
  }
  if (appState.tagEdit.name && newName === appState.tagEdit.name) {
    closeTagModal();
    return;
  }
  try {
    if (appState.tagEdit.name) {
      await api('PUT', `/tags/${encodeURIComponent(appState.tagEdit.name)}`, { new_name: newName });
    } else {
      await api('POST', '/tags', { name: newName });
    }
    closeTagModal();
    await loadTags();
    renderTagList();
    await loadAndRender();
  } catch (e) {
    if (e.message && e.message.includes('409')) {
      toast(tr('tags.exists'), 'error');
    } else {
      toast(tr('tx.saveFailed') + e.message, 'error');
    }
  }
}

async function deleteTagEdit() {
  if (!appState.tagEdit.name) return;
  const ok = await confirmAction({
    title: tr('tags.deleteConfirm'),
    message: tr('tags.deleteRemoves'),
    confirmLabel: tr('common.delete'),
  });
  if (!ok) return;
  try {
    await api('DELETE', `/tags/${encodeURIComponent(appState.tagEdit.name)}`);
    closeTagModal();
    await loadTags();
    renderTagList();
    await loadAndRender();
  } catch (e) {
    toast(tr('tx.deleteFailed') + e.message, 'error');
  }
}

// ── SYNC (Service-Worker-Outbox) ──────────────────────────────────────────────
// Online-Schreibvorgänge laufen direkt; offline landen sie in der IndexedDB-
// Outbox (frontend/db.js) und werden bei wieder hergestellter Verbindung
// vom Service Worker bzw. diesem Aufruf nachgespielt.
function setSyncBadge(n) {
  const badge = document.getElementById('syncBadge');
  if (!badge) return;
  if (n > 0) {
    badge.textContent = n > 99 ? '99+' : String(n);
    badge.hidden = false;
  } else {
    badge.textContent = '';
    badge.hidden = true;
  }
}

function setSyncAria(status) {
  const btn = document.getElementById('syncBtn');
  if (btn) btn.setAttribute('aria-label', tr('sync.label', { status }));
  // The dedicated live region announces the change actively; the
  // aria-label above gives a stable description on focus.
  const live = document.getElementById('syncAriaLive');
  if (live) live.textContent = status;
}

async function syncNow() {
  const btn = document.getElementById('syncBtn');
  const dot = document.getElementById('syncDot');

  btn.classList.remove('error');
  dot.classList.remove('error');
  dot.classList.add('syncing');
  setSyncAria(tr('sync.syncing'));

  let flushed = 0;
  let failed = 0;
  let networkErr = navigator.onLine === false;

  if (!networkErr && window.PocketLogOutbox) {
    try {
      const r = await window.PocketLogOutbox.drain(API);
      flushed = r.ok;
      failed = r.failed;
    } catch (e) {
      networkErr = true;
      console.error('Sync (drain) fehlgeschlagen:', e);
    }
  }

  if (!networkErr) {
    try {
      const r = await fetch(API + '/health', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
    } catch (e) {
      networkErr = true;
      console.error('Sync (health) fehlgeschlagen:', e);
    }
  }

  const remaining = window.PocketLogOutbox ? await window.PocketLogOutbox.count() : 0;
  dot.classList.remove('syncing');

  if (networkErr) {
    btn.classList.add('error');
    dot.classList.add('error');
    setSyncBadge(remaining);
    const msg = tr('sync.offlineSaving');
    setSyncAria(msg);
    toast(msg, 'error');
    return;
  }
  if (remaining > 0) {
    btn.classList.add('error');
    dot.classList.add('error');
    setSyncBadge(remaining);
    const msg = tr('sync.failed');
    setSyncAria(msg);
    toast(msg, 'error');
    return;
  }

  setSyncBadge(0);
  setSyncAria(tr('sync.synced'));
  if (failed > 0) {
    const msg = failed === 1 ? tr('sync.oneFailed') : tr('sync.manyFailed', { n: failed });
    toast(msg, 'error');
  }
  if (flushed > 0 || failed > 0) {
    await loadTags();
    // Replayed POST/PUT/DELETE on /api/recurring would otherwise
    // leave the in-memory rules list stale until the user opens
    // the panel; refresh so the next render is correct.
    await loadRecurringRules();
  }
  await loadAndRender();
}

function saveDefaultView(view) {
  localStorage.setItem('pocketlog.defaultView', view);
  pushSettings({ default_view: view });
}

function loadDefaultView() {
  return localStorage.getItem('pocketlog.defaultView') || 'transactions';
}

// ── LANGUAGE & CURRENCY ───────────────────────────────────────────────────────
// Both are display preferences mirrored to the server like theme. The
// i18n runtime (i18n.js) owns the localStorage + the live re-render via
// the 'i18n:changed' event; these just persist to the DB on top.
function saveLocale(locale) {
  pushSettings({ locale });
  if (window.I18N) I18N.setLocale(locale); // persists + dispatches i18n:changed
}

function saveCurrency(cur) {
  pushSettings({ currency: cur });
  if (window.I18N) I18N.setCurrency(cur); // persists + dispatches i18n:changed
}

// Mirror the persisted preferences into the four "Allgemein" selects.
// Called when the panel opens and after a server reconcile.
function syncDisplaySelects() {
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.value = val;
  };
  set('selTheme', loadTheme());
  set('selDefaultView', loadDefaultView());
  if (window.I18N) {
    set('selLocale', I18N.getLocale());
    set('selCurrency', I18N.getCurrency());
  }
}

// ── THEME ─────────────────────────────────────────────────────────────────────
const THEME_KEY = 'pocketlog.theme';

function applyTheme(theme) {
  const html = document.documentElement;
  if (theme === 'dark' || theme === 'light') {
    html.setAttribute('data-theme', theme);
  } else {
    html.removeAttribute('data-theme');
  }
  // Re-resolve data-dark so CSS picks up the change.
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const isDark = theme === 'dark' || (theme !== 'light' && prefersDark);
  html.setAttribute('data-dark', isDark ? 'true' : 'false');
}

// Follow live OS-theme changes while the user is in 'system' mode.
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
  const manual = localStorage.getItem(THEME_KEY);
  if (manual === 'dark' || manual === 'light') return;
  document.documentElement.setAttribute('data-dark', e.matches ? 'true' : 'false');
  if (appState.nav.activePanel === 'charts') renderReport();
});

function saveTheme(theme) {
  localStorage.setItem(THEME_KEY, theme);
  applyTheme(theme);
  pushSettings({ theme });
  if (appState.nav.activePanel === 'charts') renderReport();
}

function loadTheme() {
  return localStorage.getItem(THEME_KEY) || 'system';
}

// ── SETTINGS-BACKUP (Server) ──────────────────────────────────────────────────
// localStorage rendert sofort — diese Helpers gleichen das mit der DB ab,
// damit das Theme + die Startansicht eine iOS-localStorage-Eviction überleben.
// PUT geht durchs api()-Helper, im Offline-Fall fängt der SW-Outbox alles ab.
function pushSettings(patch) {
  api('PUT', '/settings', patch).catch(() => {});
}

async function reconcileSettingsFromServer() {
  let s;
  try {
    s = await api('GET', '/settings');
  } catch (_) {
    return; // offline / nicht erreichbar → localStorage gilt
  }
  if (!s || s.offline) return;
  if (s.theme && s.theme !== loadTheme()) {
    localStorage.setItem(THEME_KEY, s.theme);
    applyTheme(s.theme);
  }
  if (s.default_view && s.default_view !== loadDefaultView()) {
    // Panel-Switch mitten in der Session wäre disruptiv — nur die
    // Persistenz nachziehen, beim nächsten Start greift der Wert.
    localStorage.setItem('pocketlog.defaultView', s.default_view);
  }
  // Language/currency: the server is the source of truth across
  // devices, so apply a divergent value live (re-renders via
  // i18n:changed). setLocale is async; we don't need to await it.
  if (window.I18N) {
    if (s.locale && s.locale !== I18N.getLocale()) {
      I18N.setLocale(s.locale);
    }
    if (s.currency && s.currency !== I18N.getCurrency()) {
      I18N.setCurrency(s.currency);
    }
  }
  syncDisplaySelects();
}

async function updateSyncBadge() {
  const btn = document.getElementById('syncBtn');
  const dot = document.getElementById('syncDot');
  if (!window.PocketLogOutbox) {
    btn.classList.remove('error');
    dot.classList.remove('error');
    setSyncBadge(0);
    setSyncAria(tr('sync.synced'));
    return;
  }
  const pending = await window.PocketLogOutbox.count();
  if (pending > 0) {
    setSyncBadge(pending);
    setSyncAria(tr('sync.saving'));
  } else {
    btn.classList.remove('error');
    dot.classList.remove('error');
    setSyncBadge(0);
    setSyncAria(tr('sync.synced'));
  }
}

window.addEventListener('online', () => syncNow());

// Desktop / Magic-Keyboard shortcuts. Cmd (macOS / iPad) and Ctrl
// (Windows / Linux) are treated alike. Arrow keys for month
// navigation are intentionally bare keys — they only fire when no
// input is focused, no modal is open, and no mobile drawer is open.
document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  const tag = (e.target.tagName || '').toLowerCase();
  const inField = ['input', 'textarea', 'select'].includes(tag) || e.target.isContentEditable;
  const modalOpen = !!document.querySelector('.modal-overlay.open');
  const drawerOpenMobile =
    document.getElementById('drawer').classList.contains('open') && !_mqTablet.matches;

  if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    openModal();
    return;
  }
  if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    const s = document.getElementById('searchInput');
    if (s) s.focus();
    return;
  }
  if (!modalOpen && !drawerOpenMobile && !inField) {
    if (e.key === 'ArrowLeft') {
      changeMonth(-1);
      return;
    }
    if (e.key === 'ArrowRight') {
      changeMonth(1);
      return;
    }
  }
});

// Escape closes the topmost open modal/drawer. Order matters: confirm
// dialog overrides everything, then nested tag picker, then the
// individual modals, then the drawer.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const confirmOverlay = Array.from(document.querySelectorAll('.modal-overlay.open')).find((o) =>
    o.querySelector('.confirm-modal'),
  );
  if (confirmOverlay) {
    confirmOverlay.querySelector('.confirm-cancel')?.click();
    return;
  }
  if (document.getElementById('tagPickerOverlay').classList.contains('open')) {
    closeTagPicker();
    return;
  }
  if (document.getElementById('tagModalOverlay').classList.contains('open')) {
    closeTagModal();
    return;
  }
  if (document.getElementById('catModalOverlay').classList.contains('open')) {
    closeCatModal();
    return;
  }
  if (document.getElementById('modalOverlay').classList.contains('open')) {
    closeModal();
    return;
  }
  if (document.getElementById('drawer').classList.contains('open')) {
    closeDrawer();
  }
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (ev) => {
    if (ev.data?.type === 'SYNC_DONE') {
      const failed = ev.data.failed || 0;
      if (failed > 0) {
        const msg = failed === 1 ? tr('sync.oneFailed') : tr('sync.manyFailed', { n: failed });
        toast(msg, 'error');
      }
      loadTags();
      loadAndRender();
    }
  });
}

// ── EXPORT / IMPORT ───────────────────────────────────────────────────────────
async function exportCSV() {
  try {
    const res = await fetch(API + '/export/csv');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    const file = new File([blob], 'pocketlog.csv', { type: 'text/csv' });
    if (navigator.canShare?.({ files: [file] })) {
      // No title/text: some share targets (e.g. iOS "Save to Files")
      // materialise those fields as an extra Text.txt next to the CSV.
      await navigator.share({ files: [file] });
    } else {
      _triggerDownload(blob, 'pocketlog.csv');
    }
  } catch (e) {
    if (e.name !== 'AbortError') showToast(tr('importExport.exportFailed'), 'error');
  }
}

async function downloadExampleCSV() {
  // Per-language sample: category names + descriptions match the
  // user's seeded default categories. Falls back to German if the
  // active language has no example file.
  const bundle = window.I18N ? I18N.getBundle() : 'de';
  const filename = tr('importExport.exampleFilename');
  try {
    let res = await fetch('/example-import-' + bundle + '.csv');
    if (!res.ok) res = await fetch('/example-import-de.csv');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    const file = new File([blob], filename, { type: 'text/csv' });
    if (navigator.canShare?.({ files: [file] })) {
      // No title/text — see exportCSV: avoids an extra Text.txt.
      await navigator.share({ files: [file] });
    } else {
      _triggerDownload(blob, filename);
    }
  } catch (e) {
    if (e.name !== 'AbortError') showToast(tr('common.downloadFailed'), 'error');
  }
}

function _triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function importCSV(ev) {
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  const status = document.getElementById('importStatus');
  status.textContent = tr('importExport.importing');
  status.className = 'status-msg';
  const fd = new FormData();
  fd.append('file', file);
  try {
    const res = await fetch(API + '/import/csv', { method: 'POST', body: fd });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error('HTTP ' + res.status + ' – ' + txt.slice(0, 200));
    }
    const r = await res.json();
    const errs = r.errors || [];
    const parts = [tr('importExport.imported', { n: r.imported })];
    if (r.skipped) parts.push(tr('importExport.skipped', { n: r.skipped }));
    if (r.deduped) parts.push(tr('importExport.deduped', { n: r.deduped }));
    if (errs.length) parts.push(tr('importExport.errorRows', { n: errs.length }));

    status.className = 'status-msg ' + (r.imported > 0 ? 'ok' : 'err');
    status.innerHTML = '';
    const summary = document.createElement('div');
    summary.textContent = parts.join(' · ');
    status.appendChild(summary);

    // Per-row errors, translated from the backend codes. Capped so a
    // mostly-broken file can't render thousands of rows. textContent
    // throughout — error params may echo raw CSV cell content.
    if (errs.length) {
      const CAP = 10;
      const list = document.createElement('ul');
      list.className = 'import-error-list';
      errs.slice(0, CAP).forEach((e) => {
        const li = document.createElement('li');
        const msg = tr('importExport.error.' + e.code, e.params || {});
        li.textContent = tr('importExport.rowLabel', { row: e.row, msg });
        list.appendChild(li);
      });
      if (errs.length > CAP) {
        const li = document.createElement('li');
        li.textContent = tr('importExport.moreErrors', { n: errs.length - CAP });
        list.appendChild(li);
      }
      status.appendChild(list);
    }
    await loadCategories();
    await loadTags();
    await loadAndRender();
  } catch (e) {
    status.textContent = tr('importExport.importFailed');
    status.className = 'status-msg err';
  } finally {
    ev.target.value = ''; // gleichen File-Reimport erlauben
  }
}

// ── API KEYS ──────────────────────────────────────────────────────────────────
let _apiKeys = [];

async function loadApiKeys() {
  try {
    _apiKeys = await api('GET', '/api-keys');
    renderApiKeys();
  } catch (_) {}
}

function renderApiKeys() {
  const list = document.getElementById('apiKeyList');
  if (!list) return;
  list.innerHTML = '';

  if (!_apiKeys.length) {
    const empty = document.createElement('p');
    empty.className = 'api-key-card-empty';
    empty.setAttribute('data-i18n', 'apiKeys.empty');
    empty.textContent = tr('apiKeys.empty');
    list.appendChild(empty);
    return;
  }

  // admin is no longer an offered scope; any legacy key still carrying it
  // falls back to its raw scope name ("admin") via the `|| s` below.
  const scopeLabels = {
    import: tr('apiKeys.scope.import'),
    read: tr('apiKeys.scope.read'),
    write: tr('apiKeys.scope.write'),
  };

  _apiKeys.forEach((key) => {
    const card = document.createElement('div');
    card.className = 'api-key-card';

    const name = document.createElement('div');
    name.className = 'api-key-card-name';
    name.textContent = key.name;
    card.appendChild(name);

    const scopes = document.createElement('div');
    scopes.className = 'api-key-card-scopes';
    (key.scopes || []).forEach((s) => {
      const chip = document.createElement('span');
      chip.className = 'api-key-scope-chip' + (s === 'admin' ? ' admin' : '');
      chip.textContent = scopeLabels[s] || s;
      scopes.appendChild(chip);
    });
    card.appendChild(scopes);

    const footer = document.createElement('div');
    footer.className = 'api-key-card-footer';

    const meta = document.createElement('div');
    meta.className = 'api-key-card-meta';
    const locale = I18N.getLocale();
    const created = document.createElement('span');
    created.textContent =
      tr('apiKeys.createdAt') + ': ' + new Date(key.created_at).toLocaleDateString(locale);
    meta.appendChild(created);
    if (key.last_used_at) {
      const used = document.createElement('span');
      used.textContent =
        tr('apiKeys.lastUsed') + ': ' + new Date(key.last_used_at).toLocaleDateString(locale);
      meta.appendChild(used);
    }
    footer.appendChild(meta);

    const revokeBtn = document.createElement('button');
    revokeBtn.className = 'api-key-revoke-btn';
    revokeBtn.setAttribute('data-i18n', 'apiKeys.revoke');
    revokeBtn.textContent = tr('apiKeys.revoke');
    revokeBtn.onclick = () => revokeApiKey(key.id, key.name);
    footer.appendChild(revokeBtn);

    card.appendChild(footer);

    list.appendChild(card);
  });
}

function openApiKeyModal() {
  document.getElementById('apiKeyName').value = '';
  document.getElementById('apiKeyScope').value = 'import';
  document.getElementById('apiKeyFormError').hidden = true;
  document.getElementById('apiKeyFormOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
  document.getElementById('apiKeyName').focus();
}

function closeApiKeyModal() {
  document.getElementById('apiKeyFormOverlay').classList.remove('open');
  if (!document.getElementById('drawer').classList.contains('open')) {
    document.body.style.overflow = '';
  }
}

function closeApiKeyModalOutside(e) {
  if (e.target === document.getElementById('apiKeyFormOverlay')) closeApiKeyModal();
}

async function submitApiKey() {
  const name = document.getElementById('apiKeyName').value.trim();
  const scopes = [document.getElementById('apiKeyScope').value];

  const errEl = document.getElementById('apiKeyFormError');
  if (!name) {
    errEl.textContent = tr('apiKeys.errorName');
    errEl.hidden = false;
    return;
  }
  if (!scopes.length) {
    errEl.textContent = tr('apiKeys.errorScopes');
    errEl.hidden = false;
    return;
  }
  errEl.hidden = true;

  try {
    const result = await api('POST', '/api-keys', { name, scopes });
    closeApiKeyModal();
    document.getElementById('apiKeyCreatedValue').textContent = result.key;
    document.getElementById('apiKeyCreatedOverlay').classList.add('open');
    document.body.style.overflow = 'hidden';
    await loadApiKeys();
  } catch (e) {
    errEl.textContent = tr('common.actionFailed');
    errEl.hidden = false;
  }
}

function closeApiKeyCreatedModal() {
  document.getElementById('apiKeyCreatedOverlay').classList.remove('open');
  if (!document.getElementById('drawer').classList.contains('open')) {
    document.body.style.overflow = '';
  }
}

function closeApiKeyCreatedModalOutside(e) {
  if (e.target === document.getElementById('apiKeyCreatedOverlay')) closeApiKeyCreatedModal();
}

async function copyApiKey() {
  const val = document.getElementById('apiKeyCreatedValue').textContent;
  try {
    await navigator.clipboard.writeText(val);
  } catch (_) {
    const el = document.getElementById('apiKeyCreatedValue');
    const range = document.createRange();
    range.selectNode(el);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
  }
}

async function revokeApiKey(id, name) {
  if (!confirm(tr('apiKeys.revokeConfirm', { name }))) return;
  try {
    await api('DELETE', '/api-keys/' + id);
    await loadApiKeys();
  } catch (_) {}
}

// ── ADMIN / DATA RESET ────────────────────────────────────────────────────────
function openResetModal() {
  document.getElementById('resetModalOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeResetModal() {
  document.getElementById('resetModalOverlay').classList.remove('open');
  // Drawer is the parent surface here — keep scroll-lock if it's still open.
  if (!document.getElementById('drawer').classList.contains('open')) {
    document.body.style.overflow = '';
  }
}
function closeResetModalOutside(e) {
  if (e.target === document.getElementById('resetModalOverlay')) closeResetModal();
}

async function _runReset(path, successMsg) {
  try {
    await api('DELETE', path);
    closeResetModal();
    closeDrawer();
    // Reload categories from the server — admin/all-data leaves
    // them gone (default re-seed only fires at user creation).
    await loadCategories();
    await loadTags();
    await loadAndRender();
    toast(successMsg, 'ok');
  } catch (e) {
    toast(tr('admin.deleteFailed') + e.message, 'error');
  }
}

async function resetTransactionsOnly() {
  await _runReset('/admin/transactions', tr('admin.txDeleted'));
}

async function resetAllData() {
  await _runReset('/admin/all-data', tr('admin.allDeleted'));
}

// ── CACHE-CLEAR ───────────────────────────────────────────────────────────────
// Wipes the Service-Worker API cache and the IndexedDB outbox.
// Server data is untouched. Useful when switching Authentik
// identities on the same device, or when local state looks stale.
async function openCacheModal() {
  // null = unknown (count failed). Treated like "pending exists"
  // in the confirm copy so the user can't lose offline writes
  // without warning when the outbox lookup itself is broken.
  let pending = null;
  try {
    pending = window.PocketLogOutbox ? await window.PocketLogOutbox.count() : 0;
  } catch (_) {}
  const msg =
    pending === null
      ? tr('admin.cacheUnsynced')
      : pending > 0
        ? tr('admin.cacheUnsyncedN', { n: pending })
        : tr('admin.cacheRefetch');
  document.getElementById('cacheModalMsg').textContent = msg;
  document.getElementById('cacheModalOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeCacheModal() {
  document.getElementById('cacheModalOverlay').classList.remove('open');
  if (!document.getElementById('drawer').classList.contains('open')) {
    document.body.style.overflow = '';
  }
}

function closeCacheModalOutside(e) {
  if (e.target === document.getElementById('cacheModalOverlay')) closeCacheModal();
}

async function confirmClearAppCache() {
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k.startsWith('pocketlog-api-')).map((k) => caches.delete(k)),
      );
    }
    if (window.PocketLogOutbox) {
      await window.PocketLogOutbox.clear();
      await window.PocketLogOutbox.failedClear();
    }
    closeCacheModal();
    closeDrawer();
    updateSyncBadge();
    await loadAndRender();
    toast(tr('admin.cacheCleared'), 'ok');
  } catch (e) {
    toast(tr('admin.cacheFailed') + e.message, 'error');
  }
}

// ── INFO PANEL ────────────────────────────────────────────────────────────────
// Beste-Aufwand-Erkennung. UA-Strings sind notorisch unzuverlässig —
// diese Werte sind ausschließlich für Debug-Anzeige gedacht, niemals
// als Logik-Schalter.
function _detectPlatform() {
  const ua = navigator.userAgent || '';
  const touch = navigator.maxTouchPoints || 0;
  const fmt = (a, b, c) => `${a}.${b}${c ? '.' + c : ''}`;
  let m;
  // Apple deckelt OS-Versionen mittlerweile in allen Browser-UAs ein
  // (macOS auf 10_15_7 seit Safari 14, iPadOS gibt im Desktop-Spoof
  // gar nichts mehr aus, und seit iOS 26 friert auch der iPhone-UA
  // auf „18_x" ein). Daher überall nur den Plattformnamen.
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && touch > 1)) return 'iPad';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/Android/.test(ua)) {
    const v = ua.match(/Android (\d+(?:\.\d+)*)/);
    // Modell steht hinter dem zweiten Semikolon und vor ' Build/' bzw. ')'.
    const mm =
      ua.match(/Android[^;]*;[^;]*;\s*([^;)]+?)(?:\s+Build|\))/) ||
      ua.match(/;\s*([^;)]+)\s+Build\//);
    const model = mm ? mm[1].trim() : '';
    return `Android${v ? ' ' + v[1] : ''}${model ? ' · ' + model : ''}`;
  }
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows NT/.test(ua)) {
    m = ua.match(/Windows NT (\d+\.\d+)/);
    const map = { '10.0': '10/11', 6.3: '8.1', 6.2: '8', 6.1: '7' };
    return m ? `Windows ${map[m[1]] || m[1]}` : 'Windows';
  }
  if (/CrOS/.test(ua)) return 'ChromeOS';
  if (/Linux/.test(ua)) return 'Linux';
  return tr('info.pointerUnknown');
}

function _detectBrowser() {
  const ua = navigator.userAgent || '';
  let m;
  // iOS-Alternativbrowser sind alle WebKit, lassen sich aber am
  // herstellerspezifischen Token erkennen — wichtig vor dem Safari-Match.
  if ((m = ua.match(/CriOS\/(\d+(?:\.\d+)?)/))) return 'Chrome iOS ' + m[1];
  if ((m = ua.match(/FxiOS\/(\d+(?:\.\d+)?)/))) return 'Firefox iOS ' + m[1];
  if ((m = ua.match(/EdgiOS\/(\d+(?:\.\d+)?)/))) return 'Edge iOS ' + m[1];
  if ((m = ua.match(/Edg\/(\d+(?:\.\d+)?)/))) return 'Edge ' + m[1];
  if ((m = ua.match(/OPR\/(\d+(?:\.\d+)?)/))) return 'Opera ' + m[1];
  if ((m = ua.match(/Firefox\/(\d+(?:\.\d+)?)/))) return 'Firefox ' + m[1];
  if (/Chrome\//.test(ua) && !/Edg|OPR/.test(ua)) {
    m = ua.match(/Chrome\/(\d+(?:\.\d+)?)/);
    return m ? 'Chrome ' + m[1] : 'Chrome';
  }
  if (/Safari\//.test(ua) && (m = ua.match(/Version\/(\d+(?:\.\d+)?)/))) {
    return 'Safari ' + m[1];
  }
  return '–';
}

function _detectDisplayMode() {
  if (window.matchMedia('(display-mode: standalone)').matches) return 'PWA (standalone)';
  if (window.matchMedia('(display-mode: minimal-ui)').matches) return 'PWA (minimal-ui)';
  if (window.matchMedia('(display-mode: fullscreen)').matches) return tr('info.displayFullscreen');
  // iOS-Safari nutzt die nicht-standardisierte navigator.standalone-Flag
  // statt display-mode, bis heute.
  if (navigator.standalone === true) return tr('info.displayHomescreen');
  return tr('info.displayBrowserTab');
}

function _detectPointer() {
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const fine = window.matchMedia('(pointer: fine)').matches;
  const hover = window.matchMedia('(hover: hover)').matches;
  const parts = [];
  if (coarse && fine) parts.push(tr('info.pointerTouchMouse'));
  else if (coarse) parts.push(tr('info.pointerTouch'));
  else if (fine) parts.push(tr('info.pointerMouse'));
  else parts.push(tr('info.pointerUnknown'));
  const touchPts = navigator.maxTouchPoints || 0;
  if (touchPts > 0) parts.push(tr('info.touchPoints', { n: touchPts }));
  if (!hover) parts.push(tr('info.noHover'));
  return parts.join(' · ');
}

// Jede renderInfoPanel-Invocation bekommt eine Sequenznummer; async
// Antworten (Backend-Version, Health-Probe) überschreiben das DOM nur
// dann, wenn sie noch zum aktuellen Durchgang gehören. Verhindert,
// dass eine alte, langsame Antwort einen neueren Stand überschreibt,
// wenn der User das Panel schnell zweimal öffnet. Seq in appState.nav.infoPanelSeq.

async function renderInfoPanel() {
  const mySeq = ++appState.nav.infoPanelSeq;
  const set = (id, value) => {
    if (mySeq !== appState.nav.infoPanelSeq) return;
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };

  const dpr = window.devicePixelRatio || 1;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const sw = window.screen ? window.screen.width : 0;
  const sh = window.screen ? window.screen.height : 0;
  // Browser-Zoom näherungsweise aus outerWidth/innerWidth. Auf macOS
  // Safari/Firefox zählt das Fenster-Chrome minimal mit, daher runden.
  // visualViewport.scale fängt Pinch-Zoom auf Touch-Geräten ein.
  const zoomRatio = window.outerWidth && vw ? window.outerWidth / vw : 1;
  const zoomPct = Math.round(zoomRatio * 100);
  const pinch = window.visualViewport ? window.visualViewport.scale : 1;
  const zoomParts = [`${zoomPct}%`];
  if (pinch && Math.abs(pinch - 1) > 0.01) {
    zoomParts.push(`Pinch ${Math.round(pinch * 100) / 100}×`);
  }

  set('infoBackendVersion', tr('info.loadingValue'));
  set('infoSwVersion', '–');
  set('infoOnline', navigator.onLine ? tr('info.checking') : tr('info.offline'));
  set('infoPlatform', _detectPlatform());
  set('infoBrowser', _detectBrowser());
  set('infoDisplayMode', _detectDisplayMode());
  set('infoPointer', _detectPointer());
  set('infoViewport', `${vw} × ${vh} px`);
  set('infoScreen', sw && sh ? `${sw} × ${sh} px` : '–');
  set('infoDpr', `${Math.round(dpr * 100) / 100}×`);
  set('infoZoom', zoomParts.join(' · '));
  set('infoPhysical', `${Math.round(vw * dpr)} × ${Math.round(vh * dpr)} px`);
  set('infoLang', navigator.language || '–');
  set('infoUserAgent', navigator.userAgent || '–');

  // Service-Worker-Status + Cache-Version
  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) {
        set('infoSwState', tr('info.swNotRegistered'));
      } else {
        const sw = reg.active || reg.waiting || reg.installing;
        const state = sw ? sw.state : tr('info.swUnknown');
        const controlled = navigator.serviceWorker.controller ? ' · ' + tr('info.swActive') : '';
        set('infoSwState', `${state}${controlled}`);
      }
    } catch (e) {
      set('infoSwState', tr('info.error'));
    }
    try {
      const keys = await caches.keys();
      const shellKey = keys.find((k) => k.startsWith('pocketlog-shell-'));
      set('infoSwVersion', shellKey ? shellKey.replace('pocketlog-shell-', '') : '–');
    } catch (e) {
      set('infoSwVersion', '–');
    }
  } else {
    set('infoSwState', tr('info.unsupported'));
  }

  // Outbox-Stand
  try {
    const pending = window.PocketLogOutbox ? await window.PocketLogOutbox.count() : 0;
    set('infoOutbox', String(pending));
  } catch (e) {
    set('infoOutbox', '–');
  }

  // Backend-Health-Probe – ehrlicher als navigator.onLine, das nur
  // sagt, ob irgendein Netzwerk-Interface da ist. Läuft nur beim
  // Öffnen des Panels (kein Polling) und nur wenn der Browser
  // überhaupt online meldet — sonst wäre der Fetch sicher umsonst.
  if (navigator.onLine) {
    try {
      const res = await fetch(API + '/health', { cache: 'no-store' });
      set(
        'infoOnline',
        res.ok ? tr('info.onlineReachable') : tr('info.onlineHttp', { status: res.status }),
      );
    } catch (e) {
      set('infoOnline', tr('info.onlineUnreachable'));
    }
  }

  // Backend-Version – ohne api()-Helper, da /api/version öffentlich ist
  // und keinen Auth-Header braucht. Direkter Fetch vermeidet außerdem,
  // dass die SW-Outbox bei Offline-Zustand eine Schreib-Operation queued.
  try {
    const res = await fetch(API + '/version', { headers: { Accept: 'application/json' } });
    if (res.ok) {
      const data = await res.json();
      set('infoBackendVersion', data.version || '–');
    } else {
      set('infoBackendVersion', 'HTTP ' + res.status);
    }
  } catch (e) {
    set('infoBackendVersion', 'Offline');
  }
}

// ── LOGOUT + KONTO ────────────────────────────────────────────────────────────
async function logoutWithConfirm() {
  let pending = 0;
  try {
    pending = window.PocketLogOutbox ? await window.PocketLogOutbox.count() : 0;
  } catch (_) {}
  if (pending > 0) {
    const ok = await confirmAction({
      title: tr('account.logoutTitle'),
      message:
        pending === 1
          ? tr('account.logoutBodyOne', { n: pending })
          : tr('account.logoutBodyOther', { n: pending }),
      confirmLabel: tr('account.logoutConfirm'),
      destructive: true,
    });
    if (!ok) return;
  }
  try {
    await authFetch('POST', '/auth/logout', undefined, { reloadOn401: false });
  } catch (_) {}
  try {
    if (window.PocketLogOutbox) {
      await window.PocketLogOutbox.clear();
    }
  } catch (_) {}
  try {
    if (navigator.serviceWorker?.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'CLEAR_API_CACHE' });
    }
  } catch (_) {}
  location.reload();
}

// ── PASSWORT ÄNDERN (Self-Service) ────────────────────────────────────────────
function openChangePasswordModal() {
  document.getElementById('pwModalCurrent').value = '';
  document.getElementById('pwModalNew').value = '';
  document.getElementById('pwModalConfirm').value = '';
  _setAuthError('pwModalError', '');
  document.getElementById('pwModalOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
  setTimeout(() => document.getElementById('pwModalCurrent')?.focus(), 50);
}
function closePwModal() {
  document.getElementById('pwModalOverlay').classList.remove('open');
  if (!document.getElementById('drawer').classList.contains('open')) {
    document.body.style.overflow = '';
  }
}
function closePwModalOutside(e) {
  if (e.target === document.getElementById('pwModalOverlay')) closePwModal();
}
async function submitChangePassword() {
  _setAuthError('pwModalError', '');
  const current = document.getElementById('pwModalCurrent').value;
  const next = document.getElementById('pwModalNew').value;
  const confirmPw = document.getElementById('pwModalConfirm').value;
  if (next !== confirmPw) {
    _setAuthError('pwModalError', tr('pwd.newMismatch'));
    return;
  }
  const pwErr = validateNewPassword(next);
  if (pwErr) {
    _setAuthError('pwModalError', pwErr);
    return;
  }
  if (next === current) {
    _setAuthError('pwModalError', tr('pwd.mustDiffer'));
    return;
  }
  try {
    const res = await authFetch('POST', '/auth/change-password', {
      current_password: current,
      new_password: next,
    });
    if (res.status === 400) {
      const data = await res.json().catch(() => ({}));
      if (data.detail === 'current_password_wrong') {
        _setAuthError('pwModalError', tr('pwd.currentWrong'));
      } else if (data.detail === 'password_reused') {
        _setAuthError('pwModalError', tr('pwd.mustDiffer'));
      } else {
        _setAuthError('pwModalError', tr('pwd.changeFailed'));
      }
      return;
    }
    if (!res.ok) {
      const pe = _passwordErrorMessage(await res.json().catch(() => ({})));
      _setAuthError('pwModalError', pe || tr('pwd.changeFailed'));
      return;
    }
    closePwModal();
    // Andere Sessions sind serverseitig gekillt — diese hier
    // bleibt aktiv. Toast nur zur Bestätigung.
    toast(tr('pwd.changed'), 'ok');
  } catch (e) {
    _setAuthError('pwModalError', tr('common.connectionFailed'));
  }
}

// ── ADMIN: BENUTZERVERWALTUNG ─────────────────────────────────────────────────
// Admin user list + current "me" live in appState.admin (state.js).

async function loadAdminUsers() {
  const list = document.getElementById('adminUserList');
  if (!list) return;
  list.textContent = tr('common.loading');
  try {
    appState.admin.users = await api('GET', '/admin/users');
  } catch (e) {
    list.textContent = tr('users.loadFailed');
    return;
  }
  // Aktuelle Identität nochmal frisch ziehen, falls das Body-Flag
  // veraltet ist.
  try {
    const meRes = await fetch(API + '/auth/me', { credentials: 'same-origin' });
    if (meRes.ok) appState.admin.me = await meRes.json();
  } catch (_) {}
  renderAdminUserList();
}

function renderAdminUserList() {
  const list = document.getElementById('adminUserList');
  if (!list) return;
  if (!appState.admin.users.length) {
    list.textContent = tr('users.none');
    return;
  }
  // appState.admin.me MUSS gesetzt sein, sonst kann die UI ihre Self-Schutz-
  // Regeln nicht durchsetzen (Buttons würden auf der eigenen Zeile
  // aktivierbar wirken, obwohl das Backend sie 400/403't). Lieber
  // einen Render-Fehler zeigen als eine UI-Lüge.
  if (!appState.admin.me || appState.admin.me.id == null) {
    list.textContent = tr('users.noIdentity');
    return;
  }
  const meId = appState.admin.me.id;
  list.innerHTML = appState.admin.users
    .map((u) => {
      const isSelf = u.id === meId;
      const tags = [];
      if (u.is_admin)
        tags.push(`<span class="admin-user-tag admin">${tr('users.tagAdmin')}</span>`);
      if (!u.is_active)
        tags.push(`<span class="admin-user-tag inactive">${tr('users.tagInactive')}</span>`);
      if (u.force_change_password)
        tags.push(`<span class="admin-user-tag">${tr('users.pwPending')}</span>`);
      const actions = [];
      actions.push(
        `<button type="button" onclick="openAdminResetPwModal(${u.id})">${tr('users.resetPw')}</button>`,
      );
      if (!u.is_admin) {
        if (u.is_active) {
          actions.push(
            `<button type="button" ${isSelf ? 'disabled' : ''} ` +
              `onclick="adminToggleActive(${u.id}, false)">${tr('users.deactivate')}</button>`,
          );
        } else {
          actions.push(
            `<button type="button" onclick="adminToggleActive(${u.id}, true)">${tr('users.reactivate')}</button>`,
          );
        }
      }
      actions.push(
        `<button type="button" class="btn-destructive" ${isSelf ? 'disabled' : ''} ` +
          `onclick="adminDeleteUserConfirm(${u.id})">${tr('common.delete')}</button>`,
      );
      return `
              <div class="admin-user-row">
                <div class="admin-user-row-head">
                  <span class="admin-user-name">${_escText(u.username)}${isSelf ? tr('users.selfSuffix') : ''}</span>
                </div>
                ${tags.length ? `<div class="admin-user-tags">${tags.join('')}</div>` : ''}
                <div class="admin-user-actions">${actions.join('')}</div>
              </div>`;
    })
    .join('');
}

function openAdminCreateUserModal() {
  document.getElementById('adminCreateUsername').value = '';
  document.getElementById('adminCreatePassword').value = '';
  _setAuthError('adminCreateError', '');
  document.getElementById('adminCreateUserOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
  setTimeout(() => document.getElementById('adminCreateUsername')?.focus(), 50);
}
function closeAdminCreateUserModal() {
  document.getElementById('adminCreateUserOverlay').classList.remove('open');
  if (!document.getElementById('drawer').classList.contains('open')) {
    document.body.style.overflow = '';
  }
}
function closeAdminCreateUserModalOutside(e) {
  if (e.target === document.getElementById('adminCreateUserOverlay')) closeAdminCreateUserModal();
}
async function submitAdminCreateUser() {
  _setAuthError('adminCreateError', '');
  const username = document.getElementById('adminCreateUsername').value.trim();
  const password = document.getElementById('adminCreatePassword').value;
  const pwErr = validateNewPassword(password);
  if (pwErr) {
    _setAuthError('adminCreateError', pwErr);
    return;
  }
  try {
    const res = await authFetch('POST', '/admin/users', { username, password });
    if (res.status === 409) {
      _setAuthError('adminCreateError', tr('users.exists'));
      return;
    }
    if (!res.ok) {
      const pe = _passwordErrorMessage(await res.json().catch(() => ({})));
      _setAuthError('adminCreateError', pe || tr('users.createFailed'));
      return;
    }
    closeAdminCreateUserModal();
    await loadAdminUsers();
    toast(tr('users.created'), 'ok');
  } catch (e) {
    _setAuthError('adminCreateError', tr('common.connectionFailed'));
  }
}

function openAdminResetPwModal(userId) {
  appState.admin.resetPwTargetId = userId;
  const target = appState.admin.users.find((u) => u.id === userId);
  document.getElementById('adminResetPwIntro').textContent = target
    ? tr('users.resetIntro', { name: target.username })
    : '';
  document.getElementById('adminResetPwInput').value = '';
  _setAuthError('adminResetPwError', '');
  document.getElementById('adminResetPwOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
  setTimeout(() => document.getElementById('adminResetPwInput')?.focus(), 50);
}
function closeAdminResetPwModal() {
  document.getElementById('adminResetPwOverlay').classList.remove('open');
  if (!document.getElementById('drawer').classList.contains('open')) {
    document.body.style.overflow = '';
  }
}
function closeAdminResetPwModalOutside(e) {
  if (e.target === document.getElementById('adminResetPwOverlay')) closeAdminResetPwModal();
}
async function submitAdminResetPassword() {
  _setAuthError('adminResetPwError', '');
  if (appState.admin.resetPwTargetId == null) return;
  const pw = document.getElementById('adminResetPwInput').value;
  const pwErr = validateNewPassword(pw);
  if (pwErr) {
    _setAuthError('adminResetPwError', pwErr);
    return;
  }
  try {
    const res = await authFetch(
      'POST',
      `/admin/users/${appState.admin.resetPwTargetId}/reset-password`,
      {
        new_password: pw,
      },
    );
    if (!res.ok) {
      const pe = _passwordErrorMessage(await res.json().catch(() => ({})));
      _setAuthError('adminResetPwError', pe || tr('users.resetFailed'));
      return;
    }
    closeAdminResetPwModal();
    await loadAdminUsers();
    toast(tr('users.reset'), 'ok');
  } catch (e) {
    _setAuthError('adminResetPwError', tr('common.connectionFailed'));
  }
}

async function adminToggleActive(userId, activate) {
  const target = appState.admin.users.find((u) => u.id === userId);
  const name = target ? target.username : tr('users.fallbackName');
  const ok = await confirmAction({
    title: activate ? tr('users.reactivateTitle', { name }) : tr('users.deactivateTitle', { name }),
    message: activate
      ? tr('users.activateConfirm', { name })
      : tr('users.deactivateConfirm', { name }),
    confirmLabel: activate ? tr('users.reactivate') : tr('users.deactivate'),
    destructive: !activate,
  });
  if (!ok) return;
  try {
    const res = await authFetch(
      'POST',
      `/admin/users/${userId}/${activate ? 'activate' : 'deactivate'}`,
    );
    if (!res.ok) {
      toast(tr('common.actionFailed'), 'error');
      return;
    }
    await loadAdminUsers();
    toast(activate ? tr('users.activated') : tr('users.deactivated'), 'ok');
  } catch (e) {
    toast(tr('common.connectionFailed'), 'error');
  }
}

async function adminDeleteUserConfirm(userId) {
  const target = appState.admin.users.find((u) => u.id === userId);
  const name = target ? target.username : tr('users.fallbackName');
  const ok = await confirmAction({
    title: tr('users.deleteConfirm', { name }),
    message: tr('users.deleteBody', { name }) + tr('users.deleteIrreversible'),
    confirmLabel: tr('users.deleteFinal'),
    destructive: true,
  });
  if (!ok) return;
  try {
    const res = await authFetch('DELETE', `/admin/users/${userId}`);
    if (!res.ok) {
      toast(tr('users.deleteFailed'), 'error');
      return;
    }
    await loadAdminUsers();
    toast(tr('users.deleted'), 'ok');
  } catch (e) {
    toast(tr('common.connectionFailed'), 'error');
  }
}

// ── AUTH BOOTSTRAP ────────────────────────────────────────────────────────────
function _showAuthView(id) {
  // 'login' | 'setup' | 'forcePw' | null (none = app shell)
  const map = { login: 'loginView', setup: 'setupView', forcePw: 'forcePwView' };
  Object.values(map).forEach((vid) => {
    const el = document.getElementById(vid);
    if (el) el.hidden = true;
  });
  const shell = document.getElementById('appShell');
  if (!id) {
    if (shell) shell.hidden = false;
    return;
  }
  if (shell) shell.hidden = true;
  const target = document.getElementById(map[id]);
  if (target) target.hidden = false;
}

function _setAuthError(slotId, msg) {
  const el = document.getElementById(slotId);
  if (!el) return;
  if (!msg) {
    el.hidden = true;
    el.textContent = '';
  } else {
    el.textContent = msg;
    el.hidden = false;
  }
}

async function submitLogin() {
  _setAuthError('loginError', '');
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  const remember = document.getElementById('loginRemember').checked;
  const btn = document.getElementById('loginSubmit');
  if (btn) btn.disabled = true;
  try {
    const res = await authFetch(
      'POST',
      '/auth/login',
      { username, password, remember_me: remember },
      { csrf: false, reloadOn401: false },
    );
    if (res.status === 429) {
      const data = await res.json().catch(() => ({}));
      const secs = data.retry_after || 1;
      _setAuthError(
        'loginError',
        `Zu viele Versuche. Warte ${secs} Sekunden und versuche es erneut.`,
      );
      return;
    }
    if (!res.ok) {
      _setAuthError('loginError', tr('auth.badCredentials'));
      return;
    }
    const data = await res.json();
    window._csrfToken = data.user.csrf_token;
    _broadcastCsrfToSw(window._csrfToken);
    await _afterAuthSuccess(data.user);
  } catch (e) {
    _setAuthError('loginError', tr('common.connectionFailed'));
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function submitSetup() {
  _setAuthError('setupError', '');
  const username = document.getElementById('setupUsername').value.trim();
  const password = document.getElementById('setupPassword').value;
  const confirm = document.getElementById('setupPasswordConfirm').value;
  if (password !== confirm) {
    _setAuthError('setupError', tr('auth.passwordsMismatch'));
    return;
  }
  const pwErr = validateNewPassword(password);
  if (pwErr) {
    _setAuthError('setupError', pwErr);
    return;
  }
  try {
    const res = await authFetch(
      'POST',
      '/auth/setup',
      { username, password, locale: window.I18N ? I18N.getLocale() : 'de-DE' },
      { csrf: false, reloadOn401: false },
    );
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const pe = _passwordErrorMessage(data);
      if (pe) {
        _setAuthError('setupError', pe);
      } else if (data.detail === 'setup_already_done') {
        _setAuthError('setupError', tr('auth.setupAlreadyDone'));
      } else {
        _setAuthError('setupError', tr('auth.setupFailed'));
      }
      return;
    }
    location.reload();
  } catch (e) {
    _setAuthError('setupError', tr('common.connectionFailed'));
  }
}

// Setup-screen language picker: switch the UI live (not logged in yet,
// so no server persistence — the chosen language is sent with setup
// and seeds the default categories).
function setLocaleFromSetup(locale) {
  if (window.I18N) I18N.setLocale(locale);
}

async function submitForcePassword() {
  _setAuthError('forcePwError', '');
  const next = document.getElementById('forcePwNew').value;
  const confirm = document.getElementById('forcePwConfirm').value;
  if (next !== confirm) {
    _setAuthError('forcePwError', tr('pwd.newMismatch'));
    return;
  }
  const pwErr = validateNewPassword(next);
  if (pwErr) {
    _setAuthError('forcePwError', pwErr);
    return;
  }
  try {
    // Im Force-Change-Zustand ignoriert das Backend ``current_password``
    // bewusst — wir lassen das Feld in der Payload trotzdem als
    // ``null`` zurück, damit das Schema-Default greift.
    // reloadOn401:false, weil wir den 401-Fall selbst handhaben:
    // ein 401 hier bedeutet, dass die gerade gerenderte
    // Force-Change-View zu keiner echten Session passt (alter
    // SW-Cache, frozen-page-state) — sauberer ist Hard-Reset
    // als der normale Reload, der dasselbe Symptom reproduzieren
    // würde.
    const res = await authFetch(
      'POST',
      '/auth/change-password',
      { current_password: null, new_password: next },
      { reloadOn401: false },
    );
    if (res.status === 401) {
      await _hardResetClientState();
      return;
    }
    if (res.status === 400) {
      // Backend sagt: Force-Change ist gar nicht aktiv. View ist
      // also gegenüber dem Server-State veraltet — gleiche Ursache
      // wie 401, gleicher Ausweg.
      await _hardResetClientState();
      return;
    }
    if (!res.ok) {
      const pe = _passwordErrorMessage(await res.json().catch(() => ({})));
      _setAuthError('forcePwError', pe || tr('pwd.changeFailed'));
      return;
    }
    location.reload();
  } catch (e) {
    _setAuthError('forcePwError', tr('common.connectionFailed'));
  }
}

async function _afterAuthSuccess(me) {
  appState.admin.me = me;
  document.body.classList.toggle('is-admin', !!me.is_admin);
  const usernameLabel = document.getElementById('accountUsername');
  if (usernameLabel) usernameLabel.textContent = tr('auth.loggedInAs', { name: me.username });
  if (me.force_change_password) {
    // Im Force-Change-Zustand ist das alte Passwort administrativ
    // (Admin-Reset oder CLI) — die Backend-Verifikation ist
    // ausgeschaltet, das Feld wäre eine UI-Lüge. Der User vergibt
    // nur ein neues Passwort plus Wiederholung.
    _showAuthView('forcePw');
    setTimeout(() => document.getElementById('forcePwNew')?.focus(), 50);
    return;
  }
  _showAuthView(null);
  await loadCategoryIconSprite();
  await loadCategories();
  await loadTags();
  await loadGoals();
  await loadRecurringRules();
  await loadAndRender();
  showPanel(loadDefaultView());
  updateSyncBadge();
  reconcileSettingsFromServer();
  // Toast the "N transactions auto-added" notice once per session if
  // the backend just materialized due recurring occurrences. The
  // count rides on /api/auth/me's response — see backend
  // schemas.UserMe.recurring_materialized_count.
  if (me && me.recurring_materialized_count) {
    const n = me.recurring_materialized_count;
    toast(
      n === 1
        ? tr('recurring.materializedBannerOne')
        : tr('recurring.materializedBanner', { count: n }),
    );
  }
}

// React to a language/currency switch: rebuild locale-derived month
// names and re-render whatever is on screen so dynamic strings and
// number/date formatting pick up the change. Static markup is already
// re-translated by i18n.js (applyStatic) before this fires.
function onI18nChanged() {
  rebuildMonthNames();
  syncDisplaySelects();
  const me = appState.admin.me;
  if (me) {
    const usernameLabel = document.getElementById('accountUsername');
    if (usernameLabel) usernameLabel.textContent = tr('auth.loggedInAs', { name: me.username });
  }
  renderAll();
  if (appState.nav.activePanel === 'charts') renderReport();
  if (appState.nav.activePanel === 'goals') renderGoalsView();
  if (appState.nav.activePanel === 'recurring') renderRecurringView();
}

// ── INIT ──────────────────────────────────────────────────────────────────────
async function init() {
  // Wait for the i18n bundle so the first render is already in the
  // active language (i18n.js kicked the load off synchronously).
  if (window.I18N && I18N.ready) {
    try {
      await I18N.ready;
    } catch (e) {}
  }
  rebuildMonthNames();
  document.addEventListener('i18n:changed', onI18nChanged);
  // Re-evaluate goal-card suffix wrapping on viewport/orientation change.
  window.addEventListener('resize', () => {
    if (appState.nav.activePanel !== 'goals') return;
    clearTimeout(appState.nav.goalRelayoutTimer);
    appState.nav.goalRelayoutTimer = setTimeout(_relayoutGoalTargets, 150);
  });
  applyTheme(loadTheme());
  syncDisplaySelects();
  applyRange({ skipRender: true });
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('/sw.js');
    } catch (e) {
      console.warn('SW registration failed:', e);
    }
  }

  // 1) Setup-Status: braucht die DB einen ersten Admin?
  let needsSetup = false;
  let suggested = null;
  let defaultLocale = null;
  try {
    const res = await fetch(API + '/auth/setup-status', {
      credentials: 'same-origin',
    });
    if (res.ok) {
      const data = await res.json();
      needsSetup = !!data.needs_setup;
      suggested = data.suggested_username || null;
      defaultLocale = data.default_locale || null;
    }
  } catch (e) {
    // Backend nicht erreichbar — Login-View zeigen, der User
    // sieht beim Submit den Verbindungsfehler.
  }
  if (needsSetup) {
    if (suggested) {
      const u = document.getElementById('setupUsername');
      if (u) {
        u.value = suggested;
        u.readOnly = true;
      }
      const intro = document.getElementById('setupIntro');
      if (intro) {
        intro.textContent = tr('auth.setupIntroExisting', { name: suggested });
        intro.removeAttribute('data-i18n'); // dynamic now; don't let applyStatic overwrite
      }
    }
    // On a fresh instance, prefer the operator's ENV default locale
    // over the browser guess (unless the user already chose one).
    if (defaultLocale && window.I18N && !localStorage.getItem('pocketlog.locale')) {
      I18N.setLocale(defaultLocale);
    }
    const sl = document.getElementById('setupLocale');
    if (sl && window.I18N) sl.value = I18N.getLocale();
    _showAuthView('setup');
    setTimeout(() => {
      const focusEl = document.getElementById(suggested ? 'setupPassword' : 'setupUsername');
      focusEl?.focus();
    }, 50);
    return;
  }

  // 2) Bin ich eingeloggt?
  window._suppressAuthReload = true;
  let me = null;
  try {
    const res = await fetch(API + '/auth/me', {
      credentials: 'same-origin',
    });
    if (res.ok) me = await res.json();
  } catch (e) {}
  window._suppressAuthReload = false;

  if (!me) {
    _showAuthView('login');
    setTimeout(() => document.getElementById('loginUsername')?.focus(), 50);
    return;
  }
  window._csrfToken = me.csrf_token;
  _broadcastCsrfToSw(window._csrfToken);
  await _afterAuthSuccess(me);
}
init();
