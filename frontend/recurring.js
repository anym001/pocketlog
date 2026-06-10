// Recurring rules editor incl. the live next-booking preview (mirrors
// backend recurring date math). Classic script — see index.html for load order.

// ── RECURRING (recurring bookings) ────────────────────────────────────────────
// Rules are templates; the backend auto-materializes due
// occurrences into the transactions table on every /auth/me
// and /transactions read. The view here only manages the
// template + skip list. New rows pop into the regular
// transactions list with a small clockwise badge.

// Recurring rules list + edit-modal draft live in appState.recurring (state.js).

async function loadRecurringRules() {
  try {
    appState.recurring.rules = await api('GET', '/recurring');
  } catch (e) {
    appState.recurring.rules = [];
  }
}

const _RECURRING_WEEKDAY_KEYS = [
  'recurring.weekdays.mon',
  'recurring.weekdays.tue',
  'recurring.weekdays.wed',
  'recurring.weekdays.thu',
  'recurring.weekdays.fri',
  'recurring.weekdays.sat',
  'recurring.weekdays.sun',
];

function _recurringSummary(rule) {
  // For interval=1 use a separate key per frequency
  // (recurring.summary.monthlyOne = "Monatlich am Tag 15") so
  // the German rendering doesn't say „Alle 1 Monate" and the
  // English doesn't say "Every 1 month(s)".
  const n = rule.interval || 1;
  const suffix = n === 1 ? 'One' : '';
  const key = 'recurring.summary.' + rule.frequency + suffix;
  const params = { n };
  if (rule.frequency === 'weekly') {
    const wd = rule.weekday == null ? 0 : Number(rule.weekday);
    params.weekday = tr(_RECURRING_WEEKDAY_KEYS[wd] || _RECURRING_WEEKDAY_KEYS[0]);
  } else if (rule.frequency !== 'daily') {
    params.day = rule.day_of_month || 1;
  }
  return tr(key, params);
}

function _recurringFormatDate(iso) {
  if (!iso) return '';
  try {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(_locale(), {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch (e) {
    return iso;
  }
}

// ---- Live "next booking" preview (mirrors backend recurring.py) ----
// Interval-independent, anchored at max(today, start_date) so it
// matches the cursor the backend recomputes on save. The pure schedule
// math (_recurringFirstOnOrAfter, _recurringNextOccurrence, _recurringCmp
// and friends) lives in utils.js (loaded before this file).
// The next booking that will actually happen: walk the schedule from
// the start date through its rhythm (interval-aware) until the first
// occurrence after today — exactly what create + catch-up produce —
// then apply the end-date / count limit. Returns an ISO date or null.
function _recurringComputeNextPreview(f) {
  if (!f.startDate) return null;
  const [sy, sm, sd] = f.startDate.split('-').map(Number);
  const now = new Date();
  const today = { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() };
  let cur = _recurringFirstOnOrAfter(f.frequency, { y: sy, m: sm, d: sd }, f.weekday, f.dayOfMonth);
  let count = 0;
  let guard = 0;
  while (cur && _recurringCmp(cur, today) <= 0 && guard++ < 5000) {
    count += 1;
    if (f.maxOccurrences && count >= f.maxOccurrences) {
      cur = null;
      break;
    }
    cur = _recurringNextOccurrence(f.frequency, f.interval, cur, f.weekday, f.dayOfMonth);
  }
  if (cur && f.endDate) {
    const [ey, em, ed] = f.endDate.split('-').map(Number);
    if (_recurringCmp(cur, { y: ey, m: em, d: ed }) > 0) cur = null;
  }
  if (!cur) return null;
  const mm = String(cur.m).padStart(2, '0');
  const dd = String(cur.d).padStart(2, '0');
  return `${cur.y}-${mm}-${dd}`;
}
// Recompute the status hint live from the current form inputs.
// Paused (editing an inactive rule) takes precedence over the date.
function _refreshRecurringPreview() {
  const line = document.getElementById('recEditStatusHint');
  const btn = document.getElementById('recSkipNextBtn');
  if (!line) return;
  const f = _recurringPayloadFromForm();
  if (!f.active) {
    line.textContent = tr('recurring.pausedHint');
    line.hidden = false;
    if (btn) btn.disabled = true;
    return;
  }
  if (!f.startDate) {
    line.hidden = true;
    return;
  }
  const nextIso = _recurringComputeNextPreview(f);
  line.textContent = nextIso
    ? tr('recurring.nextRun', { date: _recurringFormatDate(nextIso) })
    : tr('recurring.nextRunNone');
  line.hidden = false;
  // Restore skip button to server-cursor state when toggling back to active.
  if (btn && appState.recurring.editingId) {
    const cur = appState.recurring.rules.find((x) => x.id === appState.recurring.editingId);
    btn.disabled = !cur?.next_occurrence_date;
  }
}

async function renderRecurringView() {
  const el = document.getElementById('recurringViewList');
  if (!el) return;
  if (!appState.recurring.rules.length) {
    el.innerHTML = `<div class="empty-state"><svg class="cat-glyph goals-empty-glyph" aria-hidden="true"><use href="#icon-arrows-clockwise"/></svg><p>${tr('recurring.emptyView')}<br>${tr('recurring.emptyViewHint')}</p></div>`;
    return;
  }
  const sorted = [...appState.recurring.rules].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return a.name.localeCompare(b.name, _locale(), { sensitivity: 'base' });
  });
  el.innerHTML = sorted
    .map((r) => {
      const summary = _recurringSummary(r);
      // Use server cursor when available (exact, honours skips); fall back to
      // the schedule walk so active rules with a future start date always
      // show a date rather than the "Pausiert" fallback text.
      const _nextDate =
        r.next_occurrence_date ||
        (r.active
          ? _recurringComputeNextPreview({
              frequency: r.frequency,
              interval: r.interval,
              weekday: r.weekday,
              dayOfMonth: r.day_of_month,
              startDate: r.start_date,
              endDate: r.end_date,
              maxOccurrences: r.max_occurrences,
              active: true,
            })
          : null);
      const statusLine =
        r.active && _nextDate
          ? tr('recurring.nextRunCard', { date: _recurringFormatDate(_nextDate) })
          : tr('recurring.inactive');
      // No +/− sign — the colour (green income / red expense) carries
      // the direction, matching the ledger summary cards.
      const amount = fmtCurrency(Math.abs(r.amount));
      const inactiveCls = r.active ? '' : ' is-inactive';
      const cat = appState.ledger.categories.find((c) => c.id === r.category_id);
      const catColor = cat?.color || 'var(--accent)';
      return `<div class="recurring-card${inactiveCls}">
              <button type="button" class="recurring-card-main"
                aria-label="${_escAttr(r.name)}"
                onclick="openRecurringModal(${r.id})">
                <span class="recurring-card-icon" style="--cat-color:${_escAttr(catColor)}" aria-hidden="true">
                  ${catIconSvg(cat?.icon)}
                </span>
                <span class="recurring-card-body">
                  <span class="recurring-card-name">${_escText(r.name)}</span>
                  <span class="recurring-card-sub">${_escText(summary)}</span>
                  <span class="recurring-card-sub">${_escText(statusLine)}</span>
                </span>
                <span class="recurring-card-amount ${r.type}">${amount}</span>
              </button>
            </div>`;
    })
    .join('');
}

function populateRecurringCategorySelect(selectedId) {
  const sel = document.getElementById('recEditCategory');
  if (sel) _populateCategorySelect(sel, selectedId);
}

// Validity is a single choice (unlimited / date / count). Toggling
// it shows exactly one of the end-date / max-occurrences fields and
// keeps the .segmented tabs in sync. The save path maps the active
// kind to a payload where end_date and max_occurrences are mutually
// exclusive.
function setRecurringValidity(kind) {
  appState.recurring.validity = kind;
  document.querySelectorAll('#recValidityTabs button').forEach((b) => {
    const active = b.dataset.kind === kind;
    b.setAttribute('aria-selected', String(active));
    b.classList.toggle('is-active', active);
  });
  document.getElementById('recEditEndDateGroup').hidden = kind !== 'date';
  document.getElementById('recEditMaxGroup').hidden = kind !== 'count';
  _refreshRecurringPreview();
}

function _renderRecurringSkipsList(rule) {
  const list = document.getElementById('recEditSkipsList');
  if (!list) return;
  const skips = (rule && rule.skips) || [];
  if (!skips.length) {
    // Real <li> instead of a ::after pseudo so screen readers
    // hear the empty-state text. The .is-empty class lets the
    // CSS de-style the row (no separator background, muted).
    list.innerHTML = `<li class="is-empty">${_escText(tr('recurring.skipsEmpty'))}</li>`;
    return;
  }
  list.innerHTML = skips
    .slice()
    .sort()
    .map(
      // ``iso`` comes from RecurringRuleOut.skips (typed
      // ``list[date]``, server-serialized as YYYY-MM-DD), so it
      // is already non-attacker-controlled. _escAttr is
      // defence-in-depth: if the schema ever weakens, this stops
      // an inline JS injection sink in the onclick attribute.
      // counter-clockwise icon (restore) — not trash —
      // because the action is constructive: the skipped
      // occurrence comes back.
      (iso) =>
        `<li>
                <span>${_escText(_recurringFormatDate(iso))}</span>
                <button type="button" aria-label="${_escAttr(tr('recurring.unskip'))}" onclick="unskipRecurringOccurrence('${_escAttr(iso)}')">
                  <svg class="ui-icon" aria-hidden="true"><use href="#icon-arrow-counter-clockwise"/></svg>
                </button>
              </li>`,
    )
    .join('');
}

// Consolidated status line under the start date (edit only). A
// paused rule takes precedence over the next-run date; the skip
// button is only usable when there is a live next occurrence.
function _updateRecurringStatusHint(rule) {
  const line = document.getElementById('recEditStatusHint');
  const btn = document.getElementById('recSkipNextBtn');
  if (!line) return;
  if (rule && rule.active === false) {
    line.textContent = tr('recurring.pausedHint');
    line.hidden = false;
    if (btn) btn.disabled = true;
  } else {
    // Prefer the server cursor (exact, honours skips); fall back to the
    // schedule walk for active rules whose cursor is not yet set
    // (e.g. a future-start rule the catch-up hasn't touched yet).
    const nextIso =
      (rule && rule.next_occurrence_date) ||
      (rule && rule.active
        ? _recurringComputeNextPreview({
            frequency: rule.frequency,
            interval: rule.interval,
            weekday: rule.weekday,
            dayOfMonth: rule.day_of_month,
            startDate: rule.start_date,
            endDate: rule.end_date,
            maxOccurrences: rule.max_occurrences,
            active: true,
          })
        : null);
    line.textContent = nextIso
      ? tr('recurring.nextRun', { date: _recurringFormatDate(nextIso) })
      : tr('recurring.nextRunNone');
    line.hidden = false;
    if (btn) btn.disabled = !rule?.next_occurrence_date;
  }
}

function openRecurringModal(id) {
  if (!appState.ledger.categories.length) {
    toast(tr('recurring.needCategory'), 'error');
    return;
  }
  rememberModalFocus('recurring');
  const deleteBtn = document.getElementById('recDeleteBtn');
  const title = document.getElementById('recurringModalTitle');
  const skipsGroup = document.getElementById('recEditSkipsGroup');
  const today = new Date();
  if (id) {
    const r = appState.recurring.rules.find((x) => x.id === id);
    if (!r) return;
    appState.recurring.editingId = r.id;
    document.getElementById('recEditName').value = r.name || '';
    document.getElementById('recEditType').value = r.type || 'out';
    document.getElementById('recEditAmount').value = _formatAmountInput(Number(r.amount));
    populateRecurringCategorySelect(r.category_id);
    document.getElementById('recEditDescription').value = r.desc || '';
    document.getElementById('recEditFrequency').value = r.frequency;
    document.getElementById('recEditInterval').value = r.interval || 1;
    // The booking day/weekday derive from the start date on save, so
    // no separate weekday / day-of-month inputs are populated here.
    document.getElementById('recEditStartDate').value = r.start_date;
    document.getElementById('recEditEndDate').value = r.end_date || '';
    document.getElementById('recEditMaxOccurrences').value = r.max_occurrences || '';
    // Validity precedence: count > date > unlimited. A legacy rule
    // carrying both collapses to "count" and the other field clears
    // on the next save.
    setRecurringValidity(r.max_occurrences != null ? 'count' : r.end_date ? 'date' : 'unlimited');
    document.getElementById('recEditActive').checked = r.active !== false;
    appState.tagPicker.recurringTags = r.tags ? [...r.tags] : [];
    renderRecurringTagPills();
    title.textContent = tr('recurring.editTitle');
    deleteBtn.style.display = '';
    skipsGroup.hidden = false;
    _updateRecurringStatusHint(r);
    _renderRecurringSkipsList(r);
  } else {
    appState.recurring.editingId = null;
    document.getElementById('recEditName').value = '';
    document.getElementById('recEditType').value = 'out';
    document.getElementById('recEditAmount').value = '';
    populateRecurringCategorySelect(null);
    document.getElementById('recEditDescription').value = '';
    document.getElementById('recEditFrequency').value = 'monthly';
    document.getElementById('recEditInterval').value = 1;
    document.getElementById('recEditStartDate').value = _iso(
      today.getFullYear(),
      today.getMonth(),
      today.getDate(),
    );
    document.getElementById('recEditEndDate').value = '';
    document.getElementById('recEditMaxOccurrences').value = '';
    setRecurringValidity('unlimited');
    document.getElementById('recEditActive').checked = true;
    appState.tagPicker.recurringTags = [];
    renderRecurringTagPills();
    _refreshRecurringPreview();
    title.textContent = tr('recurring.newTitle');
    deleteBtn.style.display = 'none';
    skipsGroup.hidden = true;
  }
  document.getElementById('recurringModalOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
  setTimeout(() => document.getElementById('recEditName').focus(), 200);
  trapFocusIn(document.querySelector('#recurringModalOverlay .modal'), 'recurring');
}

function closeRecurringModal() {
  document.getElementById('recurringModalOverlay').classList.remove('open');
  document.body.style.overflow = '';
  appState.recurring.editingId = null;
  releaseFocusTrap('recurring');
  restoreModalFocus('recurring');
}

function _recurringPayloadFromForm() {
  const name = document.getElementById('recEditName').value.trim();
  const type = document.getElementById('recEditType').value;
  const amount = parseAmount(document.getElementById('recEditAmount').value);
  const categoryId = parseInt(document.getElementById('recEditCategory').value, 10);
  const description = document.getElementById('recEditDescription').value.trim();
  const frequency = document.getElementById('recEditFrequency').value;
  const interval = Math.max(1, parseInt(document.getElementById('recEditInterval').value, 10) || 1);
  const startDate = document.getElementById('recEditStartDate').value;
  const validity = appState.recurring.validity;
  const endDate =
    validity === 'date' ? document.getElementById('recEditEndDate').value || null : null;
  const maxRaw = document.getElementById('recEditMaxOccurrences').value;
  const maxOccurrences = validity === 'count' && maxRaw ? parseInt(maxRaw, 10) : null;
  const active = document.getElementById('recEditActive')?.checked !== false;
  // Derive the booking anchor from the start date: weekday for weekly
  // (JS Sun=0..Sat=6 → backend Mon=0..Sun=6), day-of-month for the
  // month-based frequencies (31 is clamped server-side).
  let weekday = null;
  let dayOfMonth = null;
  if (startDate) {
    const parts = startDate.split('-').map(Number);
    if (frequency === 'weekly') {
      weekday = (new Date(parts[0], parts[1] - 1, parts[2]).getDay() + 6) % 7;
    } else if (frequency !== 'daily') {
      dayOfMonth = parts[2];
    }
  }
  return {
    name,
    type,
    amount,
    categoryId,
    description,
    frequency,
    interval,
    weekday,
    dayOfMonth,
    startDate,
    endDate,
    maxOccurrences,
    active,
    validity,
  };
}

async function saveRecurringEdit() {
  const f = _recurringPayloadFromForm();
  if (!f.name) {
    toast(tr('common.nameRequired'), 'error');
    return;
  }
  if (Number.isNaN(f.amount) || f.amount <= 0) {
    toast(tr('recurring.amountRequired'), 'error');
    return;
  }
  if (!Number.isInteger(f.categoryId)) {
    toast(tr('recurring.categoryRequired'), 'error');
    return;
  }
  if (!f.startDate) {
    toast(tr('tx.amountDateRequired'), 'error');
    return;
  }
  if (f.validity === 'date') {
    if (!f.endDate) {
      toast(tr('recurring.endDateRequired'), 'error');
      return;
    }
    if (f.endDate < f.startDate) {
      toast(tr('recurring.endBeforeStart'), 'error');
      return;
    }
  }
  if (f.validity === 'count' && (!f.maxOccurrences || f.maxOccurrences < 1)) {
    toast(tr('recurring.countRequired'), 'error');
    return;
  }
  const payload = {
    name: f.name,
    type: f.type,
    amount: f.amount.toFixed(2),
    category_id: f.categoryId,
    desc: f.description,
    tags: appState.tagPicker.recurringTags,
    frequency: f.frequency,
    interval: f.interval,
    weekday: f.weekday,
    day_of_month: f.dayOfMonth,
    start_date: f.startDate,
    end_date: f.endDate,
    max_occurrences: f.maxOccurrences,
    active: f.active,
  };
  try {
    if (appState.recurring.editingId) {
      await api('PUT', `/recurring/${appState.recurring.editingId}`, payload);
    } else {
      const created = await api('POST', '/recurring', payload);
      const count = created && created.materialized_count;
      if (count > 0) {
        // Same wording as the startup catch-up toast: a backdated rule
        // materializes its past bookings server-side on create.
        toast(
          count === 1
            ? tr('recurring.materializedBannerOne')
            : tr('recurring.materializedBanner', { count }),
        );
      }
    }
    closeRecurringModal();
    await loadRecurringRules();
    if (appState.nav.activePanel === 'recurring') await renderRecurringView();
    // Re-fetch the ledger right away: a backdated create materializes
    // its past bookings server-side in the same request, and the GET
    // also runs the catch-up, so the new rows are visible immediately
    // instead of only on the next app open.
    _invalidateLocalTxCache();
    await loadAndRender();
  } catch (e) {
    const msg = e && e.message ? e.message : '';
    if (msg.includes('409')) {
      toast(tr('recurring.duplicateName'), 'error');
    } else if (msg.includes('422')) {
      toast(tr('recurring.saveFailed'), 'error');
    } else {
      toast(tr('recurring.saveFailed') + ' ' + msg, 'error');
    }
  }
}

async function deleteRecurringEdit() {
  if (!appState.recurring.editingId) return;
  const ok = await confirmAction({
    title: tr('recurring.deleteConfirm'),
    message: tr('recurring.deleteBody'),
    confirmLabel: tr('common.delete'),
  });
  if (!ok) return;
  try {
    await api('DELETE', `/recurring/${appState.recurring.editingId}`);
    closeRecurringModal();
    await loadRecurringRules();
    if (appState.nav.activePanel === 'recurring') await renderRecurringView();
    _invalidateLocalTxCache();
  } catch (e) {
    toast(tr('tx.deleteFailed') + e.message, 'error');
  }
}

async function skipNextRecurringOccurrence() {
  if (!appState.recurring.editingId) return;
  try {
    const res = await api('POST', `/recurring/${appState.recurring.editingId}/skip-next`);
    if (res && res.skipped_date) {
      toast(tr('recurring.skipNextDone', { date: _recurringFormatDate(res.skipped_date) }));
    }
    await loadRecurringRules();
    const refreshed = appState.recurring.rules.find((x) => x.id === appState.recurring.editingId);
    _updateRecurringStatusHint(refreshed);
    _renderRecurringSkipsList(refreshed);
    if (appState.nav.activePanel === 'recurring') await renderRecurringView();
  } catch (e) {
    toast(tr('recurring.skipNextFailed'), 'error');
  }
}

async function unskipRecurringOccurrence(iso) {
  if (!appState.recurring.editingId || !iso) return;
  try {
    await api('DELETE', `/recurring/${appState.recurring.editingId}/skip/${iso}`);
    await loadRecurringRules();
    const refreshed = appState.recurring.rules.find((x) => x.id === appState.recurring.editingId);
    _renderRecurringSkipsList(refreshed);
  } catch (e) {
    toast(tr('recurring.unskipFailed'), 'error');
  }
}

function _invalidateLocalTxCache() {
  // Tells the next switch to the transactions panel to refetch.
  // The codebase uses different names in different builds; both
  // assignments are no-ops if the variable doesn't exist.
  try {
    appState.ledger.transactions = [];
  } catch (_) {}
  try {
    appState.ledger.all = null;
  } catch (_) {}
  // Also clear the per-year report aggregate cache. api() does
  // this automatically on every non-GET, but the outbox replay
  // path skips api() — without this the reports view would
  // render stale aggregates after a rule materialized rows
  // during a background sync.
  try {
    invalidateReportCache();
  } catch (_) {}
}
