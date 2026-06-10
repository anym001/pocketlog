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
