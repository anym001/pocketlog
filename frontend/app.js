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

async function _afterAuthSuccess(me) {
  appState.admin.me = me;
  document.body.classList.toggle('is-admin', !!me.is_admin);
  const usernameLabel = document.getElementById('accountUsername');
  if (usernameLabel) usernameLabel.textContent = tr('auth.loggedInAs', { name: me.username });
  if (me.force_change_password) {
    // In the force-change state the old password is administrative
    // (admin reset or CLI) — backend verification is switched off,
    // the field would be a UI lie. The user only sets a new password
    // plus its confirmation.
    _showAuthView('forcePw');
    focusOnOpen(document.getElementById('forcePwView'), 'forcePwNew', 50);
    return;
  }
  _showAuthView(null);
  // Deliver reload breadcrumbs from before this boot to the server log.
  // Fire-and-forget — diagnostics must not delay the first render.
  reportReloadEvents();
  await _loadBootData(me);
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
async function _loadBootData(me) {
  appState.boot.ready = false;
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
  await loadCategoryIconSprite();
  await loadTags();
  await loadGoals();
  await loadBudgets();
  await loadRecurringRules();
  await loadAndRender();
  _setBootError(false);
  // Not a navigation: the auth overlay came down at the top of
  // _afterAuthSuccess, so the menu has been tappable for the whole load chain
  // above. Restoring the panel must not shut a drawer the user just opened.
  showPanel(loadDefaultView(), { keepDrawer: true });
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
  _loadBootData(appState.admin.me).finally(() => {
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

function _bootstrapFetch(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BOOTSTRAP_TIMEOUT_MS);
  return fetch(API + path, {
    credentials: 'same-origin',
    signal: controller.signal,
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

  // 1) Setup status: does the DB need its first admin?
  let needsSetup = false;
  let suggested = null;
  let defaultLocale = null;
  try {
    const res = await _bootstrapFetch('/auth/setup-status');
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
    const res = await _bootstrapFetch('/auth/me');
    if (res.ok) me = await res.json();
  } catch (e) {}
  window._suppressAuthReload = false;

  if (!me) {
    _showAuthView('login');
    focusOnOpen(document.getElementById('loginView'), 'loginUsername', 50);
    return;
  }
  window._csrfToken = me.csrf_token;
  _propagateCsrfToken(window._csrfToken);
  await _afterAuthSuccess(me);
}
init();
