// Ledger view: transaction loading/normalisation, list rendering and
// swipe-to-delete. Classic script — see index.html for load order.

// ── LOAD & RENDER ─────────────────────────────────────────────────────────────
function normalizeTx(t) {
  // Tags come pre-resolved from the server (M2M-backed since
  // 0008_transaction_tags) — each name is the canonical row in
  // the tags table, so no client-side casing fix-up is needed.
  return { ...t, amount: Number(t.amount), tags: (t.tags || []).slice() };
}

async function loadAndRender() {
  document.getElementById('monthLabelText').textContent =
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
  document.getElementById('monthLabelText').textContent =
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
  // Filter core lives in utils.js (_filterTransactions, unit-tested); the
  // category-name lookup is passed in so the helper stays app-state-free.
  const filtered = _filterTransactions(
    pool,
    { query: q, categoryFilterId: catFilter, tagFilterName: tagFilter },
    (id) => getCatById(id).name,
  );
  renderTransactions(filtered, document.getElementById('searchResultsList'));
}

async function _setSearchPanelActive(active) {
  const fab = document.querySelector('.fab');
  if (active) {
    document.body.classList.add('searching');
    // The search panel is chrome-less (no PANELS bodyClass). When entered via a
    // report drill-down, a lingering in-report/on-goals/… class would keep
    // .bottom-bar hidden — and with it the search-exit FAB *and* the selection
    // bar. Strip them so the bottom bar shows; clearSearch() restores the origin
    // panel's chrome via showPanel(searchExitTarget).
    for (const cfg of Object.values(PANELS)) {
      if (cfg.bodyClass) document.body.classList.remove(cfg.bodyClass);
    }
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
  // Track what's on screen so "Select all" and the selection re-render after a
  // search/filter change operate on the currently visible rows.
  appState.selection.visibleIds = txs.map((t) => t.id);
  el.classList.toggle('selecting', appState.selection.active);
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
            const selCls = appState.selection.ids.includes(t.id) ? ' selected' : '';
            return `<div class="tx-row${selCls}" data-id="${t.id}">
        <button class="tx-action" type="button" aria-label="${_escAttr(tr('tx.deleteAria'))}">${tr('common.delete')}</button>
        <div class="transaction">
          <span class="tx-select-check" aria-hidden="true"><svg class="ui-icon"><use href="#icon-check"/></svg></span>
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
const SWIPE_OPEN_THRESHOLD = 40; // pixels beyond which the action snaps open
const TAP_TOLERANCE = 6; // pixel slop below which a pointer-down counts as a tap
const LONG_PRESS_MS = 500; // hold duration that enters multi-select mode

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
      openOnStart = false,
      moved = false, // moved past the tap slop (any axis) — used in select mode
      longPressTimer = null, // pending "enter multi-select" timer
      longPressFired = false; // the timer already toggled this row's selection

    const cancelLongPress = () => {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    };

    inner.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      startX = e.clientX;
      startY = e.clientY;
      dx = 0;
      dragging = true;
      moved = false;
      committedAxis = null;
      longPressFired = false;
      openOnStart = row.classList.contains('swiped');
      row.classList.add('dragging');
      try {
        inner.setPointerCapture(e.pointerId);
      } catch (_) {}
      // A long press on a normal (not-yet-swiped) row starts multi-select.
      // Already in select mode? Then a press is just a tap-to-toggle, no timer.
      if (!appState.selection.active && !openOnStart) {
        longPressTimer = setTimeout(() => {
          longPressTimer = null;
          longPressFired = true;
          if (navigator.vibrate) {
            try {
              navigator.vibrate(15);
            } catch (_) {}
          }
          enterSelectionMode();
          toggleSelect(Number(row.dataset.id));
        }, LONG_PRESS_MS);
      }
    });

    inner.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const rawDx = e.clientX - startX;
      const rawDy = e.clientY - startY;
      if (Math.abs(rawDx) >= 8 || Math.abs(rawDy) >= 8) {
        moved = true;
        cancelLongPress(); // any real movement aborts the long-press
      }
      // In select mode the row never swipes; movement only decides tap-vs-not.
      if (appState.selection.active) return;
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
      cancelLongPress();
      row.classList.remove('dragging');
      inner.style.transform = '';

      // The long-press handler already entered select mode and toggled
      // this row — don't let the trailing pointerup toggle it back.
      if (longPressFired) return;

      if (cancelled) {
        // Cancelled by the browser (e.g. vertical scroll): leave the state alone
        return;
      }

      // Multi-select mode: a clean tap toggles the row, nothing swipes.
      if (appState.selection.active) {
        if (!moved) toggleSelect(Number(row.dataset.id));
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
          // Remove optimistically, the SW handles the sync
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

// A tap outside an open row closes it again.
// Single global listener (not re-registered per render).
document.addEventListener(
  'pointerdown',
  (e) => {
    if (!e.target.closest('.tx-row')) closeAllSwipes();
  },
  { capture: true },
);

// ── MULTI-SELECT / BULK EDIT ──────────────────────────────────────────────────
// Long-press a ledger row to enter select mode (attachSwipeHandlers), then tap
// to mark more. The selection bar (index.html) drives the four bulk actions,
// each funnelling through bulkApply() → POST /api/transactions/bulk.

function enterSelectionMode() {
  if (appState.selection.active) return;
  appState.selection.active = true;
  appState.selection.ids = [];
  document.body.classList.add('selecting');
  closeAllSwipes();
  applySearch(); // re-render the active list with the select affordance
  updateSelectionBar();
}

function exitSelectionMode() {
  if (!appState.selection.active) return;
  appState.selection.active = false;
  appState.selection.ids = [];
  document.body.classList.remove('selecting');
  applySearch();
  updateSelectionBar();
}

function toggleSelect(id) {
  id = Number(id);
  const i = appState.selection.ids.indexOf(id);
  if (i >= 0) appState.selection.ids.splice(i, 1);
  else appState.selection.ids.push(id);
  // Targeted DOM update keeps tapping snappy — no full list re-render per tap.
  const sel = appState.selection.ids.includes(id);
  document.querySelectorAll(`.tx-row[data-id="${id}"]`).forEach((row) => {
    row.classList.toggle('selected', sel);
  });
  updateSelectionBar();
}

function toggleSelectAll() {
  const vis = appState.selection.visibleIds;
  const allSelected = vis.length > 0 && vis.every((id) => appState.selection.ids.includes(id));
  appState.selection.ids = allSelected ? [] : [...vis];
  applySearch();
  updateSelectionBar();
}

function updateSelectionBar() {
  const n = appState.selection.ids.length;
  const countEl = document.getElementById('selectionCount');
  if (countEl) countEl.textContent = tr('selection.count', { n });
  const vis = appState.selection.visibleIds;
  const allSelected = vis.length > 0 && vis.every((id) => appState.selection.ids.includes(id));
  const allBtn = document.getElementById('selectionAllBtn');
  if (allBtn)
    allBtn.textContent = allSelected ? tr('selection.deselectAll') : tr('selection.selectAll');
  // Actions need at least one marked row.
  document
    .querySelectorAll('.selection-bar [data-bulk-action]')
    .forEach((b) => (b.disabled = n === 0));
}

// Mutate the in-memory pools to mirror a bulk op locally — used only on the
// offline path, so the list reflects the queued change before the SW replays it.
function _applyBulkLocally(body) {
  const idset = new Set(body.ids);
  const apply = (pool) => {
    if (!pool) return pool;
    if (body.action === 'delete') return pool.filter((t) => !idset.has(t.id));
    pool.forEach((t) => {
      if (!idset.has(t.id)) return;
      if (body.action === 'set_category') {
        t.category_id = body.category_id;
      } else if (body.action === 'add_tags') {
        const lower = new Set((t.tags || []).map((x) => x.toLowerCase()));
        body.tags.forEach((tag) => {
          if (!lower.has(tag.toLowerCase())) {
            t.tags.push(tag);
            lower.add(tag.toLowerCase());
          }
        });
      } else if (body.action === 'remove_tags') {
        const rm = new Set(body.tags.map((x) => x.toLowerCase()));
        t.tags = (t.tags || []).filter((x) => !rm.has(x.toLowerCase()));
      }
    });
    return pool;
  };
  appState.ledger.transactions = apply(appState.ledger.transactions);
  if (appState.ledger.all) appState.ledger.all = apply(appState.ledger.all);
}

async function bulkApply(op) {
  const ids = appState.selection.ids.slice();
  if (!ids.length) return;
  const body = { ...op, ids };
  try {
    const res = await api('POST', '/transactions/bulk', body);
    const n = res && typeof res.updated === 'number' ? res.updated : ids.length;
    exitSelectionMode();
    const tasks = [loadAndRender()];
    if (op.action === 'add_tags' || op.action === 'remove_tags') tasks.push(loadTags());
    await Promise.all(tasks);
    toast(tr(`selection.applied.${op.action}`, { n }));
  } catch (e) {
    if (!navigator.onLine && window.PocketLogOutbox) {
      await window.PocketLogOutbox.enqueue({
        method: 'POST',
        path: '/transactions/bulk',
        body,
      });
      _applyBulkLocally(body);
      exitSelectionMode();
      renderAll();
      updateSyncBadge();
      toast(tr('selection.queuedOffline'));
      return;
    }
    toast(tr('selection.failed') + (e.message || ''), 'error');
  }
}

async function bulkDelete() {
  const n = appState.selection.ids.length;
  if (!n) return;
  const ok = await confirmAction({
    title: tr('selection.deleteConfirm', { n }),
    confirmLabel: tr('common.delete'),
    destructive: true,
  });
  if (!ok) return;
  bulkApply({ action: 'delete' });
}

function openBulkCategory() {
  if (!appState.selection.ids.length) return;
  rememberModalFocus('bulkCat');
  _populateCategorySelect(document.getElementById('bulkCatSelect'), null);
  document.getElementById('bulkCatOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
  trapFocusIn(document.querySelector('#bulkCatOverlay .modal'), 'bulkCat');
}

function closeBulkCategory() {
  document.getElementById('bulkCatOverlay').classList.remove('open');
  document.body.style.overflow = '';
  releaseFocusTrap('bulkCat');
  restoreModalFocus('bulkCat');
}

function commitBulkCategory() {
  const catId = parseInt(document.getElementById('bulkCatSelect').value, 10);
  closeBulkCategory();
  if (!catId) return;
  bulkApply({ action: 'set_category', category_id: catId });
}

function openBulkAddTags() {
  if (!appState.selection.ids.length) return;
  openTagPickerFor('bulkAdd');
}

function openBulkRemoveTags() {
  if (!appState.selection.ids.length) return;
  // The remove picker offers only the tags actually present on the marked
  // rows (the union), so there's never a no-op chip to pick.
  const idset = new Set(appState.selection.ids);
  const pool = appState.ledger.all || appState.ledger.transactions;
  const seen = new Map();
  pool.forEach((t) => {
    if (!idset.has(t.id)) return;
    (t.tags || []).forEach((tg) => {
      const k = tg.toLowerCase();
      if (!seen.has(k)) seen.set(k, tg);
    });
  });
  const union = [...seen.values()].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' }),
  );
  if (!union.length) {
    toast(tr('selection.noTagsToRemove'));
    return;
  }
  appState.tagPicker.bulkRemovePool = union;
  openTagPickerFor('bulkRemove');
}
