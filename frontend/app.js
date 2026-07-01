// App boot: auth bootstrap (setup, login, forced password change) and
// init(). Loaded last — every other frontend module is already parsed
// when init() runs (see index.html for the full script order).

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
    setTimeout(() => document.getElementById('forcePwNew')?.focus(), 50);
    return;
  }
  _showAuthView(null);
  await loadCategoryIconSprite();
  await loadCategories();
  await loadTags();
  await loadGoals();
  await loadBudgets();
  await loadRecurringRules();
  await loadAndRender();
  showPanel(loadDefaultView());
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
    // Auto-reload once when a new service worker takes control. The shell HTML
    // is network-first, so after an upgrade the page can boot fresh markup
    // while still running the previous version's cached JS/i18n until a reload
    // — exactly the half-updated state that breaks newly added reports/keys.
    // Guarded against the first-ever install (no prior controller; the new
    // SW's clients.claim() fires controllerchange there too) and reload loops.
    let _swReloading = false;
    const _hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (_swReloading || !_hadController) return;
      _swReloading = true;
      window.location.reload();
    });
    try {
      await navigator.serviceWorker.register('/sw.js');
    } catch (e) {
      console.warn('SW registration failed:', e);
    }
  }

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
    setTimeout(() => document.getElementById('loginUsername')?.focus(), 50);
    return;
  }
  window._csrfToken = me.csrf_token;
  _propagateCsrfToken(window._csrfToken);
  await _afterAuthSuccess(me);
}
init();
