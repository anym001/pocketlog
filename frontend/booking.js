// Booking modal: the create/edit transaction form.
// Classic script — see index.html for load order.

// ── MODAL ─────────────────────────────────────────────────────────────────────
// Category <select> filler shared by the booking, goal and recurring editors.
// Alphabetical locale sort — consistent with renderCategories() and
// renderCategoryView() so the user sees the same order wherever they look at
// categories. Falls back to the alphabetically first option when no valid
// category is requested (e.g. creating), so the preselection matches the top
// of the list rather than the unsorted seed order.
function _populateCategorySelect(sel, selectedId) {
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

function openModal(tx) {
  rememberModalFocus('booking');
  appState.form.tags = tx?.tags ? tx.tags.slice() : [];
  document.getElementById('inputAmount').value =
    tx?.amount != null ? _formatAmountInput(Number(tx.amount)) : '';
  document.getElementById('inputDesc').value = tx?.desc || '';
  document.getElementById('inputDate').value = tx?.date || new Date().toISOString().split('T')[0];
  _populateCategorySelect(document.getElementById('inputCat'), tx ? tx.category_id : null);
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
// Backdrop dismiss shared by every modal overlay: the overlay's inline
// onclick passes its own event, so the click counts as "outside" exactly
// when it landed on the overlay itself rather than the dialog inside it.
function closeOnBackdrop(e, closeFn) {
  if (e.target === e.currentTarget) closeFn();
}
// Ledger rows open this modal on `pointerup` (the swipe handler).
// The browser then synthesizes a trailing `click` at the same spot,
// which now lands on the freshly shown overlay backdrop and would
// close the modal immediately (the "flicker, nothing happens, second
// tap works" bug). Ignore backdrop clicks for a brief window after
// opening so only a deliberate later tap dismisses it.
function closeModalOutside(e) {
  if (Date.now() - appState.nav.bookingModalOpenedAt < 400) return;
  closeOnBackdrop(e, closeModal);
}
function editTransaction(id) {
  const num = Number(id);
  const pools = [appState.ledger.all, appState.reports.txPool, appState.ledger.transactions];
  for (const p of pools) {
    if (!p) continue;
    const t = p.find((t) => t.id === num);
    if (t) return openModal(t);
  }
  // If the TX is in no pool (e.g. it was just removed by a sync): don't
  // silently open the create form — show a notice.
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

// The amount field is type="text" so iOS shows the decimal keypad. The
// locale-aware parsing/formatting cores (_parseAmountWith/_formatAmountWith)
// live in utils.js; these wrappers only supply the I18N decimal separator.
function parseAmount(raw) {
  return _parseAmountWith(raw, window.I18N ? I18N.decimalSeparator() : ',');
}

// Display the amount in the input with the locale decimal separator
// so it matches the formatted output everywhere else (fmtCurrency).
function _formatAmountInput(n) {
  return _formatAmountWith(n, window.I18N ? I18N.decimalSeparator() : ',');
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
    const result = await api(method, path, body);
    mergeIntoAvailableTags(appState.form.tags);
    closeModal();
    if (result && result.queued) {
      // Offline: the service worker queued the write (HTTP 202) instead of
      // reaching the server. Reloading now would pull the stale API cache and
      // make the save look reverted — so mirror the change into the in-memory
      // pools and re-render. The next sync (SYNC_DONE → loadAndRender)
      // reconciles with the server, replacing the provisional create row.
      _applyTxLocally(method, editId, body);
      renderAll();
      updateSyncBadge();
      toast(tr('tx.queuedOffline'));
      return;
    }
    await Promise.all([loadAndRender(), loadTags()]);
  } catch (e) {
    if (!navigator.onLine && window.PocketLogOutbox) {
      // No active service worker to queue the write — enqueue it ourselves and
      // reflect it locally, same as the 202 path above.
      await window.PocketLogOutbox.enqueue({ method, path, body });
      mergeIntoAvailableTags(appState.form.tags);
      _applyTxLocally(method, editId, body);
      closeModal();
      renderAll();
      updateSyncBadge();
      toast(tr('tx.queuedOffline'));
      return;
    }
    toast(tr('tx.saveFailed') + e.message, 'error');
  }
}

// Mirror a single create/edit into the in-memory transaction pools so an
// offline save shows immediately, before the service worker replays it.
// Mirrors _applyBulkLocally (ledger.js): only the ledger pools are touched —
// the report cache is already invalidated by api() on every non-GET. All
// display fields derive from category_id via getCatById, so updating the raw
// fields is enough.
function _applyTxLocally(method, editId, body) {
  const fields = {
    amount: Number(body.amount),
    desc: body.desc,
    category_id: body.category_id,
    date: body.date,
    type: body.type,
    tags: (body.tags || []).slice(),
  };
  if (method === 'PUT') {
    const id = Number(editId);
    [appState.ledger.transactions, appState.ledger.all].forEach((pool) => {
      if (!pool) return;
      const t = pool.find((x) => x.id === id);
      if (t) Object.assign(t, fields);
    });
    return;
  }
  // Create: there's no server id yet. A negative provisional id keeps the row
  // distinct from real ones until the next sync reload replaces it.
  const tx = { id: -Date.now(), source_rule_id: null, ...fields };
  // The month list is scoped to the displayed month, so only add it there when
  // its date falls in that month; otherwise it would render under a stray date.
  const [y, m] = body.date.split('-').map(Number);
  if (y === appState.view.year && m === appState.view.month + 1) {
    appState.ledger.transactions.push(tx);
  }
  if (appState.ledger.all) appState.ledger.all.push(tx);
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
