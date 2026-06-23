// Budgets: per-category spending caps (consumption derived in the frontend,
// never affects ledger totals). Classic script — see index.html for load order.

// ── BUDGETS (per-category spending caps) ──────────────────────────────────────
// A budget is a derived view: consumption is the sum of the linked
// category's `out` transactions within the active calendar period — the
// API stores no aggregate. Name/icon/color are inherited from the category
// (1:1). Budget list + edit-modal draft live in appState.budgets (state.js).

const BUDGET_FREQUENCIES = ['monthly', 'quarterly', 'yearly'];

async function loadBudgets() {
  try {
    appState.budgets.list = await api('GET', '/budgets');
  } catch (e) {
    appState.budgets.list = [];
  }
}

// _budgetPeriod() / _budgetUsage() live in reportsData.js (loaded earlier).

// Human label for the active period, e.g. "Juni 2026" / "Q2 2026" / "2026".
function _budgetPeriodLabel(frequency, year, month) {
  if (frequency === 'yearly') return String(year);
  if (frequency === 'quarterly') return `Q${Math.floor(month / 3) + 1} ${year}`;
  const names = appState.calendar.months;
  const name = names && names[month] ? names[month] : String(month + 1);
  return `${name} ${year}`;
}

async function renderBudgetsView() {
  const el = document.getElementById('budgetsViewList');
  if (!el) return;
  if (!appState.budgets.list.length) {
    el.innerHTML = `<div class="empty-state"><svg class="cat-glyph goals-empty-glyph" aria-hidden="true"><use href="#cat-wallet"/></svg><p>${tr('budget.emptyView')}<br>${tr('budget.emptyViewHint')}</p></div>`;
    return;
  }
  // Each budget's period is anchored to the currently-viewed month so the
  // view stays in sync with the ledger's month navigation. Fetch the widest
  // span needed (yearly budgets span the whole year) once, then slice per
  // budget via _budgetUsage's date filter.
  const { year, month } = appState.view;
  const yearStart = _iso(year, 0, 1);
  const yearEnd = _iso(year, 11, 31);
  let pool = [];
  try {
    pool = await loadRangeTxs(yearStart, yearEnd);
  } catch (e) {
    pool = [];
  }
  const cats = appState.ledger.categories;
  const sorted = [...appState.budgets.list].sort((a, b) => {
    const ca = cats.find((c) => c.id === a.category_id);
    const cb = cats.find((c) => c.id === b.category_id);
    return (ca ? ca.name : '').localeCompare(cb ? cb.name : '', _locale(), {
      sensitivity: 'base',
    });
  });
  el.innerHTML = sorted
    .map((b) => {
      const cat = cats.find((c) => c.id === b.category_id) || {
        name: '',
        icon: 'wallet',
        color: '#9e9b96',
      };
      const period = _budgetPeriod(b.frequency, year, month);
      const u = _budgetUsage(b, pool, period.from, period.to);
      const pctLabel = Math.round(u.rawPct) + '%';
      const overClass = u.over ? ' over' : '';
      const primary = _escText(
        tr('budget.spentOf', {
          spent: fmtCurrency(u.spentCents / 100),
          limit: fmtCurrency(u.limitCents / 100),
        }),
      );
      const sub = u.over
        ? _escText(tr('budget.overBy', { amount: fmtCurrency(-u.remainingCents / 100) }))
        : _escText(tr('budget.remaining', { amount: fmtCurrency(u.remainingCents / 100) }));
      const periodLabel = _escText(_budgetPeriodLabel(b.frequency, year, month));
      return `<div class="goal-card budget-card${overClass}" role="button" tabindex="0"
              aria-label="${_escAttr(tr('budget.editAria', { name: cat.name }))}"
              onclick="openBudgetModal(${b.id})"
              onkeydown="handleRowActivate(event, () => openBudgetModal(${b.id}))">
              <div class="goal-card-head">
                <span class="goal-card-icon" style="--cat-color:${cat.color}">${catIconSvg(cat.icon)}</span>
                <span class="goal-card-name">${_escText(cat.name)}</span>
                <span class="budget-card-period">${periodLabel}</span>
              </div>
              <div class="goal-progress-track"><div class="goal-progress-fill" style="width:${u.pct}%"></div></div>
              <div class="goal-card-meta">
                <span class="goal-card-primary">${primary}</span>
                <span class="goal-card-sub">${sub} · ${_escText(pctLabel)}</span>
              </div>
            </div>`;
    })
    .join('');
}

function _budgetAmountValue(id) {
  return parseAmount(document.getElementById(id).value);
}

function populateBudgetCategorySelect(selectedId) {
  const sel = document.getElementById('budgetEditCategory');
  if (sel) _populateCategorySelect(sel, selectedId);
}

function openBudgetModal(id) {
  if (!appState.ledger.categories.length) {
    toast(tr('budget.needCategory'), 'error');
    return;
  }
  const deleteBtn = document.getElementById('budgetDeleteBtn');
  const title = document.getElementById('budgetModalTitle');
  if (id) {
    const b = appState.budgets.list.find((x) => x.id === id);
    if (!b) return;
    appState.budgets.editingId = b.id;
    populateBudgetCategorySelect(b.category_id);
    document.getElementById('budgetEditAmount').value = _formatAmountInput(Number(b.amount));
    document.getElementById('budgetEditFrequency').value = b.frequency;
    title.textContent = tr('budget.editTitle');
    deleteBtn.style.display = '';
  } else {
    appState.budgets.editingId = null;
    populateBudgetCategorySelect(null); // defaults to the first sorted option
    document.getElementById('budgetEditAmount').value = '';
    document.getElementById('budgetEditFrequency').value = 'monthly';
    title.textContent = tr('budget.newTitle');
    deleteBtn.style.display = 'none';
  }
  openModalShell('budget', 'budgetModalOverlay', 'budgetEditAmount');
}

function closeBudgetModal() {
  appState.budgets.editingId = null;
  closeModalShell('budget', 'budgetModalOverlay');
}

async function saveBudgetEdit() {
  const categoryId = parseInt(document.getElementById('budgetEditCategory').value, 10);
  const amount = _budgetAmountValue('budgetEditAmount');
  const frequency = document.getElementById('budgetEditFrequency').value;
  if (!Number.isInteger(categoryId)) {
    toast(tr('budget.needCategory'), 'error');
    return;
  }
  if (Number.isNaN(amount) || amount <= 0) {
    toast(tr('budget.invalidAmount'), 'error');
    return;
  }
  if (BUDGET_FREQUENCIES.indexOf(frequency) === -1) {
    toast(tr('budget.invalidAmount'), 'error');
    return;
  }
  const payload = {
    category_id: categoryId,
    amount: amount.toFixed(2),
    frequency,
  };
  try {
    if (appState.budgets.editingId) {
      await api('PUT', `/budgets/${appState.budgets.editingId}`, payload);
    } else {
      await api('POST', '/budgets', payload);
    }
    closeBudgetModal();
    await loadBudgets();
    if (appState.nav.activePanel === 'budgets') await renderBudgetsView();
  } catch (e) {
    if (e.message && e.message.includes('409')) {
      toast(tr('budget.categoryTaken'), 'error');
    } else if (e.message && e.message.includes('422')) {
      toast(tr('budget.invalidAmount'), 'error');
    } else {
      toast(tr('tx.saveFailed') + e.message, 'error');
    }
  }
}

async function deleteBudgetEdit() {
  if (!appState.budgets.editingId) return;
  const ok = await confirmAction({
    title: tr('budget.deleteConfirm'),
    confirmLabel: tr('common.delete'),
  });
  if (!ok) return;
  try {
    await api('DELETE', `/budgets/${appState.budgets.editingId}`);
    closeBudgetModal();
    await loadBudgets();
    if (appState.nav.activePanel === 'budgets') await renderBudgetsView();
  } catch (e) {
    toast(tr('tx.deleteFailed') + e.message, 'error');
  }
}
