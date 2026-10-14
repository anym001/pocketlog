// App boot: auth bootstrap (setup, login, forced password change) and
// init(). Loaded last — every other frontend module is already parsed
// when init() runs (see index.html for the full script order).

// ── GLOBAL ERROR SURFACING ────────────────────────────────────────────────────
// Without this, a bug anywhere in the app (a thrown error, a rejected
// promise nobody awaited) failed silently — nothing but a console line the
// user never sees, leaving them stuck on a dead view with no explanation.
// The toast makes the failure visible locally; the js_error breadcrumb makes
// it visible to the operator: an enum-only "an uncaught error happened at
// time X" in the server log — never the message or stack, those stay in the
// console (no free text reaches logs, and nothing leaves the user's own
// origin, per project privacy policy).
let _lastGlobalErrorToastAt = 0;
function _surfaceUnexpectedError() {
  const now = Date.now();
  if (now - _lastGlobalErrorToastAt < 4000) return; // one toast per burst
  _lastGlobalErrorToastAt = now;
  recordReloadEvent('js_error');
  // Deliver soon when a session exists (delayed so an error burst coalesces
  // into one report); otherwise the breadcrumb rides along on the next boot.
  if (window._csrfToken) setTimeout(reportReloadEvents, 1000);
  toast(tr('common.actionFailed'), 'error');
}
window.addEventListener('error', (event) => {
  console.error('Unhandled error:', event.error || event.message);
  _surfaceUnexpectedError();
});
window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled promise rejection:', event.reason);
  _surfaceUnexpectedError();
});

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
  // Login needs the server: the password is verified server-side and the
  // session cookie is issued by the backend — there is deliberately no
  // offline credential cache (the service worker even refuses to queue
  // login attempts). When there's no connection, say so plainly instead
  // of letting the request fail into a misleading "bad credentials".
  if (navigator.onLine === false) {
    _setAuthError('loginError', tr('auth.offline'));
    return;
  }
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
    if (res.status === 503) {
      // The service worker's offline fallback (or an unreachable backend
      // on "lie-fi", where navigator.onLine still reports online). A login
      // is never queued, so this is a connection problem, not a wrong
      // password.
      _setAuthError('loginError', tr('auth.offline'));
      return;
    }
    if (!res.ok) {
      _setAuthError('loginError', tr('auth.badCredentials'));
      return;
    }
    const data = await res.json();
    window._csrfToken = data.user.csrf_token;
    _propagateCsrfToken(window._csrfToken);
    await _afterAuthSuccess(data.user);
  } catch (e) {
    _setAuthError(
      'loginError',
      navigator.onLine === false ? tr('auth.offline') : tr('common.connectionFailed'),
    );
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
    // In the force-change state the backend deliberately ignores
    // ``current_password`` — we still leave the field as ``null`` in
    // the payload so the schema default kicks in.
    // reloadOn401:false because we handle the 401 case ourselves:
    // a 401 here means the force-change view currently rendered
    // matches no real session (stale SW cache, frozen-page state) —
    // a hard reset is cleaner than the normal reload, which would
    // reproduce the same symptom.
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
      // Backend says force-change isn't active at all. The view is
      // stale relative to the server state — same cause as the 401,
      // same way out.
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

// The parts of the app chrome that depend on who is signed in.
function _applyMe(me) {
  appState.admin.me = me;
  document.body.classList.toggle('is-admin', !!me.is_admin);
  const usernameLabel = document.getElementById('accountUsername');
  if (usernameLabel) usernameLabel.textContent = tr('auth.loggedInAs', { name: me.username });
}

// `fromCache`: the instant-start pass already put the last synced state on
// screen; this pass replaces it with fresh data without re-navigating.
async function _afterAuthSuccess(me, { fromCache } = {}) {
  appState.boot.sessionConfirmed = true;
  // The cached state belonged to another account than the one the server
  // just confirmed: drop all of it and start clean.
  if (fromCache && appState.boot.cachedUserId != null && me.id !== appState.boot.cachedUserId) {
    await _resetAuthClientState();
    location.reload();
    return;
  }
  _applyMe(me);
  if (me.force_change_password) {
    // In the force-change state the old password is administrative
    // (admin reset or CLI) — backend verification is switched off,
    // the field would be a UI lie. The user only sets a new password
    // plus its confirmation.
    _showAuthView('forcePw');
    focusOnOpen(document.getElementById('forcePwView'), 'forcePwNew', 50);
    return;
  }
  _writeSessionHint(me);
  _showAuthView(null);
  // Deliver reload breadcrumbs from before this boot to the server log.
  // Fire-and-forget — diagnostics must not delay the first render.
  reportReloadEvents();
  if (fromCache) {
    // The cache-first shell skipped the navigation's update check on the dead
    // connection this start was built for; the network works now, so look for
    // a new release here (the switch itself stays unseen, see init).
    navigator.serviceWorker
      ?.getRegistration()
      .then((reg) => reg && reg.update())
      .catch(() => {});
  }
  await _loadBootData(me, { fromCache });
}

// The outcome of a session check (/auth/me): 'ok' with `me`; 'signedOut'
// (401/403); 'gate' — an auth proxy in front of PocketLog (SSO forward auth)
// answered instead, with a redirect or a non-JSON page; 'unreachable' (network
// error, timeout, 5xx, the service worker's offline 503).
async function _sessionCheck(request) {
  try {
    const res = await request;
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      return { kind: 'gate' };
    }
    if (res.status === 401 || res.status === 403) return { kind: 'signedOut' };
    if (!res.ok) return { kind: 'unreachable' };
    if (!(res.headers.get('content-type') || '').includes('application/json')) {
      return { kind: 'gate' };
    }
    return { kind: 'ok', me: await res.json() };
  } catch (_) {
    return { kind: 'unreachable' };
  }
}

// The auth proxy wants the user to sign in again. Nothing cached may stay,
// and the navigation has to reach the network past the cache-first shell
// (sw.js pinnedShell skips the cache for ?reauth) so the proxy can answer it
// with its login page. Returns false — without navigating — when this page
// load already came from such a redirect, so a proxy that keeps redirecting
// API calls cannot cause a reload loop.
async function _reauthenticateAtGate() {
  await _resetAuthClientState();
  if (_justReauthenticated()) return false;
  recordReloadEvent('session_expired');
  location.replace('/?reauth=' + Date.now());
  return true;
}

function _justReauthenticated() {
  const m = /[?&]reauth=(\d+)/.exec(location.search);
  return !!m && Date.now() - Number(m[1]) < 30000;
}

// Signed out behind an instant start: the cached state is already in the
// DOM, so clear everything and reload — the login view then starts from an
// empty page (the hint is gone, so that boot runs the regular way).
async function _signedOutAfterCache() {
  await _resetAuthClientState();
  recordReloadEvent('session_expired');
  location.reload();
}

// Instant start (see core.js): draw the last synced state from the service
// worker's API cache before the server has answered anything. Only while the
// browser still holds the session cookie, and only when the slices the main
// views cannot do without — categories and the visible month — are cached;
// otherwise the regular boot runs as before. Returns whether it drew. Never
// touches the network.
async function _bootFromCache(hint) {
  if (!_csrfFromCookie()) return false;
  const monthPath = _monthTransactionsPath();
  const [cats, cachedMonth] = await Promise.all([cachedApi('/categories'), cachedApi(monthPath)]);
  if (!Array.isArray(cats)) return false;
  let month = cachedMonth;
  if (!Array.isArray(month)) {
    // First open in a new month: the full history (warmed in the background
    // on every online boot) still holds whatever this month already has.
    const all = await cachedApi('/transactions');
    if (!Array.isArray(all)) return false;
    const prefix = `${appState.view.year}-${String(appState.view.month + 1).padStart(2, '0')}-`;
    month = all.filter((t) => typeof t.date === 'string' && t.date.startsWith(prefix));
  }
  appState.boot.fromCache = true;
  appState.boot.cachedUserId = hint.id;
  _applyMe({ id: hint.id, username: hint.username, is_admin: hint.is_admin });
  appState.ledger.categories = cats;
  _showAuthView(null);
  // Not awaited: on a precache miss it would go to the network.
  loadCategoryIconSprite();
  await Promise.all([
    loadTags({ cached: true }),
    loadGoals({ cached: true }),
    loadBudgets({ cached: true }),
    loadRecurringRules({ cached: true }),
  ]);
  await loadAndRender({
    prefetched: { path: monthPath, request: Promise.resolve(month) },
    cached: true,
  });
  showPanel(loadDefaultView(), { keepDrawer: true });
  // Pending and failed offline writes from an earlier session stay visible
  // even while the session check waits (read from IndexedDB only).
  updateSyncBadge();
  updateFailedNotice();
  return true;
}

// The server could not be reached to confirm the session behind an instant
// start: keep the cached state up (the offline view; writes stay blocked) and
// ask again as soon as the network plausibly works — any successful API
// answer, reconnect, returning to the app, and a short backoff timer (the dead
// connection after a pause usually recovers within seconds). A definite
// "signed out" ends in the login view.
function _confirmSessionLater() {
  const boot = appState.boot;
  boot.authPending = true;
  boot.authDelay = 1500;
  updateSyncBadge();
  const attempt = async () => {
    if (!boot.authPending || boot.authRetrying) return;
    boot.authRetrying = true;
    clearTimeout(boot.authTimer);
    let done = false;
    try {
      const check = await _sessionCheck(_bootstrapFetch('/auth/me', { manualRedirect: true }));
      if (check.kind === 'ok') {
        done = true;
        boot.authPending = false;
        window._csrfToken = check.me.csrf_token;
        _propagateCsrfToken(window._csrfToken);
        await _afterAuthSuccess(check.me, { fromCache: true });
      } else if (check.kind === 'signedOut') {
        done = true;
        boot.authPending = false;
        await _signedOutAfterCache();
      } else if (check.kind === 'gate') {
        done = true;
        boot.authPending = false;
        if (!(await _reauthenticateAtGate())) location.reload();
      }
    } finally {
      boot.authRetrying = false;
    }
    if (!done && boot.authPending) {
      boot.authTimer = setTimeout(attempt, boot.authDelay);
      boot.authDelay = Math.min(boot.authDelay * 2, 30000);
    }
  };
  window.addEventListener('online', attempt);
  window.addEventListener('pocketlog:reachable', attempt);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') attempt();
  });
  boot.authTimer = setTimeout(attempt, boot.authDelay);
  boot.authDelay *= 2;
}

// The post-login data loads, separated from _afterAuthSuccess so they can be
// retried. Every loader is individually offline-tolerant (its catch keeps an
// empty slice), so a boot against an unreachable backend used to "succeed"
// into a silently empty app — opening the PWA while the container restarts
// left nothing but blank views, and on iOS the frozen dead page was
// resurrected on every reopen, so the app looked permanently broken. The
// categories GET is the boot-failed signal: it is the keystone load (booking,
// recurring, goals, budgets are unusable without it) and it is network-first
// WITH a cache fallback in the SW — it only rejects when both network and
// cache came up empty, i.e. exactly the dead-boot case. Failures land in the
// boot-error banner (tap = retry); retryBoot also re-arms on online/visible
// (listeners in init).
async function _loadBootData(me, { fromCache } = {}) {
  appState.boot.ready = false;
  // The loads are independent of one another, so they run side by side: one
  // round trip instead of seven in a row, which on a phone reaching the server
  // through a proxy was most of the start-up time. Each slice still lands in
  // its own state and renders nothing that needs the others; the month's
  // transactions are fetched alongside but rendered last (loadAndRender),
  // once the categories they display are in.
  const others = Promise.all([
    loadCategoryIconSprite(),
    loadTags(),
    loadGoals(),
    loadBudgets(),
    loadRecurringRules(),
  ]);
  const monthTx = { path: _monthTransactionsPath() };
  monthTx.request = api('GET', monthTx.path);
  // Rejections are handled where these are awaited; on the boot-failed path
  // below nothing awaits them, which must not surface as unhandled.
  monthTx.request.catch(() => {});
  try {
    await loadCategories({ rethrow: true });
  } catch (e) {
    // Not reached on a 401 — api() hard-reloads to the login view before
    // throwing. This catch is the network/5xx path.
    console.error('Boot data load failed:', e);
    recordReloadEvent('boot_failed');
    _setBootError(true);
    return;
  }
  await others;
  await loadAndRender({ prefetched: monthTx });
  _setBootError(false);
  // Not a navigation: the auth overlay came down at the top of
  // _afterAuthSuccess, so the menu has been tappable for the whole load chain
  // above. Restoring the panel must not shut a drawer the user just opened.
  // After an instant start the user may already have moved on from the
  // default view: refresh whatever is showing instead of navigating
  // (month-scoped panels were already redrawn by loadAndRender).
  if (fromCache) {
    // Whatever the cached phase derived (report year slices, the full
    // history, the earliest booking) may predate the fresh data.
    invalidateReportCache();
    appState.ledger.all = null;
    appState.trend.earliestTxDate = null;
    const cfg = PANELS[appState.nav.activePanel];
    if (cfg && cfg.render && !cfg.monthScoped) cfg.render();
  } else {
    showPanel(loadDefaultView(), { keepDrawer: true });
  }
  updateSyncBadge();
  updateFailedNotice();
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
  appState.boot.ready = true;
}

function _setBootError(failed) {
  appState.boot.failed = failed;
  const banner = document.getElementById('bootErrorBanner');
  if (banner) banner.hidden = !failed;
}

// data-action of the boot-error banner; also fired by the online /
// visibilitychange listeners in init. No-op unless a boot actually failed,
// so the listeners cost nothing in normal operation.
function retryBoot() {
  if (!appState.boot.failed || appState.boot.retrying) return;
  appState.boot.retrying = true;
  _loadBootData(appState.admin.me, { fromCache: appState.boot.fromCache }).finally(() => {
    appState.boot.retrying = false;
    // The retry succeeded: deliver the boot_failed breadcrumb recorded by
    // the failed attempt now instead of waiting for the next full boot.
    if (!appState.boot.failed) reportReloadEvents();
  });
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

// Auth bootstrap fetches (setup-status, me) gate which view init() unhides,
// so they must never hang. On a weak signal a plain fetch neither resolves
// nor rejects for tens of seconds, leaving every view hidden — a white
// screen. Abort after BOOTSTRAP_TIMEOUT_MS so a slow link falls through to
// the login view (same outcome as the existing "backend unreachable" catch)
// instead of stalling. A working-but-slow link still has a few seconds to
// answer before we give up.
const BOOTSTRAP_TIMEOUT_MS = 5000;

// `manualRedirect`: the session check must see an auth proxy's redirect
// (_sessionCheck) instead of following it to the proxy's login page.
function _bootstrapFetch(path, { manualRedirect } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BOOTSTRAP_TIMEOUT_MS);
  return fetch(API + path, {
    credentials: 'same-origin',
    signal: controller.signal,
    redirect: manualRedirect ? 'manual' : 'follow',
  }).finally(() => clearTimeout(timer));
}

// ── INIT ──────────────────────────────────────────────────────────────────────
async function init() {
  if ('serviceWorker' in navigator) {
    // No visible reload when a new service worker takes over. Every app
    // file is requested under its release's ?v= URL (index.html, assetUrl in
    // theme-boot.js) and served from exactly that release's precache
    // (sw.js), so a page can't boot fresh HTML against an older cached
    // script — the half-updated state the former boot-window reload
    // repaired, at the cost of a blink on the first open after every
    // update. A page left open across an update keeps its own consistent
    // release: the new worker just receives the CSRF token outbox replays
    // need, and the page switches to the new release the next time it is
    // hidden — unseen, and never under an open modal whose input a reload
    // would lose. Guarded against the first-ever install (clients.claim()
    // fires controllerchange there too). Registered first so the update
    // check races ahead of the i18n/auth awaits below.
    const hadController = !!navigator.serviceWorker.controller;
    let updateReady = false;
    let reloading = false;
    const reloadIfUnseen = () => {
      if (!updateReady || reloading || document.visibilityState !== 'hidden') return;
      if (document.querySelector('.modal-overlay.open')) return;
      reloading = true;
      recordReloadEvent('sw_update');
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      _propagateCsrfToken(window._csrfToken);
      if (!hadController) return;
      updateReady = true;
      reloadIfUnseen();
    });
    // Browsers only look for a new worker on a navigation. An installed app
    // that is resumed rather than relaunched (iOS keeps it open for days)
    // never navigates, so it asks on coming back to the foreground —
    // throttled, the boot navigation counts as the first check.
    const SW_UPDATE_CHECK_MS = 15 * 60 * 1000;
    let lastUpdateCheck = Date.now();
    const checkForUpdate = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastUpdateCheck < SW_UPDATE_CHECK_MS) return;
      lastUpdateCheck = Date.now();
      navigator.serviceWorker
        .getRegistration()
        .then((reg) => reg && reg.update())
        .catch(() => {});
    };
    document.addEventListener('visibilitychange', () => {
      reloadIfUnseen();
      checkForUpdate();
    });
    navigator.serviceWorker
      .register('/sw.js')
      .catch((e) => console.warn('SW registration failed:', e));
  }

  // A boot whose data loads failed retries by itself as soon as
  // connectivity plausibly returned; both are no-ops while boot is fine.
  window.addEventListener('online', retryBoot);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') retryBoot();
  });

  // Both auth bootstrap requests go out at once, before the i18n wait below:
  // in a row they cost two extra round trips on every start. /auth/me simply
  // answers 401 on a fresh instance, where its result goes unused.
  const setupStatus = _bootstrapFetch('/auth/setup-status');
  const meReq = _bootstrapFetch('/auth/me', { manualRedirect: true });
  // Awaited (and their rejections caught) further down; until then a fast
  // failure must not count as an unhandled rejection (js_error breadcrumb).
  setupStatus.catch(() => {});
  meReq.catch(() => {});

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

  // 0) Instant start: a returning user sees the last synced state right away;
  // the session check and fresh loads below then take over behind it.
  const hint = _readSessionHint();
  let fromCache = false;
  if (hint) {
    try {
      fromCache = await _bootFromCache(hint);
    } catch (e) {
      console.warn('Instant start failed, booting normally:', e);
    }
  }

  // 1) Setup status: does the DB need its first admin?
  let needsSetup = false;
  let suggested = null;
  let defaultLocale = null;
  try {
    const res = await setupStatus;
    if (res.ok) {
      const data = await res.json();
      needsSetup = !!data.needs_setup;
      suggested = data.suggested_username || null;
      defaultLocale = data.default_locale || null;
    }
  } catch (e) {
    // Backend unreachable — show the login view; the user sees the
    // connection error on submit.
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
    // A reset instance: nothing cached belongs to it any more. An instant
    // start already drew it — reload onto an empty page.
    if (hint) {
      await _resetAuthClientState();
      if (fromCache) {
        location.reload();
        return;
      }
    }
    _showAuthView('setup');
    setTimeout(() => {
      const focusEl = document.getElementById(suggested ? 'setupPassword' : 'setupUsername');
      focusEl?.focus();
    }, 50);
    return;
  }

  // 2) Signed in?
  window._suppressAuthReload = true;
  const check = await _sessionCheck(meReq);
  window._suppressAuthReload = false;

  if (check.kind !== 'ok') {
    if (fromCache) {
      // Unreachable behind an instant start: stay on the cached state (writes
      // stay blocked) and confirm the session once the server answers.
      if (check.kind === 'unreachable') {
        _confirmSessionLater();
        return;
      }
      if (check.kind === 'gate') {
        if (!(await _reauthenticateAtGate())) location.reload();
        return;
      }
      await _signedOutAfterCache();
      return;
    }
    // Signed out or stopped at an auth proxy: drop the hint and every cached
    // response that came with it.
    if (check.kind !== 'unreachable' && hint) await _resetAuthClientState();
    if (check.kind === 'gate' && (await _reauthenticateAtGate())) return;
    _showAuthView('login');
    focusOnOpen(document.getElementById('loginView'), 'loginUsername', 50);
    return;
  }
  const me = check.me;
  window._csrfToken = me.csrf_token;
  _propagateCsrfToken(window._csrfToken);
  await _afterAuthSuccess(me, { fromCache });
}
init();
