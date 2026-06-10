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
