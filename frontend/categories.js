// Category management plus the tag picker and icon picker modals.
// Classic script — see index.html for load order.

// ── CATEGORIES ────────────────────────────────────────────────────────────────
const CAT_CREATE_COLORS = ['#D97757', '#6b7aa1', '#788C5D', '#c47ab0', '#e0a44a', '#87867F'];

async function loadCategories(opts = {}) {
  try {
    appState.ledger.categories = await api('GET', '/categories');
  } catch (e) {
    // Boot uses rethrow to detect the dead-boot case (app.js _loadBootData);
    // every other caller keeps the offline-tolerant empty fallback.
    if (opts.rethrow) throw e;
    appState.ledger.categories = [];
  }
}

async function loadTags() {
  try {
    const tags = await api('GET', '/tags');
    const list = Array.isArray(tags) ? tags : [];
    appState.ledger.availableTags = list.map((t) => (typeof t === 'string' ? t : t.name));
    tagCounts.clear();
    for (const t of list) {
      if (typeof t === 'string') continue;
      tagCounts.set(t.name.toLowerCase(), {
        all: Number(t.count) || 0,
        in: Number(t.count_in) || 0,
        out: Number(t.count_out) || 0,
      });
    }
  } catch (e) {
    appState.ledger.availableTags = [];
    tagCounts.clear();
  }
  renderTagList();
}

// ── TAG CHOOSER ───────────────────────────────────────────────────────────────
// The booking form and the recurring-rule editor pick tags the same way: a
// search field over every tag, and below it a chip row that *is* the
// selection — a chosen tag carries the accent rather than being repeated as a
// pill somewhere else. That is why neither form has a tag field any more, and
// why the picker modal is left to the ledger's bulk actions.
//
// The two contexts differ only in which elements they own and where their
// selection lives.
const TAG_CHOOSERS = {
  transaction: {
    input: 'tagSearch',
    row: 'tagSuggestions',
    hint: 'tagSuggestionsHint',
    read: () => appState.form.tags,
    write: (v) => {
      appState.form.tags = v;
    },
    // The expense/income toggle above the field. Ranking follows it, so
    // switching the toggle reshuffles the chips (see setType).
    type: () => appState.form.type,
  },
  recurring: {
    input: 'recTagSearch',
    row: 'recTagSuggestions',
    hint: 'recTagSuggestionsHint',
    read: () => appState.recurring.tags,
    write: (v) => {
      appState.recurring.tags = v;
    },
    // The rule's own type <select>, read live rather than from state: the
    // editor writes appState.recurring.* only on save.
    type: () => document.getElementById('recEditType')?.value || 'out',
  },
};

// Chips shown with an empty field, and the cap once a query narrows things
// down — enough to be useful, few enough to scan without scrolling the modal.
const TAG_CHOOSER_ROWS = 3; // chip rows shown with an empty field
const TAG_CHOOSER_HITS = 15; // cap while a query narrows things down
// Upper bound on what the row cap gets to choose from. The cap itself is the
// real limit; this only keeps the measured render from ever being huge.
const TAG_CHOOSER_POOL = 24;

const _byTagName = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' });

// How many of the chips currently in `row` sit within its first `rows` lines.
// Chip widths follow the names, so a fixed *count* packs into anything from
// one line to five — which is why both choosers cap by the space they take
// rather than by a number.
function _chipsWithinRows(row, rows) {
  const chips = [...row.children];
  if (!chips.length) return 0;
  const tops = [...new Set(chips.map((c) => c.offsetTop))].sort((a, b) => a - b);
  const allowed = new Set(tops.slice(0, rows));
  return chips.filter((c) => allowed.has(c.offsetTop)).length;
}

// Decide which chips the row shows, and freeze that order into the view
// state. Called when a form opens and whenever the query changes — never on
// toggle. Without that a tap would re-sort the row under the finger and the
// next tap would land on a different tag.
function _rebuildTagChooser(ctx) {
  const chooser = TAG_CHOOSERS[ctx];
  const view = appState.tagChooser[ctx];
  const query = view.query.trim().toLowerCase();
  const all = appState.ledger.availableTags;

  if (query) {
    // Search runs over every tag, not just the frequent ones — that is the
    // whole point of the field replacing the picker.
    const hits = all.filter((t) => t.toLowerCase().includes(query)).sort(_byTagName);
    view.shown = hits.slice(0, TAG_CHOOSER_HITS);
    view.overflow = hits.length - view.shown.length;
    return;
  }

  // Overview: what is already attached comes first, so editing an old entry
  // shows its tags even when none of them are among the frequent ones.
  const chosen = chooser.read();
  const selected = new Set(chosen.map((x) => x.toLowerCase()));
  const type = chooser.type ? chooser.type() : null;
  const rest = all
    .filter((t) => !selected.has(t.toLowerCase()))
    .sort(
      (a, b) =>
        // Most-used for the form's current type first (90-day window, see
        // crud/tags.py), overall use as the tie-break, then by name.
        _compareUsage(_tagUse(a), _tagUse(b), type) || _byTagName(a, b),
    )
    .slice(0, TAG_CHOOSER_POOL);
  // `ranked` is what the row cap cuts from — least-used first out. `shown` is
  // what gets painted, and it stays frozen between rebuilds so a toggle
  // recolours a chip where it stands instead of moving it.
  view.ranked = [...chosen, ...rest];
  view.shown = _tagDisplayOrder(chosen, view.ranked);
  view.overflow = 0; // decided by the row cap, after layout
}

// Position follows the alphabet, membership follows the ranking: a chip does
// not move when usage shifts or the form's type flips. Tags already attached
// to the record keep their own group at the front — they are its state, not a
// suggestion, and the row is the only place they can be taken off again.
function _tagDisplayOrder(chosen, list) {
  const selected = new Set(chosen.map((x) => x.toLowerCase()));
  const on = list.filter((t) => selected.has(t.toLowerCase())).sort(_byTagName);
  const off = list.filter((t) => !selected.has(t.toLowerCase())).sort(_byTagName);
  return [...on, ...off];
}

// Rebuild, paint, then cap — the three steps that together decide what the
// row shows. Kept as one call because the cap re-derives the display order,
// so it must run only where a rebuild already reordered the row. A plain
// renderTagChooser (a toggle, the limit hint) must leave the order alone.
// Search results skip the cap: they carry their own count cap and the user
// asked for exactly them.
function _refreshTagChooser(ctx) {
  _rebuildTagChooser(ctx);
  renderTagChooser(ctx);
  if (!appState.tagChooser[ctx].query.trim()) _capTagChooserRows(ctx);
}

function _tagChipMarkup(ctx, t, chosen) {
  const on = chosen.some((x) => x.toLowerCase() === t.toLowerCase());
  const label = on ? 'tags.removeAria' : 'tags.addSuggestionAria';
  return `<button type="button" class="tag-suggestion${on ? ' is-added' : ''}" data-chooser-tag="${_escAttr(t)}" aria-pressed="${on}" aria-label="${_escAttr(tr(label, { name: t }))}">${_escText(t)}</button>`;
}

function renderTagChooser(ctx) {
  const chooser = TAG_CHOOSERS[ctx];
  const box = document.getElementById(chooser.row);
  if (!box) return;
  const view = appState.tagChooser[ctx];
  const chosen = chooser.read();
  const selected = new Set(chosen.map((x) => x.toLowerCase()));
  const query = _normaliseNewTag(view.query);
  const full = chosen.length >= MAX_TAGS_PER_TX;
  const exact =
    query && appState.ledger.availableTags.some((t) => t.toLowerCase() === query.toLowerCase());

  // Replacing innerHTML drops the focused chip; the row order is frozen, so
  // the same slot still holds the same tag and focus can go straight back.
  const focused = box.contains(document.activeElement)
    ? [...box.children].indexOf(document.activeElement)
    : -1;

  const chips = view.shown.map((t) => _tagChipMarkup(ctx, t, chosen));
  // Offer to make the typed text a tag, so the name is typed once rather than
  // again in a separate create field. It goes last: with matches on screen the
  // likely intent is one of them, and creating "Auto" must stay possible even
  // though "Autobahn" matches. With no matches it is the only chip anyway.
  if (query && !exact && !full) {
    chips.push(
      `<button type="button" class="tag-suggestion tag-create" data-chooser-create="${_escAttr(query)}">${_escText(tr('tags.createChip', { name: query }))}</button>`,
    );
  }
  box.innerHTML = chips.join('');
  _wireTagChips(ctx, box);
  if (focused >= 0) box.children[focused]?.focus();

  const hint = document.getElementById(chooser.hint);
  if (!hint) return;
  const message = full
    ? tr('tags.limitReached', { max: MAX_TAGS_PER_TX })
    : query && !chips.length
      ? tr('tags.searchNone')
      : view.overflow > 0
        ? tr('tags.moreResults', { n: view.overflow })
        : '';
  hint.textContent = message;
  hint.hidden = !message;
}

function _wireTagChips(ctx, box) {
  box.querySelectorAll('[data-chooser-tag]').forEach((el) => {
    el.addEventListener('click', () => toggleTagChooser(ctx, el.dataset.chooserTag));
  });
  box.querySelectorAll('[data-chooser-create]').forEach((el) => {
    el.addEventListener('click', () => createTagFromChooser(ctx, el.dataset.chooserCreate));
  });
}

// Trim the row to TAG_CHOOSER_ROWS. The cut follows the ranking (least-used
// out first) while the row shows the survivors alphabetically, so the two
// orders need two passes: line packing is greedy, and the same chips in
// alphabetical order can wrap one line further than the layout the cut was
// measured on.
//
// Tags already attached to the record are never cut — the row is the only
// place they appear, so cutting one would take away the way to remove it. A
// heavily tagged record is therefore allowed to overrun the cap.
function _capTagChooserRows(ctx) {
  const box = document.getElementById(TAG_CHOOSERS[ctx].row);
  const view = appState.tagChooser[ctx];
  if (!box || box.offsetParent === null || !view.ranked || !view.ranked.length) return;
  const chosen = TAG_CHOOSERS[ctx].read();
  const floor = Math.max(1, chosen.length);
  let keep = Math.max(floor, _chipsWithinRows(box, TAG_CHOOSER_ROWS));
  for (;;) {
    view.shown = _tagDisplayOrder(chosen, view.ranked.slice(0, keep));
    if (keep >= view.ranked.length && keep === _chipsWithinRows(box, TAG_CHOOSER_ROWS)) return;
    box.innerHTML = view.shown.map((t) => _tagChipMarkup(ctx, t, chosen)).join('');
    _wireTagChips(ctx, box);
    if (keep <= floor || _chipsWithinRows(box, TAG_CHOOSER_ROWS) === view.shown.length) return;
    keep -= 1;
  }
}

// Re-measure a tag row once its modal is actually on screen — the booking and
// recurring forms fill their choosers before the modal is shown, and an
// unlaid-out row cannot be measured. Mirrors remeasureCatChooser.
function remeasureTagChooser(ctx) {
  if (!appState.tagChooser[ctx] || appState.tagChooser[ctx].query.trim()) return;
  requestAnimationFrame(() => {
    const view = appState.tagChooser[ctx];
    if (view.query.trim()) return;
    _refreshTagChooser(ctx);
  });
}

// Chips toggle: the row is the only place a tag appears, so it has to be able
// to take one off again.
function toggleTagChooser(ctx, name) {
  if (!name) return;
  const chooser = TAG_CHOOSERS[ctx];
  const list = chooser.read().slice();
  const i = list.findIndex((x) => x.toLowerCase() === name.toLowerCase());
  if (i >= 0) list.splice(i, 1);
  else if (list.length >= MAX_TAGS_PER_TX) {
    renderTagChooser(ctx); // surfaces the limit hint, adds nothing
    return;
  } else list.push(name);
  chooser.write(list);
  // Deliberately no rebuild — the chip recolours where it stands.
  renderTagChooser(ctx);
}

function filterTagChooser(ctx, value) {
  appState.tagChooser[ctx].query = value || '';
  _refreshTagChooser(ctx);
  // On a phone the keyboard covers the row the moment the field takes focus.
  document.getElementById(TAG_CHOOSERS[ctx].row)?.scrollIntoView({ block: 'nearest' });
}

// Enter is additive only: it picks an exact match or creates the typed name,
// never removes. Removing is a deliberate tap on the accent chip.
function handleTagChooserKey(ctx, value, e) {
  if (!e || e.key !== 'Enter') return;
  e.preventDefault();
  const name = _normaliseNewTag(value);
  if (!name) return;
  const exact = appState.ledger.availableTags.find((t) => t.toLowerCase() === name.toLowerCase());
  if (!exact) {
    createTagFromChooser(ctx, name);
    return;
  }
  const chooser = TAG_CHOOSERS[ctx];
  if (!chooser.read().some((x) => x.toLowerCase() === exact.toLowerCase())) {
    toggleTagChooser(ctx, exact);
  }
  _clearTagChooserQuery(ctx);
}

function createTagFromChooser(ctx, raw) {
  const chooser = TAG_CHOOSERS[ctx];
  const name = _normaliseNewTag(raw);
  if (!name) return;
  const list = chooser.read();
  if (list.length >= MAX_TAGS_PER_TX) {
    renderTagChooser(ctx);
    return;
  }
  // In memory only. The tag row is written when the booking or the rule is
  // saved (crud._resolve_tags creates what is missing), so abandoning the
  // form leaves no orphan behind — same as the picker's create field did.
  if (!appState.ledger.availableTags.some((t) => t.toLowerCase() === name.toLowerCase())) {
    appState.ledger.availableTags.push(name);
    appState.ledger.availableTags.sort(_byTagName);
  }
  chooser.write([...list, name]);
  _clearTagChooserQuery(ctx);
}

// Back to the overview, which puts the freshly chosen tag at the front where
// the user can see it landed.
function _clearTagChooserQuery(ctx) {
  appState.tagChooser[ctx].query = '';
  const input = document.getElementById(TAG_CHOOSERS[ctx].input);
  if (input) input.value = '';
  _refreshTagChooser(ctx);
}

// Called when a form opens: clear the query and recompute from scratch.
function resetTagChooser(ctx) {
  appState.tagChooser[ctx] = { query: '', shown: [], overflow: 0 };
  const input = document.getElementById(TAG_CHOOSERS[ctx].input);
  if (input) input.value = '';
  _refreshTagChooser(ctx);
}

// ── TAG PICKER MODAL ──────────────────────────────────────────────────────────
// ── CATEGORY CHOOSER ──────────────────────────────────────────────────────────
// Every form that used to hold a bare <select> of category names now uses this:
// a search field over all categories, and below it a row of chips carrying the
// category's own icon and colour — the language the rest of the app speaks.
//
// Three things make it different from the tag chooser it mirrors:
//
//   1. Single-select and mandatory. A tap switches, it never clears, and the
//      chooser's `selectedId` *is* the form's value — no <select> is read.
//   2. The row is capped by measured rows, not by a count: chip widths follow
//      the category names, so a fixed number packs into anything from one row
//      to three. Two rows is the knee of the curve — the third buys few extra
//      hits and pushes the notes field below the fold.
//   3. Creating opens the category modal with the name filled in rather than
//      creating silently. A tag with a default look is harmless; a category
//      shows up in every report, so its icon and colour are worth a decision.
//
// Ranking is most-used-first for the form's current type (see _compareUsage in
// utils.js), which is why switching expense/income reshuffles the chips.
// Three rows, matching the tag row below it. On a 20-category account that is
// nine categories in reach instead of six; the cost is the notes field, which
// drops below the fold of the scrolling modal body on a mid-size phone. The
// category is mandatory and the note is not, so the trade goes this way.
const CAT_CHOOSER_ROWS = 3;
const CAT_CHOOSER_HITS = 12; // cap while a query narrows things down
// Used until the row has been laid out and can be measured — deliberately
// small so a modal never flashes every category before the cap lands.
const CAT_CHOOSER_BLIND_CAP = 5;

const CAT_CHOOSERS = {
  transaction: {
    input: 'catSearch',
    row: 'catSuggestions',
    hint: 'catSuggestionsHint',
    type: () => appState.form.type,
  },
  recurring: {
    input: 'recCatSearch',
    row: 'recCatSuggestions',
    hint: 'recCatSuggestionsHint',
    // Read live from the rule's type <select>: the editor writes its state
    // only on save.
    type: () => document.getElementById('recEditType')?.value || 'out',
  },
  goal: {
    input: 'goalCatSearch',
    row: 'goalCatSuggestions',
    hint: 'goalCatSuggestionsHint',
    // A savings goal fills up from income, a debt tracker is paid down by
    // expenses — so the goal's direction picks the side to rank by.
    type: () => (document.getElementById('goalEditDirection')?.value === 'pay_down' ? 'out' : 'in'),
    taken: () => _goalTakenCategoryIds(appState.goals.editingId),
    // The new-goal form names itself after the chosen category for as long as
    // the name is still its own suggestion.
    onSelect: () => _syncGoalNameToCategory(),
  },
  budget: {
    input: 'budgetCatSearch',
    row: 'budgetCatSuggestions',
    hint: 'budgetCatSuggestionsHint',
    // A budget caps spending, always.
    type: () => 'out',
    taken: () => _budgetTakenCategoryIds(appState.budgets.editingId),
  },
  bulk: {
    input: 'bulkCatSearch',
    row: 'bulkCatSuggestions',
    hint: 'bulkCatSuggestionsHint',
    // Rank by the marked rows' own type when they agree; a mixed selection
    // has no single answer, so it falls back to overall use.
    type: () => _selectionType(),
  },
};

// Usage record for a category in the shape _compareUsage expects. The API
// reports the three counts; a category created offline has none yet.
function _catUse(cat) {
  return {
    all: Number(cat && cat.count) || 0,
    in: Number(cat && cat.count_in) || 0,
    out: Number(cat && cat.count_out) || 0,
  };
}

// The type shared by every marked transaction, or null when they disagree.
function _selectionType() {
  const ids = new Set(appState.selection.ids);
  const pool = appState.ledger.all || appState.ledger.transactions;
  let seen = null;
  for (const t of pool) {
    if (!ids.has(t.id)) continue;
    if (seen == null) seen = t.type;
    else if (seen !== t.type) return null;
  }
  return seen;
}

const _byCatName = (a, b) => a.name.localeCompare(b.name, _locale(), { sensitivity: 'base' });

// Categories this context may offer: goals and budgets are 1:1 with a
// category, so the ones already spoken for are dropped — except the one this
// record itself holds, which stays selectable.
function _catChooserPool(ctx) {
  const chooser = CAT_CHOOSERS[ctx];
  const taken = chooser.taken ? chooser.taken() : null;
  const selectedId = appState.catChooser[ctx].selectedId;
  return appState.ledger.categories.filter(
    (c) => !taken || c.id === selectedId || !taken.has(c.id),
  );
}

// Decide which chips the row shows and freeze that order into the view state.
// Called when a form opens, when the query changes and when the type changes —
// never on a tap, so a chip cannot move out from under a finger mid-press.
function _rebuildCatChooser(ctx) {
  const view = appState.catChooser[ctx];
  const query = view.query.trim().toLowerCase();
  const pool = _catChooserPool(ctx);

  if (query) {
    // Search runs over every category, not just the visible rows — that is
    // the whole point of the field replacing the <select>.
    const hits = pool.filter((c) => c.name.toLowerCase().includes(query)).sort(_byCatName);
    view.shown = hits.slice(0, CAT_CHOOSER_HITS);
    view.overflow = hits.length - view.shown.length;
    return;
  }

  // Overview: what is already selected comes first, so editing an old record
  // shows its category even when it is not one of the frequent ones.
  const type = CAT_CHOOSERS[ctx].type ? CAT_CHOOSERS[ctx].type() : null;
  const selected = pool.find((c) => c.id === view.selectedId);
  const rest = pool
    .filter((c) => c.id !== view.selectedId)
    .sort((a, b) => _compareUsage(_catUse(a), _catUse(b), type) || _byCatName(a, b));
  view.shown = selected ? [selected, ...rest] : rest;
  view.overflow = 0; // decided by the row cap, after layout
}

// No icon here, deliberately. Category names run long ("Gesundheit &
// Hygiene"), and with the glyph only two chips fit a line on a phone — the
// 20px square plus its gap costs more width than a whole extra chip is worth.
// The icon still carries the category everywhere it has room to: the ledger
// rows, the reports, and the category list itself.
function _catChipMarkup(ctx, c) {
  const on = c.id === appState.catChooser[ctx].selectedId;
  return `<button type="button" class="cat-suggestion${on ? ' is-chosen' : ''}" data-cat-choice="${c.id}" aria-pressed="${on}" aria-label="${_escAttr(tr('categories.chooseAria', { name: c.name }))}">${_escText(c.name)}</button>`;
}

function renderCatChooser(ctx) {
  const chooser = CAT_CHOOSERS[ctx];
  const row = document.getElementById(chooser.row);
  if (!row) return;
  const view = appState.catChooser[ctx];
  const query = view.query.trim();
  const exact =
    query && appState.ledger.categories.some((c) => c.name.toLowerCase() === query.toLowerCase());

  // Offer to make the typed text a category, so the name is typed once rather
  // than again in the modal. Last, and only when it is not an exact match —
  // creating "Auto" has to stay possible even though "Autobahn" matches.
  const createChip =
    query && !exact
      ? `<button type="button" class="cat-suggestion cat-create" data-cat-create="${_escAttr(query)}">${_escText(tr('categories.createChip', { name: query }))}</button>`
      : '';

  if (query) {
    row.innerHTML = view.shown.map((c) => _catChipMarkup(ctx, c)).join('') + createChip;
  } else {
    row.innerHTML = view.shown.map((c) => _catChipMarkup(ctx, c)).join('');
    _capCatChooserRows(ctx);
  }

  row.querySelectorAll('[data-cat-choice]').forEach((el) => {
    el.addEventListener('click', () => selectCatChooser(ctx, Number(el.dataset.catChoice)));
  });
  row.querySelectorAll('[data-cat-create]').forEach((el) => {
    el.addEventListener('click', () => createCategoryFromChooser(ctx, el.dataset.catCreate));
  });

  _renderCatChooserHint(ctx);
}

// Trim the row to CAT_CHOOSER_ROWS and show what survives alphabetically.
//
// The two orders do different jobs and cannot be applied in one pass.
// Ranking decides *which* categories you see: the most-used for this form's
// type, with the selected one first in `view.shown` so it always survives
// even when it is not a frequent one. The alphabet decides *where* they sit,
// so a chip does not move when usage shifts or the type flips — the same
// split the tag row uses. Line packing is greedy, though, so the same chips
// in alphabetical order can wrap one line further than the ranked layout the
// cut was measured on; re-check what is actually shown and shrink until it
// fits.
//
// While the row is not laid out (a form fills its chooser before its modal is
// shown) fall back to a small blind cap and let the caller re-run this once
// the modal is up. Callers wire the chips afterwards, so this only paints.
function _capCatChooserRows(ctx) {
  const row = document.getElementById(CAT_CHOOSERS[ctx].row);
  const view = appState.catChooser[ctx];
  if (!row || !view.shown.length) return;
  const blind = row.offsetParent === null;
  let keep = blind
    ? Math.min(CAT_CHOOSER_BLIND_CAP, view.shown.length)
    : _chipsWithinRows(row, CAT_CHOOSER_ROWS);
  for (;;) {
    const shown = view.shown.slice(0, keep).sort(_byCatName);
    row.innerHTML = shown.map((c) => _catChipMarkup(ctx, c)).join('');
    if (blind || keep <= 1 || _chipsWithinRows(row, CAT_CHOOSER_ROWS) === shown.length) return;
    keep -= 1;
  }
}

// The hint only speaks about a search. At rest the row is deliberately a
// shortlist, and counting what it leaves out says nothing the user can act on
// — the search field above already offers the way to the rest.
function _renderCatChooserHint(ctx) {
  const hint = document.getElementById(CAT_CHOOSERS[ctx].hint);
  if (!hint) return;
  const view = appState.catChooser[ctx];
  const message = !view.query.trim()
    ? ''
    : view.shown.length === 0
      ? tr('categories.searchNone')
      : view.overflow > 0
        ? tr('categories.moreResults', { n: view.overflow })
        : '';
  hint.textContent = message;
  hint.hidden = !message;
}

// Re-measure a chooser's row cap once its modal is actually on screen. The
// order is frozen in state, so this only ever adds or removes chips at the
// tail — nothing the user was aiming at moves.
function remeasureCatChooser(ctx) {
  if (!appState.catChooser[ctx] || appState.catChooser[ctx].query.trim()) return;
  requestAnimationFrame(() => {
    const view = appState.catChooser[ctx];
    if (view.query.trim()) return;
    const row = document.getElementById(CAT_CHOOSERS[ctx].row);
    if (!row) return;
    row.innerHTML = view.shown.map((c) => _catChipMarkup(ctx, c)).join('');
    _capCatChooserRows(ctx);
    row.querySelectorAll('[data-cat-choice]').forEach((el) => {
      el.addEventListener('click', () => selectCatChooser(ctx, Number(el.dataset.catChoice)));
    });
    _renderCatChooserHint(ctx);
  });
}

// A tap switches the selection; it never clears it. Only the colours change —
// the frozen order keeps every other chip exactly where the user saw it.
function selectCatChooser(ctx, id) {
  const view = appState.catChooser[ctx];
  view.selectedId = Number(id);
  view.auto = false; // a deliberate choice; the type no longer overrides it
  const row = document.getElementById(CAT_CHOOSERS[ctx].row);
  if (!row) return;
  row.querySelectorAll('[data-cat-choice]').forEach((el) => {
    const on = Number(el.dataset.catChoice) === view.selectedId;
    el.classList.toggle('is-chosen', on);
    el.setAttribute('aria-pressed', String(on));
  });
  // Picking from the search results is the end of that search: clear the
  // field so the row goes back to showing the ranked overview with the new
  // choice at its head.
  if (view.query.trim()) _clearCatChooserQuery(ctx);
  if (CAT_CHOOSERS[ctx].onSelect) CAT_CHOOSERS[ctx].onSelect();
}

function filterCatChooser(ctx, value) {
  appState.catChooser[ctx].query = value || '';
  _rebuildCatChooser(ctx);
  renderCatChooser(ctx);
}

function _clearCatChooserQuery(ctx) {
  const input = document.getElementById(CAT_CHOOSERS[ctx].input);
  if (input) input.value = '';
  appState.catChooser[ctx].query = '';
  _rebuildCatChooser(ctx);
  renderCatChooser(ctx);
}

// Enter picks the single match, or offers to create when nothing matches —
// so a keyboard user never has to reach for the chip row.
function handleCatChooserKey(ctx, value, e) {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const raw = (value || '').trim();
  if (!raw) return;
  const view = appState.catChooser[ctx];
  const exact = view.shown.find((c) => c.name.toLowerCase() === raw.toLowerCase());
  if (exact) return selectCatChooser(ctx, exact.id);
  if (view.shown.length === 1) return selectCatChooser(ctx, view.shown[0].id);
  if (!view.shown.length) createCategoryFromChooser(ctx, raw);
}

// Unlike a tag, a category gets a full modal: it carries an icon and a colour
// that show up in every report, and picking those deliberately once is worth
// more than saving a tap. The name is carried over so it is typed only once.
function createCategoryFromChooser(ctx, raw) {
  const name = (raw || '').trim();
  if (!name) return;
  openCatModal(null, { prefillName: name, returnTo: ctx });
}

// Fill a chooser for a form that is opening. `selectedId` null means "no
// choice yet" — the ranking then puts the most likely category first and
// preselects it, which beats the alphabetically first one the <select> used
// to land on.
function resetCatChooser(ctx, selectedId) {
  const view = appState.catChooser[ctx];
  view.query = '';
  const input = document.getElementById(CAT_CHOOSERS[ctx].input);
  if (input) input.value = '';
  view.selectedId = selectedId != null ? Number(selectedId) : null;
  view.auto = selectedId == null;
  _rebuildCatChooser(ctx);
  if (view.selectedId == null && view.shown.length) view.selectedId = view.shown[0].id;
  renderCatChooser(ctx);
}

// The value the form saves. Null when the user has no valid choice — the
// callers surface that as the same field error the <select> used to.
function catChooserValue(ctx) {
  const id = appState.catChooser[ctx].selectedId;
  return Number.isFinite(id) && appState.ledger.categories.some((c) => c.id === id) ? id : null;
}

// The expense/income toggle changed: both choosers rank against the type, so
// both have to re-rank. Not a violation of the frozen order — that freeze
// protects against taps, and switching the type is a different intent.
function rerankChoosersForType(ctx) {
  const view = appState.catChooser[ctx];
  if (view) {
    // An automatic choice follows the ranking, so re-pick it for the new type:
    // flipping to income must not leave the expense default selected. A
    // category the user tapped stays put.
    if (view.auto) view.selectedId = null;
    _rebuildCatChooser(ctx);
    if (view.auto && view.shown.length) view.selectedId = view.shown[0].id;
    renderCatChooser(ctx);
    remeasureCatChooser(ctx);
  }
  if (appState.tagChooser[ctx]) {
    _refreshTagChooser(ctx);
  }
}

// Only the ledger's bulk actions still open this. The booking form and the
// recurring editor pick tags inline through the chooser above, so the picker
// no longer stages a form's tags — its selection is always the set of tags to
// add to, or remove from, the marked transactions.
//   selection      — staged tags, applied on „Übernehmen"
//   context        — 'bulkAdd' | 'bulkRemove'
//   bulkRemovePool — tags actually present on the marked transactions
//
// It works the way the chooser does: one field that searches and, when
// adding, creates — no separate create row. The differences are inherent to
// acting on many rows at once: the picker stages its selection behind
// „Übernehmen" instead of writing through, and the remove mode searches only
// the tags actually on the marked rows.

function openTagPickerFor(context) {
  appState.tagPicker.context = context;
  rememberModalFocus('tagPicker');
  // Both bulk contexts start empty: the picked tags are the ones to act on,
  // not a pre-existing selection to edit.
  appState.tagPicker.selection = [];
  const isRemove = context === 'bulkRemove';
  const title = document.getElementById('tagPickerTitle');
  if (title)
    title.textContent = isRemove ? tr('selection.removeTagTitle') : tr('selection.addTagTitle');
  const filter = document.getElementById('tagPickerFilter');
  filter.value = '';
  // Only the add mode can create, so only it says so. openBulkRemoveTags
  // never opens the remove mode on an empty pool, so there is no case left
  // where the field would search through nothing.
  filter.placeholder = tr(isRemove ? 'tags.searchPlaceholder' : 'tags.searchOrCreate');
  const chips = document.getElementById('tagPickerChips');
  chips.style.minHeight = '';
  renderTagPickerChips();
  document.getElementById('tagPickerOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
  // Lock chip-area height to the unfiltered render so the modal
  // doesn't snap shut while the user is narrowing the filter.
  requestAnimationFrame(() => {
    chips.style.minHeight = chips.offsetHeight + 'px';
  });
  trapFocusIn(document.querySelector('#tagPickerOverlay .modal'), 'tagPicker');
}
function closeTagPicker() {
  document.getElementById('tagPickerOverlay').classList.remove('open');
  document.getElementById('tagPickerChips').style.minHeight = '';
  // The picker is only reached from the ledger now, so nothing else holds the
  // scroll lock.
  document.body.style.overflow = '';
  appState.tagPicker.selection = [];
  releaseFocusTrap('tagPicker');
  restoreModalFocus('tagPicker');
}
function closeTagPickerOutside(e) {
  if (e.target === document.getElementById('tagPickerOverlay')) closeTagPicker();
}
function commitTagPicker() {
  const ctx = appState.tagPicker.context;
  const tags = [...appState.tagPicker.selection];
  closeTagPicker();
  if (!tags.length) return;
  bulkApply({ action: ctx === 'bulkRemove' ? 'remove_tags' : 'add_tags', tags });
}
// The remove picker is scoped to the tags actually on the selected rows.
function _tagPickerSource() {
  return appState.tagPicker.context === 'bulkRemove'
    ? appState.tagPicker.bulkRemovePool
    : appState.ledger.availableTags;
}

function renderTagPickerChips() {
  const box = document.getElementById('tagPickerChips');
  if (!box) return;
  const isRemove = appState.tagPicker.context === 'bulkRemove';
  const raw = document.getElementById('tagPickerFilter').value || '';
  const q = raw.trim().toLowerCase();
  const source = _tagPickerSource();
  const filtered = q ? source.filter((t) => t.toLowerCase().includes(q)) : source;
  const selected = new Set(appState.tagPicker.selection.map((x) => x.toLowerCase()));
  const full = appState.tagPicker.selection.length >= MAX_TAGS_PER_TX;
  const chips = filtered.map((t) => {
    const isSel = selected.has(t.toLowerCase());
    return `<button type="button" class="tag-picker-chip${isSel ? ' selected' : ''}" data-pick-tag="${_escAttr(t)}" aria-pressed="${isSel}">${_escText(t)}</button>`;
  });
  // Same offer the booking form makes: a name nobody has yet becomes a chip
  // that creates it, typed once instead of again in a separate field. It goes
  // last, so an existing match stays the first thing under the finger.
  const name = isRemove ? '' : _normaliseNewTag(raw);
  const exact = name && source.some((t) => t.toLowerCase() === name.toLowerCase());
  if (name && !exact && !full) {
    chips.push(
      `<button type="button" class="tag-picker-chip tag-create" data-pick-create="${_escAttr(name)}">${_escText(tr('tags.createChip', { name }))}</button>`,
    );
  }
  box.innerHTML = chips.join('');
  box.querySelectorAll('[data-pick-tag]').forEach((el) => {
    el.addEventListener('click', () => togglePickerTag(el.dataset.pickTag));
  });
  box.querySelectorAll('[data-pick-create]').forEach((el) => {
    el.addEventListener('click', () => createTagFromPicker(el.dataset.pickCreate));
  });

  const hint = document.getElementById('tagPickerHint');
  if (!hint) return;
  // The server caps a transaction's tag list, so refuse the 21st here rather
  // than letting „Übernehmen" come back as a 422 nobody can read.
  const message = full
    ? tr('tags.limitReached', { max: MAX_TAGS_PER_TX })
    : q && !chips.length
      ? tr('tags.searchNone')
      : '';
  hint.textContent = message;
  hint.hidden = !message;
}
function togglePickerTag(t) {
  const i = appState.tagPicker.selection.findIndex((x) => x.toLowerCase() === t.toLowerCase());
  if (i >= 0) appState.tagPicker.selection.splice(i, 1);
  else if (appState.tagPicker.selection.length >= MAX_TAGS_PER_TX) {
    renderTagPickerChips(); // surfaces the limit hint, adds nothing
    return;
  } else appState.tagPicker.selection.push(t);
  renderTagPickerChips();
}

// Back to the unfiltered grid, where the freshly picked tag is visible as a
// selected chip.
function _clearTagPickerQuery() {
  const filter = document.getElementById('tagPickerFilter');
  if (filter) filter.value = '';
  renderTagPickerChips();
}

function createTagFromPicker(raw) {
  const name = _normaliseNewTag(raw);
  if (!name) return;
  if (appState.tagPicker.selection.length >= MAX_TAGS_PER_TX) {
    renderTagPickerChips();
    return;
  }
  // In memory only. The tag row is written when the bulk action runs
  // (crud._resolve_tags_cached creates what is missing), so closing without
  // „Übernehmen" leaves no orphan behind.
  if (!appState.ledger.availableTags.some((t) => t.toLowerCase() === name.toLowerCase())) {
    appState.ledger.availableTags.push(name);
    appState.ledger.availableTags.sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' }),
    );
  }
  if (!appState.tagPicker.selection.some((x) => x.toLowerCase() === name.toLowerCase())) {
    appState.tagPicker.selection.push(name);
  }
  _clearTagPickerQuery();
}

// Enter is additive only: it picks an exact match or creates the typed name.
// Taking one back off is a deliberate tap on the accent chip.
function handleTagPickerKey(value, e) {
  if (!e || e.key !== 'Enter') return;
  e.preventDefault();
  const name = _normaliseNewTag(value);
  if (!name) return;
  const exact = _tagPickerSource().find((t) => t.toLowerCase() === name.toLowerCase());
  if (!exact) {
    // Nothing to create when removing — that can only touch existing tags.
    if (appState.tagPicker.context !== 'bulkRemove') createTagFromPicker(name);
    return;
  }
  if (!appState.tagPicker.selection.some((x) => x.toLowerCase() === exact.toLowerCase())) {
    if (appState.tagPicker.selection.length >= MAX_TAGS_PER_TX) {
      renderTagPickerChips();
      return;
    }
    appState.tagPicker.selection.push(exact);
  }
  _clearTagPickerQuery();
}

function renderCategories() {
  const box = document.getElementById('catList');
  if (!box) return;
  const sorted = [...appState.ledger.categories].sort((a, b) =>
    a.name.localeCompare(b.name, _locale(), { sensitivity: 'base' }),
  );
  const shown = applyDrawerFilter('cats', sorted, (c) => c.name);
  if (!shown.length) {
    // Nothing to show is either an empty account or a query that missed.
    box.innerHTML = `<p class="empty-state-hint">${tr(drawerFilterActive('cats') ? 'categories.searchNone' : 'categories.none')}</p>`;
    return;
  }
  box.innerHTML = '';
  shown.forEach((c) => {
    const uses = Number(c.count) || 0;
    const row = document.createElement('div');
    row.className = 'drawer-nav-item cat-pill-edit';
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    row.setAttribute(
      'aria-label',
      `${tr('categories.editAria', { name: c.name })}, ${usage90Label(uses)}`,
    );
    row.onclick = () => openCatModal(c.id);
    row.onkeydown = (e) => handleRowActivate(e, () => openCatModal(c.id));
    const iconWrap = document.createElement('div');
    iconWrap.className = 'drawer-nav-icon-wrap cat-tile';
    iconWrap.style.setProperty('--cat-color', c.color);
    iconWrap.innerHTML = catIconSvg(c.icon);
    const label = document.createElement('span');
    label.className = 'drawer-nav-label';
    label.textContent = c.name;
    row.appendChild(iconWrap);
    row.appendChild(label);
    row.insertAdjacentHTML('beforeend', mgmtRowTrailer(uses));
    box.appendChild(row);
  });
}

// Trailing part of a settings management row (categories, tags): the 90-day
// usage count the list endpoints already deliver, then a drill-in chevron —
// the row opens an editor, like every other chevron row in settings.
// Screen-reader text for the usage count those rows show.
function usage90Label(uses) {
  return tr(uses === 1 ? 'common.usage90One' : 'common.usage90', { n: uses });
}

function mgmtRowTrailer(uses) {
  return (
    `<span class="drawer-nav-value" aria-hidden="true">${Number(uses) || 0}</span>` +
    `<span class="drawer-nav-chevron" aria-hidden="true"><svg class="ui-icon"><use href="#icon-chevron-right"/></svg></span>`
  );
}

const CAT_COLOR_PRESETS = [
  { hex: '#D97757', name: 'Terracotta' },
  { hex: '#6b7aa1', name: 'Blau' },
  { hex: '#788C5D', name: 'Olive' },
  { hex: '#c47ab0', name: 'Mauve' },
  { hex: '#e0a44a', name: 'Senf' },
  { hex: '#87867F', name: 'Grau' },
  { hex: '#B85C3E', name: 'Rost' },
  { hex: '#8a6a4a', name: 'Kakao' },
  { hex: '#a45ab0', name: 'Violett' },
  { hex: '#6a8a8a', name: 'Petrol' },
];

// Picker catalogue. IDs map 1:1 to <symbol id="cat-…"> entries in the
// Phosphor sprite (frontend/icons/categories/sprite.svg). Order inside
// a group is the order the picker renders.
const CAT_ICON_GROUPS = [
  {
    titleKey: 'catIcons.home',
    ids: [
      'house',
      'buildings',
      'door',
      'bed',
      'armchair',
      'couch',
      'chair',
      'television',
      'lightbulb',
      'fan',
      'oven',
      'plug',
      'key',
      'wrench',
      'hammer',
      'paint-brush',
      'broom',
      'fire',
    ],
  },
  {
    titleKey: 'catIcons.clothing',
    ids: [
      't-shirt',
      'dress',
      'hoodie',
      'pants',
      'sneaker',
      'eyeglasses',
      'watch',
      'backpack',
      'handbag',
      'baby',
      'coat-hanger',
      'washing-machine',
      'scissors',
      'shower',
      'drop',
      'toilet-paper',
    ],
  },
  {
    titleKey: 'catIcons.food',
    ids: [
      'shopping-cart',
      'basket',
      'bag',
      'bag-simple',
      'bread',
      'egg',
      'carrot',
      'fish',
      'orange',
      'avocado',
      'pepper',
      'hamburger',
      'pizza',
      'cookie',
      'cake',
      'ice-cream',
      'bowl-food',
      'bowl-steam',
      'coffee',
      'beer-stein',
      'wine',
      'martini',
      'fork-knife',
      'knife',
    ],
  },
  {
    titleKey: 'catIcons.mobility',
    ids: [
      'car',
      'taxi',
      'bus',
      'truck',
      'motorcycle',
      'scooter',
      'bicycle',
      'train',
      'train-regional',
      'airplane',
      'boat',
      'gas-pump',
      'map-pin',
      'road-horizon',
    ],
  },
  {
    titleKey: 'catIcons.leisure',
    ids: [
      'film-strip',
      'camera',
      'game-controller',
      'dice-five',
      'music-note',
      'guitar',
      'headphones',
      'microphone',
      'palette',
      'confetti',
      'book',
      'books',
      'gift',
      'ticket',
      'soccer-ball',
      'basketball',
      'tennis-ball',
      'tree-palm',
    ],
  },
  {
    titleKey: 'catIcons.health',
    ids: [
      'pill',
      'first-aid-kit',
      'bandaids',
      'heartbeat',
      'stethoscope',
      'syringe',
      'hospital',
      'brain',
      'virus',
      'mask-happy',
      'tooth',
      'dog',
      'cat',
    ],
  },
  {
    titleKey: 'catIcons.office',
    ids: [
      'briefcase',
      'graduation-cap',
      'chalkboard',
      'book-open',
      'pencil',
      'envelope',
      'calendar',
      'clipboard',
      'calculator',
      'laptop',
      'folder',
      'files',
      'magnifying-glass',
      'newspaper-clipping',
      'paperclip',
    ],
  },
  {
    titleKey: 'catIcons.finance',
    ids: [
      'wallet',
      'credit-card',
      'bank',
      'vault',
      'coins',
      'coin',
      'coin-vertical',
      'piggy-bank',
      'currency-eur',
      'currency-dollar',
      'hand-coins',
      'receipt',
      'invoice',
      'money',
      'trend-up',
      'trend-down',
      'chart-line',
      'percent',
    ],
  },
  {
    titleKey: 'catIcons.other',
    ids: [
      'package',
      'star',
      'heart',
      'sparkle',
      'magic-wand',
      'globe',
      'bell',
      'alarm',
      'sun',
      'moon',
      'cloud',
      'snowflake',
      'umbrella',
      'mountains',
      'tree',
      'plant',
      'leaf',
      'flower-tulip',
      'butterfly',
      'smiley',
      'anchor',
      'tag',
      'question',
    ],
  },
];
const CAT_ICON_FALLBACK = 'package';
const CAT_ICON_VALID = new Set(CAT_ICON_GROUPS.flatMap((g) => g.ids));

// Renders one sprite glyph. Unknown IDs (e.g. legacy emoji glyphs that
// somehow survived migration) gracefully fall back to the box icon
// rather than referencing a missing symbol.
function catIconSvg(id) {
  const safe = CAT_ICON_VALID.has(id) ? id : CAT_ICON_FALLBACK;
  return `<svg class="cat-glyph" aria-hidden="true"><use href="#cat-${safe}"/></svg>`;
}

// Fetch the sprite once at boot and inject it inline so document-local
// <use href="#cat-…"> references resolve everywhere (transaction rows,
// category breakdown, picker). Cache-first via the SW under its versioned
// URL, so a release with new glyphs never shows the previous sprite.
async function loadCategoryIconSprite() {
  if (document.getElementById('cat-icon-sprite')) return;
  try {
    const res = await fetch(assetUrl('/icons/categories/sprite.svg'));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    // Strip the XML prolog if present — invalid as inline HTML.
    const cleaned = text.replace(/<\?xml[^?]*\?>/, '').trim();
    const host = document.createElement('div');
    host.id = 'cat-icon-sprite';
    host.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
    host.setAttribute('aria-hidden', 'true');
    host.innerHTML = cleaned;
    document.body.insertBefore(host, document.body.firstChild);
  } catch (e) {
    console.warn('Category icon sprite failed to load:', e);
  }
}

// Category create/edit modal draft lives in appState.catEdit (state.js);
// seed the icon default from CAT_ICON_FALLBACK (defined above).
appState.catEdit.icon = CAT_ICON_FALLBACK;

// `opts.prefillName` seeds the name field (the chooser's "add" chip carries
// the text the user already typed); `opts.returnTo` is the chooser context to
// hand the finished category back to, so the form the user was filling in
// continues with it selected.
function openCatModal(id, opts = {}) {
  rememberModalFocus('cat');
  appState.catEdit.returnTo = opts.returnTo || null;
  const deleteBtn = document.getElementById('catDeleteBtn');
  const title = document.getElementById('catModalTitle');
  if (id) {
    const c = appState.ledger.categories.find((x) => x.id === id);
    if (!c) return;
    appState.catEdit.id = c.id;
    appState.catEdit.color = c.color || '#9e9b96';
    appState.catEdit.icon = CAT_ICON_VALID.has(c.icon) ? c.icon : CAT_ICON_FALLBACK;
    document.getElementById('catEditName').value = c.name || '';
    title.textContent = tr('categories.editTitle');
    deleteBtn.style.display = '';
  } else {
    appState.catEdit.id = null;
    appState.catEdit.color =
      CAT_CREATE_COLORS[appState.ledger.categories.length % CAT_CREATE_COLORS.length];
    appState.catEdit.icon = CAT_ICON_FALLBACK;
    document.getElementById('catEditName').value = opts.prefillName || '';
    title.textContent = tr('categories.newTitle');
    deleteBtn.style.display = 'none';
  }
  renderCatColorSwatches();
  renderCatIconPreview();
  document.getElementById('catModalOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
  focusOnOpen(document.getElementById('catModalOverlay'), 'catEditName', 200);
  trapFocusIn(document.querySelector('#catModalOverlay .modal'), 'cat');
}

function renderCatIconPreview() {
  const el = document.getElementById('catEditIconPreview');
  if (!el) return;
  el.style.color = appState.catEdit.color;
  el.innerHTML = catIconSvg(appState.catEdit.icon);
}

// Swatch row shared by the category and goal editors: the preset palette
// plus, when the current color isn't a preset, an extra swatch for it,
// followed by the free color input. pickFnName is the global pick handler
// wired through the inline onclick/onchange (re-renders on pick).
function _colorSwatchesMarkup(currentColor, pickFnName) {
  const presets = [...CAT_COLOR_PRESETS];
  const hasCurrent = presets.some((p) => p.hex.toLowerCase() === currentColor.toLowerCase());
  if (!hasCurrent) presets.push({ hex: currentColor, name: tr('categories.customColorName') });
  return (
    presets
      .map((p) => {
        const isActive = p.hex.toLowerCase() === currentColor.toLowerCase();
        return `<button type="button" class="color-swatch${isActive ? ' active' : ''}" style="background:${p.hex}" aria-label="${_escAttr(tr('categories.pickColorAria', { name: p.name }))}" aria-pressed="${isActive}" data-action="${pickFnName}" data-args='["${p.hex}"]'></button>`;
      })
      .join('') +
    `<label class="color-swatch-custom" title="${_escAttr(tr('categories.customColorName'))}">
     <input type="color" value="${currentColor}" data-action-change="${pickFnName}" data-args='["@value"]' aria-label="${_escAttr(tr('categories.customColor'))}">
   </label>`
  );
}

function renderCatColorSwatches() {
  document.getElementById('catEditColors').innerHTML = _colorSwatchesMarkup(
    appState.catEdit.color,
    'pickCatColor',
  );
}

function pickCatColor(c) {
  appState.catEdit.color = c;
  renderCatColorSwatches();
  renderCatIconPreview();
}

// Select the just-created category in the chooser that asked for it, so the
// form the user left continues where it was. By name rather than by id: the
// offline path only has a provisional id, and the name is what was just
// entered either way.
function _handBackNewCategory(ctx, name) {
  if (!ctx || !appState.catChooser[ctx]) return;
  const made = appState.ledger.categories.find((c) => c.name === name);
  if (!made) return;
  resetCatChooser(ctx, made.id);
  remeasureCatChooser(ctx);
}

function closeCatModal() {
  appState.catEdit.returnTo = null;
  document.getElementById('catModalOverlay').classList.remove('open');
  document.body.style.overflow = '';
  appState.catEdit.id = null;
  releaseFocusTrap('cat');
  restoreModalFocus('cat');
}

// ── ICON PICKER ───────────────────────────────────────────────────────────────
function openIconPicker() {
  rememberModalFocus('iconPicker');
  renderIconPicker();
  const overlay = document.getElementById('iconPickerOverlay');
  overlay.classList.add('open');
  // Body scroll-lock already set by the cat modal; keep it.
  // Always open scrolled to the top — the browser otherwise keeps
  // whatever scrollTop the modal-body had on the previous open.
  overlay.querySelector('.modal-body').scrollTop = 0;
  trapFocusIn(overlay.querySelector('.modal'), 'iconPicker');
}

function closeIconPicker() {
  document.getElementById('iconPickerOverlay').classList.remove('open');
  releaseFocusTrap('iconPicker');
  restoreModalFocus('iconPicker');
}

function closeIconPickerOutside(e) {
  if (e.target === document.getElementById('iconPickerOverlay')) closeIconPicker();
}

function renderIconPicker() {
  const host = document.getElementById('iconPickerSections');
  host.innerHTML = CAT_ICON_GROUPS.map((g) => {
    const cells = g.ids
      .map((id) => {
        const active = id === appState.catEdit.icon ? ' active' : '';
        const pressed = active ? 'true' : 'false';
        return `<button type="button" class="icon-picker-cell${active}"
              aria-pressed="${pressed}" aria-label="${id}"
              data-action="pickIcon" data-args='["${id}"]'>${catIconSvg(id)}</button>`;
      })
      .join('');
    return `<section class="icon-picker-section">
            <h3 class="icon-picker-section-title">${tr(g.titleKey)}</h3>
            <div class="icon-picker-grid">${cells}</div>
          </section>`;
  }).join('');
}

function pickIcon(id) {
  appState.catEdit.icon = CAT_ICON_VALID.has(id) ? id : CAT_ICON_FALLBACK;
  renderCatIconPreview();
  closeIconPicker();
}

async function saveCategoryEdit() {
  const name = document.getElementById('catEditName').value.trim();
  const icon = CAT_ICON_VALID.has(appState.catEdit.icon)
    ? appState.catEdit.icon
    : CAT_ICON_FALLBACK;
  if (!name) {
    toast(tr('common.nameRequired'), 'error');
    return;
  }
  if (!/^#[0-9a-fA-F]{6}$/.test(appState.catEdit.color)) {
    toast(tr('categories.invalidColor'), 'error');
    return;
  }
  const editId = appState.catEdit.id;
  const fields = { name, icon, color: appState.catEdit.color };
  try {
    const result = editId
      ? await api('PUT', `/categories/${editId}`, fields)
      : await api('POST', '/categories', fields);
    // closeCatModal clears the hand-back target, so read it first.
    const returnTo = appState.catEdit.returnTo;
    closeCatModal();
    if (
      _handleQueuedWrite(result, () => {
        _applyCatLocally(editId ? 'PUT' : 'POST', editId, fields);
        _handBackNewCategory(returnTo, name);
      })
    )
      return;
    await loadCategories();
    renderCategories();
    _handBackNewCategory(returnTo, name);
    await loadAndRender();
  } catch (e) {
    if (e.message && e.message.includes('409')) {
      toast(tr('categories.exists'), 'error');
    } else {
      toast(tr('tx.saveFailed') + e.message, 'error');
    }
  }
}

// Mirror a category create/edit/delete into the in-memory list so an offline
// change shows immediately; the next sync reload reconciles it (see
// refreshDomainAfterSync). Display fields (icon/color) on transaction rows are
// resolved from this list via getCatById, so updating it is enough.
function _applyCatLocally(method, id, fields) {
  const list = appState.ledger.categories;
  if (method === 'DELETE') {
    const i = list.findIndex((c) => c.id === Number(id));
    if (i >= 0) list.splice(i, 1);
  } else if (method === 'PUT') {
    const c = list.find((x) => x.id === Number(id));
    if (c) Object.assign(c, fields);
  } else {
    list.push({ id: -Date.now(), ...fields }); // provisional id until sync
  }
  renderCategories();
  renderAll();
}

async function deleteCategoryEdit() {
  if (!appState.catEdit.id) return;
  const ok = await confirmAction({
    title: tr('categories.deleteConfirm'),
    confirmLabel: tr('common.delete'),
  });
  if (!ok) return;
  const editId = appState.catEdit.id;
  try {
    const result = await api('DELETE', `/categories/${editId}`);
    closeCatModal();
    if (_handleQueuedWrite(result, () => _applyCatLocally('DELETE', editId))) return;
    await loadCategories();
    renderCategories();
    await loadAndRender();
  } catch (e) {
    if (e && e.status === 409) {
      // Three distinct reasons land here; pick the right copy
      // so a user with a recurring rule isn't sent looking for
      // phantom transactions.
      if (e.detail && e.detail.includes('recurring')) {
        toast(tr('categories.deleteHasRecurring'), 'error');
      } else if (e.detail && e.detail.includes('goal')) {
        toast(tr('goals.categoryTaken'), 'error');
      } else {
        toast(tr('categories.deleteInUse'), 'error');
      }
    } else {
      toast(tr('tx.deleteFailed') + e.message, 'error');
    }
  }
}
