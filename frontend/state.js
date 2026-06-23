// Central app state for the PocketLog frontend.
//
// Like utils.js / reportsData.js, this is a classic script loaded *before*
// the feature modules (core.js … app.js), so the top-level `const appState`
// lives in the shared global lexical scope and the modules read/write it
// directly (`appState.ledger.categories`, `appState.trend.kind`, …). Before
// this file existed these were ~45 loose module-global `let` variables
// scattered across the app code; collecting them here — grouped by the
// feature that owns them — gives a single, documented home for "what mutable
// state does the app hold" without changing any behaviour.
//
// Only safe literal defaults live here. State that is restored from
// localStorage on boot (the active report, trend selection/range) keeps its
// restore logic in core.js, where the relevant constants are defined; that
// code simply assigns into `appState` once it runs (core.js loads after this).
//
// The module.exports guard at the bottom is a no-op in the browser.

const appState = {
  // Currently displayed period in the transactions view (also seeds the date
  // of a new booking). currentMonth / currentYear.
  view: {
    month: new Date().getMonth(),
    year: new Date().getFullYear(),
    // Month/year picker popover (core.js): open flag plus the year currently
    // being browsed in the grid. pickerYear stays separate from `year` so
    // stepping years in the popover doesn't reload transactions until a month
    // is chosen; it is seeded from `year` each time the popover opens.
    pickerOpen: false,
    pickerYear: null,
  },

  // Draft of the booking form (the in/out toggle and the tags being attached
  // to the next transaction). currentType / currentTags.
  form: {
    type: 'out',
    tags: [],
  },

  // Reports view. `current` is the active report id (restored from
  // localStorage in app.js); `range` is the selected period; `rangeLock`
  // pins the picker granularity for reports that only make sense at one;
  // `txPool` is the last report's transactions (so editTransaction finds the
  // real booking); `searchExitTarget` is where "cancel" returns after a
  // category drill-down. currentReport / reportRange / _rangeLock /
  // _reportTxPool / _searchExitTarget.
  reports: {
    current: 'overview',
    range: {
      kind: 'month',
      anchor: {
        y: new Date().getFullYear(),
        m: new Date().getMonth(),
        q: Math.floor(new Date().getMonth() / 3),
      },
      from: '',
      to: '',
    },
    rangeLock: null,
    txPool: null,
    searchExitTarget: null,
  },

  // Spending-trend chart state (entity selection + year range + picker UI).
  // Restored from localStorage in app.js. _trendKind / _trendSelection /
  // _trendPickerOpen / _trendPickerFilter / _earliestTxDate / _trendYearFrom /
  // _trendYearTo.
  trend: {
    kind: 'category', // 'category' | 'tag'
    selection: [], // ['cat:42'] today, up to 3 later
    pickerOpen: false,
    pickerFilter: '',
    earliestTxDate: null, // session cache
    yearFrom: null, // integer, e.g. 2022
    yearTo: null, // integer, e.g. 2026
  },

  // Localised calendar labels, rebuilt from Intl on locale change. MONTHS /
  // MONTHS_SHORT.
  calendar: {
    months: [],
    monthsShort: [],
  },

  // Core ledger data loaded from the API. `transactions` is the current view's
  // slice; `all` is the full pool used by search; `availableTags` are the
  // user's distinct tags (alphabetical). transactions / categories /
  // availableTags / _allTransactions.
  ledger: {
    transactions: [],
    categories: [],
    availableTags: [],
    all: null,
  },

  // Navigation / cross-cutting UI state. _activePanel / _bookingModalOpenedAt /
  // _searchQuery / _categoryFilterId / _tagFilterName / _infoPanelSeq /
  // _goalRelayoutTimer.
  nav: {
    activePanel: 'transactions',
    bookingModalOpenedAt: 0,
    searchQuery: '',
    categoryFilterId: null,
    tagFilterName: null,
    infoPanelSeq: 0,
    goalRelayoutTimer: null,
  },

  // Tag picker (shared between the transaction form and the recurring form).
  // pickerSelection / _tagPickerContext / currentRecurringTags.
  tagPicker: {
    selection: [],
    context: 'transaction',
    recurringTags: [],
  },

  // Category create/edit modal draft. editingCatId / editingCatColor /
  // editingCatIcon (icon defaults to CAT_ICON_FALLBACK, set in app.js).
  catEdit: {
    id: null,
    color: '#9e9b96',
    icon: null,
  },

  // Goals list + edit modal draft. goals / editingGoalId / editingGoalColor.
  goals: {
    list: [],
    editingId: null,
    editingColor: '#9e9b96',
  },

  // Budgets list + edit modal draft (per-category spending caps).
  budgets: {
    list: [],
    editingId: null,
  },

  // Recurring rules list + edit modal draft. recurringRules /
  // editingRecurringId / _recurringValidity.
  recurring: {
    rules: [],
    editingId: null,
    validity: 'unlimited',
  },

  // Tag rename modal draft. editingTagName.
  tagEdit: {
    name: null,
  },

  // API key management (settings drawer). _apiKeys.
  apiKeys: {
    list: [],
  },

  // Admin views (user list, current me, password-reset target). _adminUsers /
  // _currentMe / _resetPwTargetId.
  admin: {
    users: [],
    me: null,
    resetPwTargetId: null,
  },
};

// Node/Vitest only — the browser classic-script load skips this.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { appState };
}
