// Settings drawer: tags, sync/outbox, locale & currency, theme, backup,
// CSV export/import, API keys, data reset, cache-clear, info panel,
// account (logout, password change) and admin user management.
// Classic script — see index.html for load order.

// ── TAGS (settings) ───────────────────────────────────────────────────────────
// Tag rename modal draft lives in appState.tagEdit.name (state.js).

function renderTagList() {
  const box = document.getElementById('tagList');
  if (!box) return;
  const shown = applyDrawerFilter('tags', appState.ledger.availableTags, (t) => t);
  if (!shown.length) {
    // Nothing to show is either an empty account or a query that missed.
    box.innerHTML = `<p class="empty-state-hint">${tr(drawerFilterActive('tags') ? 'tags.searchNone' : 'tags.none')}</p>`;
    return;
  }
  // Same row contract as renderCategories: the drawer's two management lists
  // are reached the same way. Without role/tabindex the .is-key-active and
  // :focus-visible states styled for #tagList could never fire — the row was
  // pointer-only while its neighbour was not.
  box.innerHTML = shown
    .map((t) => {
      const uses = tagCounts.get(t.toLowerCase())?.total || 0;
      const aria = `${tr('tags.editAria', { name: t })}, ${usageLabel(uses)}`;
      return `<div class="cat-pill-edit" role="button" tabindex="0" data-tag="${_escAttr(t)}" aria-label="${_escAttr(aria)}"><span class="drawer-nav-label">${_escText(t)}</span>${mgmtRowTrailer(uses)}</div>`;
    })
    .join('');
  box.querySelectorAll('[data-tag]').forEach((el) => {
    const open = () => openTagModal(el.dataset.tag);
    el.addEventListener('click', open);
    el.addEventListener('keydown', (e) => handleRowActivate(e, open));
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
  focusOnOpen(document.getElementById('tagModalOverlay'), 'tagEditName', 200);
  trapFocusIn(document.querySelector('#tagModalOverlay .modal'), 'tag');
}

function closeTagModal() {
  document.getElementById('tagModalOverlay').classList.remove('open');
  document.body.style.overflow = '';
  appState.tagEdit.name = null;
  releaseFocusTrap('tag');
  restoreModalFocus('tag');
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
  const oldName = appState.tagEdit.name;
  try {
    const result = oldName
      ? await api('PUT', `/tags/${encodeURIComponent(oldName)}`, { new_name: newName })
      : await api('POST', '/tags', { name: newName });
    closeTagModal();
    if (
      _handleQueuedWrite(result, () => _applyTagLocally(oldName ? 'PUT' : 'POST', oldName, newName))
    )
      return;
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
  const oldName = appState.tagEdit.name;
  try {
    const result = await api('DELETE', `/tags/${encodeURIComponent(oldName)}`);
    closeTagModal();
    if (_handleQueuedWrite(result, () => _applyTagLocally('DELETE', oldName))) return;
    await loadTags();
    renderTagList();
    await loadAndRender();
  } catch (e) {
    toast(tr('tx.deleteFailed') + e.message, 'error');
  }
}

// Mirror a tag create/rename/delete into the in-memory tag list and the loaded
// transaction pools for the offline queued path; the next sync reload
// reconciles. availableTags holds canonical server casing (see loadTags), so a
// new/renamed tag is stored as typed while matching stays case-insensitive.
function _applyTagLocally(method, oldName, newName) {
  const tags = appState.ledger.availableTags;
  const lc = (s) => (s || '').toLowerCase();
  const sortTags = () =>
    tags.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  if (method === 'POST') {
    if (newName && !tags.some((t) => lc(t) === lc(newName))) {
      tags.push(newName);
      sortTags();
    }
  } else if (method === 'DELETE') {
    const i = tags.findIndex((t) => lc(t) === lc(oldName));
    if (i >= 0) tags.splice(i, 1);
    _renameTagInTxPools(oldName, null);
  } else if (method === 'PUT') {
    const i = tags.findIndex((t) => lc(t) === lc(oldName));
    if (i >= 0) tags[i] = newName;
    sortTags();
    _renameTagInTxPools(oldName, newName);
  }
  renderTagList();
  renderAll();
}

// Rename (newName) or remove (newName == null) a tag across the loaded
// transaction pools, matching case-insensitively on the old name.
function _renameTagInTxPools(oldName, newName) {
  const lcOld = (oldName || '').toLowerCase();
  const apply = (pool) => {
    if (!pool) return;
    pool.forEach((t) => {
      if (!t.tags || !t.tags.length) return;
      t.tags =
        newName == null
          ? t.tags.filter((x) => x.toLowerCase() !== lcOld)
          : t.tags.map((x) => (x.toLowerCase() === lcOld ? newName : x));
    });
  };
  apply(appState.ledger.transactions);
  apply(appState.ledger.all);
  apply(appState.reports.txPool);
}

// ── SYNC (service worker outbox) ──────────────────────────────────────────────
// Online writes go through directly; offline they land in the IndexedDB
// outbox (frontend/db.js) and are replayed by the service worker or by
// this call once the connection is back.
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
  dot.classList.remove('error', 'offline');
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
      console.error('Sync (drain) failed:', e);
    }
  }

  if (!networkErr) {
    try {
      const r = await fetch(API + '/health', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
    } catch (e) {
      networkErr = true;
      console.error('Sync (health) failed:', e);
    }
  }

  const remaining = window.PocketLogOutbox ? await window.PocketLogOutbox.count() : 0;
  dot.classList.remove('syncing');

  if (networkErr) {
    // Offline is its own state (grey dot, cloud-slash glyph): the writes
    // are safe in the outbox, nothing failed yet.
    btn.classList.add('error');
    dot.classList.add('offline');
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
    await refreshDomainAfterSync();
  } else {
    await loadAndRender();
  }
  await updateFailedNotice();
}

// ── DEAD-LETTER RECOVERY ──────────────────────────────────────────────────────
// drain() moves a write to the `failed` store when the server rejects its
// replay with a 4xx, so user data is never silently dropped. This surfaces
// those entries: a drawer section (Import/Export) plus an attention dot on the
// header sync button, with all-or-nothing retry / discard.

async function updateFailedNotice() {
  const n = window.PocketLogOutbox ? await window.PocketLogOutbox.failedCount() : 0;
  // Primary surfacing: a banner at the top of the content, on every view.
  const banner = document.getElementById('failedSyncBanner');
  if (banner) banner.hidden = n === 0;
  const bannerText = document.getElementById('failedSyncBannerText');
  if (bannerText) {
    bannerText.textContent = n === 1 ? tr('sync.bannerOne') : tr('sync.bannerMany', { n });
  }
  // Secondary cue on the header sync button (reuses the red error dot).
  const dot = document.getElementById('syncDot');
  if (dot) dot.classList.toggle('error', n > 0);
}

// Render pieces for one dead-lettered entry. Classification is the pure,
// unit-tested _failedEntrySummary (utils.js); this wrapper only translates
// and formats (locale currency/date), so it stays out of the unit tests.
function _recoverEntryLines(entry) {
  const s = _failedEntrySummary(entry);
  const entityText =
    s.entity === 'bulk'
      ? tr('sync.entityBulk', { n: s.label || '?' })
      : tr('sync.entity.' + s.entity);
  const parts = [entityText + ' · ' + tr('sync.verb.' + s.verb)];
  if (s.entity !== 'bulk' && s.label) parts.push(s.label);
  if (s.amount != null && !Number.isNaN(Number(s.amount))) {
    parts.push(fmtCurrency(Number(s.amount)));
  }
  if (s.date) parts.push(fmtDate(s.date));
  const reason =
    s.code === 'csrf_mismatch'
      ? tr('sync.reasonSession')
      : tr('sync.reasonRejected', { status: s.status || '?' });
  return { main: parts.join(' · '), reason };
}

// Open the recovery sheet from the banner: a self-contained dialog (no drawer
// navigation) listing every dead-lettered write (what, content, why the
// server rejected it) with per-entry discard, plus all-at-once retry /
// discard. Built programmatically like confirmAction so it inherits the same
// overlay, scroll-lock and Escape handling. No-op when nothing is
// dead-lettered.
async function openFailedRecovery() {
  const entries = window.PocketLogOutbox ? await window.PocketLogOutbox.failedAll() : [];
  if (!entries.length) return;

  const prevFocus = document.activeElement;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay open';
  overlay.style.alignItems = 'center';

  const modal = document.createElement('div');
  modal.className = 'modal confirm-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'recoverTitle');

  const h = document.createElement('h2');
  h.id = 'recoverTitle';
  h.textContent = tr('sync.recoverTitle');
  modal.appendChild(h);

  const p = document.createElement('p');
  p.className = 'confirm-msg';
  const countLine = (n) =>
    (n === 1 ? tr('sync.recoverOne') : tr('sync.recoverMany', { n })) +
    ' ' +
    tr('sync.recoverHint');
  p.textContent = countLine(entries.length);
  modal.appendChild(p);

  // The concrete entries — textContent throughout, the labels echo user
  // input (descriptions, names).
  const list = document.createElement('ul');
  list.className = 'recover-list';
  entries.forEach((entry) => {
    const { main, reason } = _recoverEntryLines(entry);
    const li = document.createElement('li');
    li.className = 'recover-item';

    const info = document.createElement('div');
    info.className = 'recover-item-info';
    const mainEl = document.createElement('div');
    mainEl.className = 'recover-item-main';
    mainEl.textContent = main;
    mainEl.title = main;
    info.appendChild(mainEl);
    const reasonEl = document.createElement('div');
    reasonEl.className = 'recover-item-reason';
    reasonEl.textContent = reason;
    info.appendChild(reasonEl);
    li.appendChild(info);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'api-key-revoke-btn';
    del.textContent = tr('sync.recoverDiscard');
    del.setAttribute('aria-label', tr('sync.recoverItemDiscard'));
    del.addEventListener('click', async () => {
      await window.PocketLogOutbox.failedRemove(entry.id);
      li.remove();
      const left = list.children.length;
      await updateFailedNotice();
      if (left === 0) {
        close();
        toast(tr('sync.recoverDiscarded'));
      } else {
        p.textContent = countLine(left);
      }
    });
    li.appendChild(del);

    list.appendChild(li);
  });
  modal.appendChild(list);

  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'submit-btn';
  retry.textContent = tr('sync.recoverRetry');
  modal.appendChild(retry);

  const discard = document.createElement('button');
  discard.type = 'button';
  discard.className = 'submit-btn btn-destructive';
  discard.textContent = tr('sync.recoverDiscardAll');
  modal.appendChild(discard);

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'confirm-cancel';
  cancel.textContent = tr('common.close');
  modal.appendChild(cancel);

  overlay.appendChild(modal);

  const close = () => {
    overlay.removeEventListener('keydown', onKey);
    overlay.remove();
    const stillOpen = document.querySelector('.modal-overlay.open');
    if (!stillOpen) document.body.style.overflow = '';
    if (prevFocus && document.contains(prevFocus) && typeof prevFocus.focus === 'function') {
      prevFocus.focus();
    }
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  overlay.addEventListener('keydown', onKey);
  cancel.addEventListener('click', close);
  // Close first so discard's own confirm isn't stacked on top of this sheet.
  retry.addEventListener('click', () => {
    close();
    retryFailedSync();
  });
  discard.addEventListener('click', () => {
    close();
    discardFailedSync();
  });

  document.body.appendChild(overlay);
  document.body.style.overflow = 'hidden';
  focusOnOpen(overlay, retry, 50);
}

// Push the dead-lettered writes back into the outbox and replay them. With the
// CSRF token now propagated, a write that only failed because of the old
// token bug goes through; a genuinely invalid one (duplicate name, deleted
// category) lands back in the failed store — one pass, no retry loop.
async function retryFailedSync() {
  if (!window.PocketLogOutbox) return;
  const n = await window.PocketLogOutbox.requeueFailed();
  if (n > 0) updateSyncBadge();
  await syncNow();
  await updateFailedNotice();
}

async function discardFailedSync() {
  if (!window.PocketLogOutbox) return;
  const ok = await confirmAction({
    title: tr('sync.recoverDiscardConfirm'),
    message: tr('sync.recoverDiscardBody'),
    confirmLabel: tr('sync.recoverDiscard'),
    destructive: true,
  });
  if (!ok) return;
  await window.PocketLogOutbox.failedClear();
  await updateFailedNotice();
  toast(tr('sync.recoverDiscarded'));
}

// After a sync drains the outbox, the in-memory entity lists may still hold
// optimistic offline edits — including provisional negative ids from offline
// creates. Reload every list the offline write path can touch so the server's
// real rows replace them, then re-render whatever panel is on screen. Replayed
// writes on /api/recurring need the same treatment, hence the rules reload.
async function refreshDomainAfterSync() {
  await Promise.all([
    loadTags(),
    loadCategories(),
    loadGoals(),
    loadBudgets(),
    loadRecurringRules(),
  ]);
  renderTagList();
  renderCategories();
  if (appState.nav.activePanel === 'goals') await renderGoalsView();
  if (appState.nav.activePanel === 'budgets') await renderBudgetsView();
  if (appState.nav.activePanel === 'recurring') await renderRecurringView();
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

// Mirror the persisted preferences into the four "General" selects.
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

// ── SETTINGS BACKUP (server) ──────────────────────────────────────────────────
// localStorage renders immediately — these helpers reconcile it with the
// DB so theme + default view survive an iOS localStorage eviction.
// PUT goes through the api() helper; offline, the SW outbox catches it all.
function pushSettings(patch) {
  api('PUT', '/settings', patch).catch(() => {});
}

async function reconcileSettingsFromServer() {
  let s;
  try {
    s = await api('GET', '/settings');
  } catch (_) {
    return; // offline / unreachable → localStorage wins
  }
  if (!s || s.offline) return;
  if (s.theme && s.theme !== loadTheme()) {
    localStorage.setItem(THEME_KEY, s.theme);
    applyTheme(s.theme);
  }
  if (s.default_view && s.default_view !== loadDefaultView()) {
    // A panel switch mid-session would be disruptive — only update the
    // persistence; the value takes effect on the next start.
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
    dot.classList.remove('error', 'offline');
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
    dot.classList.remove('error', 'offline');
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
  // Only where the month switcher is on screen — elsewhere ←/→ silently moved
  // the ledger month behind a view that doesn't show it.
  // An open settings detail (split view) covers the view and a search hides
  // the switcher, so neither counts as showing it.
  const monthView =
    !!PANELS[appState.nav.activePanel]?.monthScoped &&
    !document.body.classList.contains('settings-detail') &&
    !document.body.classList.contains('searching');
  if (!modalOpen && !drawerOpenMobile && !inField && monthView) {
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
  // The three editors the FAB opens on their views (goals / budgets /
  // recurring). The category modal above can stack on top of them.
  for (const [id, close] of [
    ['goalModalOverlay', closeGoalModal],
    ['budgetModalOverlay', closeBudgetModal],
    ['recurringModalOverlay', closeRecurringModal],
  ]) {
    if (document.getElementById(id).classList.contains('open')) {
      close();
      return;
    }
  }
  if (document.getElementById('modalOverlay').classList.contains('open')) {
    closeModal();
    return;
  }
  if (document.getElementById('drawer').classList.contains('open')) {
    closeDrawer();
    return;
  }
  // Split view (≥768 px): Esc closes the settings detail in the content
  // pane — never from under an open modal the branches above don't own.
  if (!document.querySelector('.modal-overlay.open')) _closeSettingsDetail({ focusItem: true });
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (ev) => {
    if (ev.data?.type === 'SYNC_DONE') {
      const failed = ev.data.failed || 0;
      if (failed > 0) {
        const msg = failed === 1 ? tr('sync.oneFailed') : tr('sync.manyFailed', { n: failed });
        toast(msg, 'error');
      }
      refreshDomainAfterSync();
      updateFailedNotice();
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
    if (e.name !== 'AbortError') toast(tr('importExport.exportFailed'), 'error');
  }
}

async function downloadExampleCSV() {
  // Per-language sample: category names + descriptions match the
  // user's seeded default categories. Falls back to German if the
  // active language has no example file.
  const bundle = window.I18N ? I18N.getBundle() : 'de';
  const filename = tr('importExport.exampleFilename');
  try {
    let res = await fetch(assetUrl('/example-import-' + bundle + '.csv'));
    if (!res.ok) res = await fetch(assetUrl('/example-import-de.csv'));
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
    if (e.name !== 'AbortError') toast(tr('common.downloadFailed'), 'error');
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
    // FormData must set its own multipart boundary, so this request cannot go
    // through api() (which forces a JSON Content-Type) — but the CSRF
    // double-submit header is still required on every non-GET session
    // request; without it the backend answers 403 csrf_mismatch.
    const res = await fetch(API + '/import/csv', {
      method: 'POST',
      body: fd,
      credentials: 'same-origin',
      headers: window._csrfToken ? { 'X-CSRF-Token': window._csrfToken } : {},
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error('HTTP ' + res.status + ' – ' + txt.slice(0, 200));
    }
    const r = await res.json();
    // Result shaping (summary entries, row-error cap) lives in utils.js
    // (_importReport, unit-tested); this block only translates and renders.
    const report = _importReport(r);

    status.className = 'status-msg ' + (report.ok ? 'ok' : 'err');
    status.innerHTML = '';
    const summary = document.createElement('div');
    summary.textContent = report.summary.map((s) => tr(s.key, s.params)).join(' · ');
    status.appendChild(summary);

    // Per-row errors, translated from the backend codes. textContent
    // throughout — error params may echo raw CSV cell content.
    if (report.rowErrors.length) {
      const list = document.createElement('ul');
      list.className = 'import-error-list';
      report.rowErrors.forEach((e) => {
        const li = document.createElement('li');
        const msg = tr('importExport.error.' + e.code, e.params);
        li.textContent = tr('importExport.rowLabel', { row: e.row, msg });
        list.appendChild(li);
      });
      if (report.moreErrors) {
        const li = document.createElement('li');
        li.textContent = tr('importExport.moreErrors', { n: report.moreErrors });
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
    ev.target.value = ''; // allow re-importing the same file
  }
}

// ── BACKUP (JSON full export / restore) ───────────────────────────────────────
async function exportBackup() {
  try {
    const res = await fetch(API + '/export/json');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    const file = new File([blob], 'pocketlog-backup.json', { type: 'application/json' });
    if (navigator.canShare?.({ files: [file] })) {
      // No title/text — see exportCSV: avoids an extra Text.txt.
      await navigator.share({ files: [file] });
    } else {
      _triggerDownload(blob, 'pocketlog-backup.json');
    }
  } catch (e) {
    if (e.name !== 'AbortError') toast(tr('importExport.exportFailed'), 'error');
  }
}

// Stable backend error codes → i18n keys. Anything else falls back to the
// generic failure message.
const BACKUP_ERROR_KEYS = {
  restore_not_empty: 'backup.errorNotEmpty',
  restore_conflict: 'backup.errorConflict',
  backup_invalid: 'backup.errorInvalid',
  backup_unsupported_version: 'backup.errorVersion',
  backup_too_large: 'backup.errorTooLarge',
};

async function restoreBackup(ev) {
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  const status = document.getElementById('backupStatus');
  status.textContent = tr('backup.restoring');
  status.className = 'status-msg';
  const fd = new FormData();
  fd.append('file', file);
  try {
    // Multipart body — same CSRF handling as importCSV: the double-submit
    // header is required on every non-GET session request.
    const res = await fetch(API + '/import/json', {
      method: 'POST',
      body: fd,
      credentials: 'same-origin',
      headers: window._csrfToken ? { 'X-CSRF-Token': window._csrfToken } : {},
    });
    if (!res.ok) {
      let code = '';
      try {
        code = (await res.json()).detail || '';
      } catch (_) {}
      status.textContent = tr(BACKUP_ERROR_KEYS[code] || 'backup.restoreFailed');
      status.className = 'status-msg err';
      return;
    }
    const r = await res.json();
    status.textContent = tr('backup.restored', { n: r.transactions });
    status.className = 'status-msg ok';
    // A restore touches every domain (settings incl. locale and theme,
    // categories, rules, …) — a full reload rebuilds the app from server
    // state instead of chasing every cached piece individually.
    setTimeout(() => location.reload(), 1500);
  } catch (e) {
    status.textContent = tr('backup.restoreFailed');
    status.className = 'status-msg err';
  } finally {
    ev.target.value = ''; // allow re-selecting the same file
  }
}

// ── API KEYS ──────────────────────────────────────────────────────────────────
async function loadApiKeys() {
  try {
    appState.apiKeys.list = await api('GET', '/api-keys');
    renderApiKeys();
  } catch (_) {}
}

// One settings row for a record (API key, session, user): name, caption
// lines below it and its actions as text buttons — trailing for a single
// action, on their own line under the caption for several (`stacked`).
// Rows live in a `.drawer-nav.record-list` card like every settings list.
// Actions go through the delegation engine (data-action / data-args).
function _recordRow({ name, meta = [], actions = [], stacked = false }) {
  const row = document.createElement('div');
  row.className = 'record-row' + (stacked ? ' is-stacked' : '');
  const main = document.createElement('div');
  main.className = 'record-main';
  const nameEl = document.createElement('div');
  nameEl.className = 'record-name';
  nameEl.textContent = name;
  main.appendChild(nameEl);
  meta.filter(Boolean).forEach((line) => {
    const m = document.createElement('div');
    m.className = 'record-meta';
    m.textContent = line;
    main.appendChild(m);
  });
  row.appendChild(main);
  if (actions.length) {
    const box = document.createElement('div');
    box.className = 'record-actions';
    actions.forEach((a) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'record-action' + (a.destructive ? ' is-destructive' : '');
      btn.textContent = a.label;
      if (a.ariaLabel) btn.setAttribute('aria-label', a.ariaLabel);
      btn.dataset.action = a.action;
      btn.dataset.args = JSON.stringify(a.args || []);
      box.appendChild(btn);
    });
    row.appendChild(box);
  }
  return row;
}

// Empty / loading / error line inside a record list card.
function _recordEmpty(list, text) {
  list.innerHTML = '';
  const p = document.createElement('p');
  p.className = 'record-empty';
  p.textContent = text;
  list.appendChild(p);
}

function renderApiKeys() {
  const list = document.getElementById('apiKeyList');
  if (!list) return;
  if (!appState.apiKeys.list.length) {
    _recordEmpty(list, tr('apiKeys.empty'));
    return;
  }
  list.innerHTML = '';

  // admin is no longer an offered scope; any legacy key still carrying it
  // falls back to its raw scope name ("admin") via the `|| s` below.
  const scopeLabels = {
    import: tr('apiKeys.scope.import'),
    read: tr('apiKeys.scope.read'),
    write: tr('apiKeys.scope.write'),
  };

  appState.apiKeys.list.forEach((key) => {
    const scopes = (key.scopes || []).map((sc) => scopeLabels[sc] || sc).join(', ');
    const created = tr('apiKeys.createdAt') + ': ' + fmtDate(_parseServerDate(key.created_at));
    const used =
      tr('apiKeys.lastUsed') +
      ': ' +
      (key.last_used_at ? fmtDate(_parseServerDate(key.last_used_at)) : tr('apiKeys.never'));
    list.appendChild(
      _recordRow({
        name: key.name,
        meta: [scopes, `${created} · ${used}`],
        actions: [
          {
            label: tr('apiKeys.revoke'),
            ariaLabel: `${tr('apiKeys.revoke')}: ${key.name}`,
            destructive: true,
            action: 'revokeApiKey',
            args: [key.id, key.name],
          },
        ],
      }),
    );
  });
}

// ── SIGNED-IN DEVICES (session self-service) ─────────────────────────────────
// Relative "last active" for the device list. Coarse units are enough — the
// point is "gerade eben" vs. "vor 3 Wochen", not a stopwatch.
function _fmtRelativeTime(date) {
  const t = date.getTime();
  if (!isFinite(t)) return '';
  const deltaSeconds = Math.round((t - Date.now()) / 1000); // past = negative
  const rtf = new Intl.RelativeTimeFormat(I18N.getLocale(), { numeric: 'auto' });
  const units = [
    ['year', 31536000],
    ['month', 2592000],
    ['week', 604800],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [unit, secs] of units) {
    if (Math.abs(deltaSeconds) >= secs) return rtf.format(Math.trunc(deltaSeconds / secs), unit);
  }
  return rtf.format(0, 'minute'); // "in diesem Moment" / "this minute"
}

async function loadSessions() {
  try {
    appState.sessions.list = await api('GET', '/auth/sessions');
    renderSessions();
  } catch (_) {}
}

function renderSessions() {
  const list = document.getElementById('sessionList');
  if (!list) return;
  list.innerHTML = '';

  // Current session pinned first; the rest keeps the backend's
  // last-seen ordering.
  const sessions = [...appState.sessions.list].sort(
    (a, b) => (b.current ? 1 : 0) - (a.current ? 1 : 0),
  );

  sessions.forEach((s) => {
    const device = _deviceLabelFromUA(s.user_agent) || tr('sessions.unknownDevice');
    const lastActive = tr('sessions.lastActive', {
      when: _fmtRelativeTime(_parseServerDate(s.last_seen_at)),
    });
    const since = tr('sessions.signedInSince', {
      date: fmtDate(_parseServerDate(s.created_at)),
    });
    list.appendChild(
      _recordRow({
        name: device,
        meta: [s.current ? tr('sessions.current') : '', lastActive, since],
        // The current session ends via the regular logout row above —
        // no revoke action here avoids an accidental self-logout.
        actions: s.current
          ? []
          : [
              {
                label: tr('sessions.revoke'),
                ariaLabel: `${tr('sessions.revoke')}: ${device}`,
                destructive: true,
                action: 'revokeSessionById',
                args: [s.id],
              },
            ],
      }),
    );
  });
}

async function revokeSessionById(id) {
  const ok = await confirmAction({
    title: tr('sessions.revokeTitle'),
    message: tr('sessions.revokeBody'),
    confirmLabel: tr('sessions.revoke'),
  });
  if (!ok) return;
  try {
    await api('DELETE', '/auth/sessions/' + id);
    await loadSessions();
  } catch (_) {
    toast(tr('common.actionFailed'), 'error');
  }
}

async function revokeOtherSessions() {
  const ok = await confirmAction({
    title: tr('sessions.revokeOthersTitle'),
    message: tr('sessions.revokeOthersBody'),
    confirmLabel: tr('sessions.revokeOthers'),
  });
  if (!ok) return;
  try {
    const r = await api('DELETE', '/auth/sessions');
    const n = (r && r.revoked) || 0;
    toast(
      n === 0
        ? tr('sessions.revokedNone')
        : n === 1
          ? tr('sessions.revokedOne')
          : tr('sessions.revokedMany', { n }),
    );
    await loadSessions();
  } catch (_) {
    toast(tr('common.actionFailed'), 'error');
  }
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
  // The app's own confirm sheet, like every other destructive row (the
  // browser's confirm() looked foreign and ignored the theme).
  const ok = await confirmAction({
    title: tr('apiKeys.revokeConfirm', { name }),
    confirmLabel: tr('apiKeys.revoke'),
  });
  if (!ok) return;
  try {
    await api('DELETE', '/api-keys/' + id);
    await loadApiKeys();
  } catch (_) {
    toast(tr('common.actionFailed'), 'error');
  }
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
// Best-effort detection. UA strings are notoriously unreliable — these
// values are meant exclusively for the debug display, never as logic
// switches.
function _detectPlatform() {
  const ua = navigator.userAgent || '';
  const touch = navigator.maxTouchPoints || 0;
  const fmt = (a, b, c) => `${a}.${b}${c ? '.' + c : ''}`;
  let m;
  // Apple now caps OS versions in all browser UAs (macOS at 10_15_7
  // since Safari 14, iPadOS exposes nothing at all in its desktop
  // spoof, and since iOS 26 the iPhone UA freezes at "18_x" too). So:
  // platform name only, everywhere.
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && touch > 1)) return 'iPad';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/Android/.test(ua)) {
    const v = ua.match(/Android (\d+(?:\.\d+)*)/);
    // The model sits after the second semicolon and before ' Build/' or ')'.
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
  // Alternative iOS browsers are all WebKit but can be identified by
  // their vendor-specific token — important before the Safari match.
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
  // iOS Safari uses the non-standard navigator.standalone flag instead
  // of display-mode, to this day.
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

// Every renderInfoPanel invocation gets a sequence number; async
// responses (backend version, health probe) only overwrite the DOM if
// they still belong to the current pass. Prevents an old, slow response
// from overwriting a newer state when the user opens the panel twice in
// quick succession. Seq lives in appState.nav.infoPanelSeq.

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
  // Approximate browser zoom from outerWidth/innerWidth. On macOS
  // Safari/Firefox the window chrome counts in slightly, hence rounding.
  // visualViewport.scale captures pinch zoom on touch devices.
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

  // Backend health probe — more honest than navigator.onLine, which only
  // says whether some network interface exists. Runs only when the panel
  // opens (no polling) and only if the browser reports online at all —
  // otherwise the fetch would certainly be wasted.
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

  // Backend version — without the api() helper since /api/version is
  // public and needs no auth header. A direct fetch also avoids the SW
  // outbox queueing a write operation while offline.
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

// ── LOGOUT + ACCOUNT ──────────────────────────────────────────────────────────
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
  _clearSessionHint();
  try {
    if (navigator.serviceWorker?.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'CLEAR_API_CACHE' });
    }
  } catch (_) {}
  location.reload();
}

// ── CHANGE PASSWORD (self-service) ────────────────────────────────────────────
function openChangePasswordModal() {
  document.getElementById('pwModalCurrent').value = '';
  document.getElementById('pwModalNew').value = '';
  document.getElementById('pwModalConfirm').value = '';
  _setAuthError('pwModalError', '');
  document.getElementById('pwModalOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
  focusOnOpen(document.getElementById('pwModalOverlay'), 'pwModalCurrent', 50);
}
function closePwModal() {
  document.getElementById('pwModalOverlay').classList.remove('open');
  if (!document.getElementById('drawer').classList.contains('open')) {
    document.body.style.overflow = '';
  }
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
    // Other sessions are killed server-side — this one stays active.
    // Toast is confirmation only.
    toast(tr('pwd.changed'), 'ok');
  } catch (e) {
    _setAuthError('pwModalError', tr('common.connectionFailed'));
  }
}

// ── ADMIN: USER MANAGEMENT ────────────────────────────────────────────────────
// Admin user list + current "me" live in appState.admin (state.js).

async function loadAdminUsers() {
  const list = document.getElementById('adminUserList');
  if (!list) return;
  _recordEmpty(list, tr('common.loading'));
  try {
    appState.admin.users = await api('GET', '/admin/users');
  } catch (e) {
    _recordEmpty(list, tr('users.loadFailed'));
    return;
  }
  // Re-fetch the current identity in case the body flag is stale.
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
    _recordEmpty(list, tr('users.none'));
    return;
  }
  // appState.admin.me MUST be set, otherwise the UI cannot enforce its
  // self-protection rules (buttons would look actionable on the user's
  // own row even though the backend 400/403s them). Better to show a
  // render error than a UI lie.
  if (!appState.admin.me || appState.admin.me.id == null) {
    _recordEmpty(list, tr('users.noIdentity'));
    return;
  }
  const meId = appState.admin.me.id;
  list.innerHTML = '';
  appState.admin.users.forEach((u) => {
    const isSelf = u.id === meId;
    const flags = [];
    if (u.is_admin) flags.push(tr('users.tagAdmin'));
    if (!u.is_active) flags.push(tr('users.tagInactive'));
    if (u.force_change_password) flags.push(tr('users.pwPending'));
    const actions = [{ label: tr('users.resetPw'), action: 'openAdminResetPwModal', args: [u.id] }];
    // Your own row offers only what you may do to yourself; the backend
    // refuses self-deactivation and self-deletion anyway (iOS omits an
    // unavailable action rather than greying it out).
    if (!u.is_admin && !isSelf) {
      actions.push(
        u.is_active
          ? { label: tr('users.deactivate'), action: 'adminToggleActive', args: [u.id, false] }
          : { label: tr('users.reactivate'), action: 'adminToggleActive', args: [u.id, true] },
      );
    }
    if (!isSelf) {
      actions.push({
        label: tr('common.delete'),
        destructive: true,
        action: 'adminDeleteUserConfirm',
        args: [u.id],
      });
    }
    list.appendChild(
      _recordRow({
        name: u.username + (isSelf ? tr('users.selfSuffix') : ''),
        meta: [flags.join(' · ')],
        actions,
        stacked: true,
      }),
    );
  });
}

function openAdminCreateUserModal() {
  document.getElementById('adminCreateUsername').value = '';
  document.getElementById('adminCreatePassword').value = '';
  _setAuthError('adminCreateError', '');
  document.getElementById('adminCreateUserOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
  focusOnOpen(document.getElementById('adminCreateUserOverlay'), 'adminCreateUsername', 50);
}
function closeAdminCreateUserModal() {
  document.getElementById('adminCreateUserOverlay').classList.remove('open');
  if (!document.getElementById('drawer').classList.contains('open')) {
    document.body.style.overflow = '';
  }
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
  focusOnOpen(document.getElementById('adminResetPwOverlay'), 'adminResetPwInput', 50);
}
function closeAdminResetPwModal() {
  document.getElementById('adminResetPwOverlay').classList.remove('open');
  if (!document.getElementById('drawer').classList.contains('open')) {
    document.body.style.overflow = '';
  }
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
