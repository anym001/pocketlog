// Goals: savings goals + debt trackers (progress derived in the frontend,
// never affects ledger totals). Classic script — see index.html for load order.

// ── GOALS (savings goals + debt trackers) ─────────────────────────────────────
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
  if (sel) _populateCategorySelect(sel, selectedId);
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
  document.getElementById('goalEditColors').innerHTML = _colorSwatchesMarkup(
    appState.goals.editingColor,
    'pickGoalColor',
  );
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
  openModalShell('goal', 'goalModalOverlay', 'goalEditName');
}

function closeGoalModal() {
  appState.goals.editingId = null;
  closeModalShell('goal', 'goalModalOverlay');
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
