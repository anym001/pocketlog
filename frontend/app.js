      // ── ICON-MARKUP ───────────────────────────────────────────────────────────────
      // Für Glyphen, die dynamisch via JS getauscht werden (FAB-Toggle Plus/✕,
      // Tag-Pill-Remove). Statische Glyphen sitzen direkt im HTML-Markup.
      const ICON_SVG = {
        plus: '<svg class="ui-icon" aria-hidden="true"><use href="#icon-plus"/></svg>',
        close: '<svg class="ui-icon" aria-hidden="true"><use href="#icon-close"/></svg>',
      };

      // ── API-BASIS ─────────────────────────────────────────────────────────────────
      // Same-origin. The PWA and the FastAPI backend live behind the same
      // SWAG vhost — there is no supported deployment where they sit on
      // different origins, and CSP `connect-src 'self'` would block such
      // a setup anyway.
      const API = '/api';
      // Drop any leftover apiBase setting from older app versions so the
      // localStorage doesn't accumulate dead keys.
      try { localStorage.removeItem('pocketlog.apiBase'); } catch (e) {}

      let currentMonth = new Date().getMonth();
      let currentYear = new Date().getFullYear();
      let currentType = 'out';
      let currentTags = [];

      // ── REPORTS-STATE ─────────────────────────────────────────────────────────────
      // Welche Auswertung gerade aktiv ist (Quelle der Wahrheit für panel-charts).
      // Persistiert in localStorage, damit ein Reload den letzten Stand zeigt.
      const REPORT_STORAGE_KEY = 'pocketlog.report';
      const REPORT_IDS = ['overview', 'month', 'year', 'categories', 'tags', 'trend', 'forecast', 'top'];
      const REPORT_TITLES = {
        overview: 'Übersicht',
        month: 'Monatsverlauf',
        year: 'Jahresverlauf',
        categories: 'Kategorienanalyse',
        tags: 'Taganalyse',
        trend: 'Trend',
        forecast: 'Prognose',
        top: 'Größte Ausgaben',
      };
      let currentReport = (() => {
        const v = localStorage.getItem(REPORT_STORAGE_KEY);
        return REPORT_IDS.includes(v) ? v : 'overview';
      })();
      const _today = new Date();
      let reportRange = {
        kind: 'month',
        anchor: {
          y: _today.getFullYear(),
          m: _today.getMonth(),
          q: Math.floor(_today.getMonth() / 3),
        },
        from: '',
        to: '',
      };
      // Optionaler Lock: 'month' oder 'year' erzwingt den Picker-Modus für Reports,
      // die nur in dieser Granularität sinnvoll sind. null = frei wählbar.
      let _rangeLock = null;
      // Chart.js-Instanzen pro Report, getrennt damit destroy() keine fremde Instanz trifft.
      const chartInsts = { month: null, year: null, categories: null, tags: null, trend: null, sparkline: null };

      // ── TREND-STATE ───────────────────────────────────────────────────────────────
      const TREND_STORAGE_KEY = 'pocketlog.trend';
      const TREND_RANGE_KEY = 'pocketlog.trend.range';
      let _trendKind = 'category';          // 'category' | 'tag'
      let _trendSelection = [];              // ['cat:42'] heute, später bis zu 3
      let _trendPickerOpen = false;
      let _trendPickerFilter = '';
      let _earliestTxDate = null;            // Session-Cache
      let _trendYearFrom = null;             // integer, z.B. 2022
      let _trendYearTo = null;               // integer, z.B. 2026
      (function _restoreTrendState() {
        try {
          const raw = localStorage.getItem(TREND_STORAGE_KEY);
          if (raw) {
            const s = JSON.parse(raw);
            if (s.kind === 'category' || s.kind === 'tag') _trendKind = s.kind;
            if (Array.isArray(s.selection)) {
              _trendSelection = s.selection
                .filter((e) => typeof e === 'string' && (e.startsWith('cat:') || e.startsWith('tag:')))
                .slice(0, 3);
            }
          }
        } catch (e) {}
        try {
          const raw = localStorage.getItem(TREND_RANGE_KEY);
          if (raw) {
            const r = JSON.parse(raw);
            if (r && Number.isInteger(r.yearFrom) && Number.isInteger(r.yearTo)) {
              _trendYearFrom = r.yearFrom;
              _trendYearTo = r.yearTo;
            }
          }
        } catch (e) {}
      })();
      // Pro-Jahr-Cache der Transaktionen. Bei jedem write geleert.
      const _txCacheByYear = new Map();
      function invalidateReportCache() {
        _txCacheByYear.clear();
      }
      // Beim Drill-Down aus der Kategorienanalyse merken, wohin „Abbrechen" zurückspringt.
      let _searchExitTarget = null;
      // Letzte vom aktiven Report geladene Transaktionen — wird von editTransaction
      // konsultiert, damit ein Klick auf eine Top-Liste die echte Buchung findet
      // (nicht nur die des aktuellen Monats aus der Transaktions-View).
      let _reportTxPool = null;

      let transactions = []; // wird per API geladen
      let categories = []; // wird per API geladen
      let availableTags = []; // distinkte Tags des Users (alphabetisch sortiert)
      const tagCounts = new Map(); // tag-name (case-folded) → Anzahl Verwendungen

      // ── API HELPER ────────────────────────────────────────────────────────────────
      // Same-origin Cookie-Session. CSRF-Token wird beim Login / Bootstrap
      // eingesammelt und in window._csrfToken gehalten. Bei 401 reload-en
      // wir hart, damit init() sauber auf die Login-View landet — kein
      // veralteter App-State bleibt im DOM.
      window._csrfToken = '';

      // Auth-Boundary-Cleanup: vor jedem 401-induzierten Reload den
      // API-Cache und den im SW gehaltenen CSRF-Token wegwerfen. Sonst
      // würde der nächste Page-Load auf eine gecachte me-Response treffen
      // (Force-Change-View ohne Session), oder die Outbox einen stale
      // CSRF-Token mitschicken (403 beim Replay → silent Datenverlust).
      function _resetAuthClientState() {
        try {
          if (navigator.serviceWorker?.controller) {
            navigator.serviceWorker.controller.postMessage({ type: 'CLEAR_API_CACHE' });
          }
        } catch (_) {}
        window._csrfToken = '';
      }

      // Nuklearer Reset: SW unregistrieren UND alle Caches platt machen.
      // Wird vom Force-Change-Pfad als Escape-Hatch genutzt, wenn die
      // Server-Antwort beweist, dass die gerade gerenderte View zum echten
      // Session-State nicht passt — typisch ein alter SW oder ein
      // iOS-„Frozen-Page-Cache", der noch die alte 200/me-Response
      // festhält, obwohl „Verlauf und Websitedaten löschen" schon
      // durchgelaufen ist. localStorage bleibt drin, damit Theme +
      // Default-View überleben.
      async function _hardResetClientState() {
        try {
          if ('serviceWorker' in navigator) {
            const regs = await navigator.serviceWorker.getRegistrations();
            await Promise.all(regs.map((r) => r.unregister().catch(() => null)));
          }
        } catch (_) {}
        try {
          if ('caches' in window) {
            const keys = await caches.keys();
            await Promise.all(keys.map((k) => caches.delete(k).catch(() => null)));
          }
        } catch (_) {}
        window._csrfToken = '';
        // Mit cache-busting-Param laden, damit Safari den BFCache nicht
        // einfach wieder hinrendert. Reicht für iOS Safari-Eigenheiten.
        location.replace('/?reset=' + Date.now());
      }

      async function api(method, path, body) {
        const headers = { 'Content-Type': 'application/json' };
        if (method !== 'GET' && window._csrfToken) {
          headers['X-CSRF-Token'] = window._csrfToken;
        }
        const opts = { method, headers, credentials: 'same-origin' };
        if (body) opts.body = JSON.stringify(body);
        const res = await fetch(API + path, opts);
        if (res.status === 401) {
          if (!window._suppressAuthReload) {
            _resetAuthClientState();
            location.reload();
          }
          throw new Error('session expired');
        }
        if (!res.ok) throw new Error(`API ${method} ${path} → ${res.status}`);
        if (method !== 'GET') invalidateReportCache();
        if (res.status === 204) return null;
        return res.json();
      }

      // Auth-Endpoints umgehen api() — bei 401/429 wollen wir die Antwort
      // selbst behandeln, ohne in den location.reload()-Pfad zu fallen.
      // ABER: wenn der Caller ``opts.reloadOn401 !== false`` lässt und
      // eine 401 kommt, machen wir trotzdem den harten Reload — sonst
      // bleibt der User in einer View hängen, zu der sein Session-State
      // nicht mehr passt.
      async function authFetch(method, path, body, opts = {}) {
        const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
        if (opts.csrf !== false && method !== 'GET' && window._csrfToken) {
          headers['X-CSRF-Token'] = window._csrfToken;
        }
        const init = { method, headers, credentials: 'same-origin' };
        if (body !== undefined) init.body = JSON.stringify(body);
        const res = await fetch(API + path, init);
        if (res.status === 401 && opts.reloadOn401 !== false) {
          _resetAuthClientState();
          location.reload();
        }
        return res;
      }

      function _broadcastCsrfToSw(token) {
        try {
          if (navigator.serviceWorker?.controller) {
            navigator.serviceWorker.controller.postMessage({
              type: 'SET_CSRF',
              token: token || '',
            });
          }
        } catch (_) {}
      }

      // Passwort-Policy: 12 Zeichen + 4 Zeichenklassen. Spiegelt die
      // Server-seitige Regel in schemas.validate_password_complexity —
      // beide Stellen müssen synchron bleiben. Unicode-property-Regex,
      // damit „Ä", „ß", „é" wie auf dem Server als Buchstaben zählen
      // (und nicht als Sonderzeichen).
      const PWD_MIN_LENGTH = 12;
      function validateNewPassword(pw) {
        if (pw.length < PWD_MIN_LENGTH) {
          return `Das Passwort muss mindestens ${PWD_MIN_LENGTH} Zeichen lang sein.`;
        }
        if (!/\p{Lu}/u.test(pw)) {
          return 'Das Passwort braucht mindestens einen Großbuchstaben.';
        }
        if (!/\p{Ll}/u.test(pw)) {
          return 'Das Passwort braucht mindestens einen Kleinbuchstaben.';
        }
        if (!/\d/.test(pw)) {
          return 'Das Passwort braucht mindestens eine Zahl.';
        }
        if (!/[^\p{L}\p{N}]/u.test(pw)) {
          return 'Das Passwort braucht mindestens ein Sonderzeichen.';
        }
        return null;
      }

      // ── FORMATTING ────────────────────────────────────────────────────────────────
      const fmtCurrency = (n) =>
        new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(n);
      const fmtSignedCurrency = (n) =>
        new Intl.NumberFormat('de-DE', {
          style: 'currency',
          currency: 'EUR',
          signDisplay: 'always',
        }).format(n);
      const MONTHS = [
        'Januar',
        'Februar',
        'März',
        'April',
        'Mai',
        'Juni',
        'Juli',
        'August',
        'September',
        'Oktober',
        'November',
        'Dezember',
      ];
      const MONTHS_SHORT = [
        'Jan',
        'Feb',
        'Mär',
        'Apr',
        'Mai',
        'Jun',
        'Jul',
        'Aug',
        'Sep',
        'Okt',
        'Nov',
        'Dez',
      ];

      // ── TOAST + CONFIRM (replaces native alert/confirm) ──────────────────────────
      function toast(message, type = 'info') {
        const host = document.getElementById('toastHost');
        if (!host) return;
        const el = document.createElement('div');
        el.className = 'toast' + (type === 'error' ? ' error' : '');
        el.textContent = message;
        if (type === 'error') el.setAttribute('role', 'alert');
        host.appendChild(el);
        const dwell = type === 'error' ? 5000 : 3200;
        setTimeout(() => {
          el.classList.add('leaving');
          el.addEventListener('animationend', () => el.remove(), { once: true });
        }, dwell);
      }

      function confirmAction({
        title,
        message = '',
        confirmLabel = 'Bestätigen',
        cancelLabel = 'Abbrechen',
        destructive = true,
      }) {
        return new Promise((resolve) => {
          const prevFocus = document.activeElement;
          const overlay = document.createElement('div');
          overlay.className = 'modal-overlay open';
          overlay.style.alignItems = 'center';

          const modal = document.createElement('div');
          modal.className = 'modal confirm-modal';
          modal.setAttribute('role', 'alertdialog');
          modal.setAttribute('aria-modal', 'true');
          modal.setAttribute('aria-labelledby', 'confirmTitle');

          const h = document.createElement('h2');
          h.id = 'confirmTitle';
          h.textContent = title;
          modal.appendChild(h);

          if (message) {
            const p = document.createElement('p');
            p.className = 'confirm-msg';
            p.textContent = message;
            modal.appendChild(p);
          }

          const yes = document.createElement('button');
          yes.className = 'submit-btn confirm-yes' + (destructive ? ' btn-destructive' : '');
          yes.type = 'button';
          yes.textContent = confirmLabel;
          modal.appendChild(yes);

          const no = document.createElement('button');
          no.className = 'confirm-cancel';
          no.type = 'button';
          no.textContent = cancelLabel;
          modal.appendChild(no);

          overlay.appendChild(modal);

          // Cycle Tab between yes/no — the alert-dialog has no other focusable
          // controls, so a manual trap is simpler than reusing trapFocusIn().
          const onKey = (e) => {
            if (e.key === 'Tab') {
              e.preventDefault();
              (document.activeElement === yes ? no : yes).focus();
            }
          };

          const close = (result) => {
            overlay.removeEventListener('keydown', onKey);
            overlay.remove();
            // Only release scroll-lock if no other modal is still open.
            const stillOpen = document.querySelector('.modal-overlay.open');
            if (!stillOpen) document.body.style.overflow = '';
            if (prevFocus && document.contains(prevFocus) && typeof prevFocus.focus === 'function') {
              prevFocus.focus();
            }
            resolve(result);
          };
          overlay.addEventListener('click', (e) => {
            if (e.target === overlay) close(false);
          });
          overlay.addEventListener('keydown', onKey);
          document.body.appendChild(overlay);
          document.body.style.overflow = 'hidden';
          yes.addEventListener('click', () => close(true));
          no.addEventListener('click', () => close(false));
          setTimeout(() => no.focus(), 50);
        });
      }

      // ── NAVIGATION ────────────────────────────────────────────────────────────────
      let _activePanel = 'transactions';
      let _searchQuery = '';
      let _allTransactions = null;
      // Exact category filter set when the user taps the "more" icon on a
      // category row. Mutually exclusive with text search — typing in the
      // search input clears it (`onSearch`).
      let _categoryFilterId = null;
      // Exact tag filter set when the user drills down from the tag analysis.
      // Mutually exclusive with text search and category filter.
      let _tagFilterName = null;

      function _resetSearch() {
        _searchQuery = '';
        _categoryFilterId = null;
        _tagFilterName = null;
        _allTransactions = null;
        _searchExitTarget = null;
        document.body.classList.remove('searching');
        document.getElementById('searchInput').value = '';
        const fab = document.querySelector('.fab');
        if (fab) {
          fab.innerHTML = ICON_SVG.plus;
          fab.classList.remove('search-exit');
          fab.setAttribute('aria-label', 'Neue Buchung');
          fab.onclick = () => openModal();
        }
      }

      function showPanel(id) {
        if (_searchQuery || _categoryFilterId != null || _tagFilterName != null) _resetSearch();
        _activePanel = id;
        document.body.classList.toggle('in-report', id === 'charts');
        if (id !== 'charts') _reportTxPool = null;
        document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
        document.getElementById('panel-' + id).classList.add('active');
        document.querySelectorAll('.drawer-nav-item[data-panel]').forEach((btn) => {
          btn.classList.toggle('active', btn.dataset.panel === id);
        });
        if (id === 'charts') renderReport();
        if (id === 'categories') renderCategoryView();
        closeDrawer();
      }

      // Wird aus dem Drawer-Subpanel „Auswertungen" aufgerufen. Setzt den aktiven
      // Report (inkl. Lock-Mode bei Monat-/Jahresverlauf) und schaltet auf das
      // Charts-Panel.
      function openReport(id) {
        if (!REPORT_IDS.includes(id)) id = 'overview';
        if (id === 'trend') _trendPickerOpen = false;
        currentReport = id;
        try {
          localStorage.setItem(REPORT_STORAGE_KEY, id);
        } catch (e) {}
        if (id === 'month' && reportRange.kind !== 'month') setRangeKind('month', { skipRender: true });
        if (id === 'year' && reportRange.kind !== 'year') setRangeKind('year', { skipRender: true });
        showPanel('charts');
      }

      const _drawerStack = [];
      const _drawerSubs = ['dpReports', 'dpSettings', 'dpCats', 'dpTags', 'dpImport', 'dpDisplay', 'dpAdmin', 'dpInfo'];

      function drawerNav(panelId) {
        const current = _drawerStack.length ? _drawerStack[_drawerStack.length - 1] : 'dpMain';
        document.getElementById(current).dataset.state = 'left';
        document.getElementById(panelId).dataset.state = 'active';
        _drawerStack.push(panelId);
        document.getElementById('drawer').classList.add('sub-active');
        if (panelId === 'dpCats') renderCategories();
        if (panelId === 'dpTags') renderTagList();
        if (panelId === 'dpDisplay') syncDefaultViewRadios();
        if (panelId === 'dpInfo') renderInfoPanel();
        if (panelId === 'dpAdminUsers') loadAdminUsers();
      }

      function drawerBack() {
        if (!_drawerStack.length) return;
        const current = _drawerStack.pop();
        const prev = _drawerStack.length ? _drawerStack[_drawerStack.length - 1] : 'dpMain';
        document.getElementById(current).dataset.state = 'right';
        document.getElementById(prev).dataset.state = 'active';
        if (!_drawerStack.length) document.getElementById('drawer').classList.remove('sub-active');
      }

      function _drawerResetPanels() {
        document.getElementById('dpMain').dataset.state = 'active';
        _drawerSubs.forEach((id) => {
          document.getElementById(id).dataset.state = 'right';
        });
        _drawerStack.length = 0;
        document.getElementById('drawer').classList.remove('sub-active');
      }

      // ≥768px: drawer is a persistent sidebar — open/close become no-ops
      // so a stray call (e.g. from showPanel) doesn't trap focus or lock
      // body scroll. Keep this in sync with the @media breakpoint in
      // styles.css (see "ADAPTIVE LAYOUT" block).
      const _mqTablet = window.matchMedia('(min-width: 768px)');

      // Apple-Mail style sidebar toggle (tablet only). The collapsed
      // class lives on <html> because the inline restore in index.html
      // runs before <body> exists; CSS targets html.sidebar-collapsed.
      // The aria-pressed sync mirrors the visual state for screen readers
      // — the icon swap (arrows-in ↔ arrows-out) is purely CSS-driven.
      function _syncSidebarTogglePressed(collapsed) {
        const btn = document.querySelector('.sidebar-toggle-btn');
        if (btn) btn.setAttribute('aria-pressed', collapsed ? 'true' : 'false');
      }

      function toggleSidebar() {
        const collapsed = document.documentElement.classList.toggle(
          'sidebar-collapsed'
        );
        _syncSidebarTogglePressed(collapsed);
        try {
          localStorage.setItem(
            'pocketlog.sidebarCollapsed',
            collapsed ? '1' : '0'
          );
        } catch (e) {}
      }

      // app.js is loaded with `defer`, so the DOM is ready — sync the
      // aria-pressed attribute with the class state set by the inline
      // head boot script.
      _syncSidebarTogglePressed(
        document.documentElement.classList.contains('sidebar-collapsed')
      );

      function openDrawer() {
        if (_mqTablet.matches) return;
        rememberModalFocus('drawer');
        document.getElementById('drawer').classList.add('open');
        document.getElementById('drawerOverlay').classList.add('open');
        document.body.style.overflow = 'hidden';
        trapFocusIn(document.getElementById('drawer'), 'drawer');
      }

      function closeDrawer() {
        if (_mqTablet.matches) return;
        document.getElementById('drawer').classList.remove('open');
        document.getElementById('drawerOverlay').classList.remove('open');
        document.body.style.overflow = '';
        releaseFocusTrap('drawer');
        restoreModalFocus('drawer');
        // _drawerStack and sub-panel data-state are deliberately kept:
        // re-opening the drawer should land back on the last sub-panel
        // the user was on (e.g. Auswertungen), not always reset to the
        // top level. _drawerResetPanels is reserved for explicit resets.
      }

      // Rotate / resize crossing the tablet breakpoint while a mobile
      // overlay is open would leave the body scroll-locked. Reset state
      // when we enter sidebar mode.
      _mqTablet.addEventListener('change', (e) => {
        if (!e.matches) return;
        document.getElementById('drawer').classList.remove('open');
        document.getElementById('drawerOverlay').classList.remove('open');
        releaseFocusTrap('drawer');
        // Only release the scroll lock if no modal is still open.
        if (!document.querySelector('.modal-overlay.open')) {
          document.body.style.overflow = '';
        }
      });

      // Keyboard activation for elements that are interactive but cannot be
      // a <button> (e.g. row contains a nested action button). Mirrors native
      // button semantics: Enter and Space trigger the click; Space is
      // prevented from scrolling. The `!e.repeat` guard avoids re-firing
      // while the key is held. `.is-key-active` gives the keyboard press
      // the same visual feedback that mouse `:active` does.
      function handleRowActivate(e, fn) {
        if ((e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') && !e.repeat) {
          e.preventDefault();
          const el = e.currentTarget;
          el.classList.add('is-key-active');
          setTimeout(() => el.classList.remove('is-key-active'), 150);
          fn();
        }
      }

      // ── MODAL FOCUS MANAGEMENT ────────────────────────────────────────────────────
      // Each modal stores the element that had focus before it opened, so the
      // matching close() can restore it. Keyed by modal id to support nesting
      // (tag picker opens from inside the booking modal).
      const _modalPrevFocus = new Map();
      const _modalTrapTeardown = new Map();

      function rememberModalFocus(key) {
        _modalPrevFocus.set(key, document.activeElement);
      }

      function restoreModalFocus(key) {
        const el = _modalPrevFocus.get(key);
        _modalPrevFocus.delete(key);
        if (el && document.contains(el) && typeof el.focus === 'function') {
          el.focus();
        }
      }

      // Wraps Tab cycling inside the given root element. Returns nothing; call
      // releaseFocusTrap(key) to remove the listener when the modal closes.
      function trapFocusIn(rootEl, key) {
        const handler = (e) => {
          if (e.key !== 'Tab') return;
          const focusable = rootEl.querySelectorAll(
            'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
          );
          const visible = Array.from(focusable).filter((el) => el.offsetParent !== null);
          if (!visible.length) return;
          const first = visible[0];
          const last = visible[visible.length - 1];
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        };
        rootEl.addEventListener('keydown', handler);
        _modalTrapTeardown.set(key, () => rootEl.removeEventListener('keydown', handler));
      }

      function releaseFocusTrap(key) {
        const fn = _modalTrapTeardown.get(key);
        if (fn) fn();
        _modalTrapTeardown.delete(key);
      }

      function changeMonth(d) {
        currentMonth += d;
        if (currentMonth > 11) {
          currentMonth = 0;
          currentYear++;
        }
        if (currentMonth < 0) {
          currentMonth = 11;
          currentYear--;
        }
        loadAndRender();
      }
      // ── LOAD & RENDER ─────────────────────────────────────────────────────────────
      function normalizeTx(t) {
        // Tags come pre-resolved from the server (M2M-backed since
        // 0008_transaction_tags) — each name is the canonical row in
        // the tags table, so no client-side casing fix-up is needed.
        return { ...t, amount: Number(t.amount), tags: (t.tags || []).slice() };
      }

      async function loadAndRender() {
        document.getElementById('monthLabel').textContent =
          `${MONTHS[currentMonth]} ${currentYear}`;
        try {
          const raw = await api(
            'GET',
            `/transactions?year=${currentYear}&month=${currentMonth + 1}`
          );
          transactions = raw.map(normalizeTx);
        } catch (e) {
          console.error('Fehler beim Laden:', e);
          transactions = [];
        }
        renderAll();
        if (_searchQuery) {
          try {
            const all = await api('GET', '/transactions');
            _allTransactions = all.map(normalizeTx);
          } catch (e) {
            _allTransactions = [];
          }
          applySearch();
        }
      }

      function renderAll() {
        document.getElementById('monthLabel').textContent =
          `${MONTHS[currentMonth]} ${currentYear}`;
        const out = transactions.filter((t) => t.type === 'out').reduce((a, t) => a + t.amount, 0);
        const inc = transactions.filter((t) => t.type === 'in').reduce((a, t) => a + t.amount, 0);
        // No +/− sign on the summary cards — the label and the
        // positive/negative color already convey direction, and dropping the
        // sign keeps long amounts from overflowing the card's right edge.
        // Matches the report-view summary cards (fmtCurrency for in/out).
        document.getElementById('totalOut').textContent = fmtCurrency(out);
        document.getElementById('totalIn').textContent = fmtCurrency(inc);
        applySearch();
        if (_activePanel === 'categories') renderCategoryView();
      }

      function applySearch() {
        const q = _searchQuery;
        const catFilter = _categoryFilterId;
        const tagFilter = _tagFilterName;
        if (!q && catFilter == null && tagFilter == null) {
          renderTransactions(transactions);
          return;
        }
        // The drill-down from the monthly view leaves `_allTransactions` unset,
        // so we naturally fall back to the month-scoped `transactions` pool.
        // When the drill-down comes from a report, `_allTransactions` holds the
        // report range — same logic, just a wider pool.
        const pool = _allTransactions ?? transactions;
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
          fab.setAttribute('aria-label', 'Suche beenden');
          fab.onclick = clearSearch;
          // Only load the global pool for text search — category drill-down
          // stays month-scoped via the already-loaded `transactions`.
          if (_searchQuery && !_allTransactions) {
            try {
              const raw = await api('GET', '/transactions');
              _allTransactions = raw.map(normalizeTx);
            } catch (e) {
              _allTransactions = [];
            }
          }
          applySearch();
        } else {
          _allTransactions = null;
          document.body.classList.remove('searching');
          document.getElementById('panel-search').classList.remove('active');
          document.getElementById('panel-' + _activePanel).classList.add('active');
          fab.innerHTML = ICON_SVG.plus;
          fab.classList.remove('search-exit');
          fab.setAttribute('aria-label', 'Neue Buchung');
          fab.onclick = () => openModal();
        }
      }

      async function onSearch(val) {
        // Typing in the search input cancels any active drill-down filter
        // so the panel switches back to plain text-match behaviour.
        if (_categoryFilterId != null) _categoryFilterId = null;
        if (_tagFilterName != null) _tagFilterName = null;
        const wasEmpty = !_searchQuery;
        _searchQuery = val.trim().toLowerCase();
        if (_searchQuery && wasEmpty) await _setSearchPanelActive(true);
        else if (!_searchQuery && !wasEmpty) _setSearchPanelActive(false);
        else applySearch();
      }

      function clearSearch() {
        const wasActive = !!_searchQuery || _categoryFilterId != null || _tagFilterName != null;
        const exitTo = _searchExitTarget;
        _searchExitTarget = null;
        _resetSearch();
        if (wasActive) _setSearchPanelActive(false);
        if (exitTo) showPanel(exitTo);
      }

      function getCatById(id) {
        return (
          categories.find((c) => c.id === Number(id)) || {
            name: 'Sonstiges',
            icon: 'package',
            color: '#9e9b96',
          }
        );
      }

      function renderTransactions(txs, el = document.getElementById('transactionList')) {
        if (!txs.length) {
          el.innerHTML = _searchQuery
            ? `<div class="empty-state"><svg class="icon" aria-hidden="true"><use href="#icon-search"/></svg><p>Keine Buchungen passen zu „${_escText(_searchQuery)}“.<br>Andere Schreibweise versuchen.</p></div>`
            : `<div class="empty-state"><svg class="icon" aria-hidden="true"><use href="#icon-inbox-empty"/></svg><p>Keine Buchungen in diesem Monat.<br>Tippe auf <strong>+</strong>, um eine hinzuzufügen.</p></div>`;
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
                ? 'Heute'
                : dDay.getTime() === today.getTime() - 86400000
                  ? 'Gestern'
                  : d.toLocaleDateString('de-DE', {
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
                  return `<div class="tx-row" data-id="${t.id}">
        <button class="tx-action" type="button" aria-label="Buchung löschen">Löschen</button>
        <div class="transaction">
          <div class="t-icon" style="--cat-color:${cat.color}">${catIconSvg(cat.icon)}</div>
          <span class="visually-hidden">${_escText(cat.name)}</span>
          <div class="t-info">
            <div class="t-note">${_escText(note)}</div>
            <div class="t-tags">${tagsHtml}</div>
          </div>
          <div class="t-amount ${t.type}">${fmtSignedCurrency(t.type === 'out' ? -Math.abs(t.amount) : Math.abs(t.amount))}</div>
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

        if (!categories.length) {
          el.innerHTML = `<div class="empty-state"><svg class="icon" aria-hidden="true"><use href="#icon-inbox-empty"/></svg><p>Keine Kategorien vorhanden.<br>Erstelle Kategorien in den Einstellungen.</p></div>`;
          return;
        }

        // Net amount per category from current month's transactions
        const totals = {};
        transactions.forEach((t) => {
          const key = t.category_id ?? 0;
          if (!totals[key]) totals[key] = 0;
          totals[key] += t.type === 'out' ? -t.amount : t.amount;
        });

        // All categories, sorted alphabetically — zero if no transactions this month
        const rows = categories
          .map((cat) => ({ id: cat.id, name: cat.name, icon: cat.icon, color: cat.color, net: totals[cat.id] ?? 0 }))
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

        el.innerHTML = rows
          .map(
            (r) => `
    <div class="cat-view-row" role="button" tabindex="0"
      aria-label="Kategorie „${_escAttr(r.name)}“ bearbeiten"
      onclick="openModalForCategory(${r.id})"
      onkeydown="handleRowActivate(event, () => openModalForCategory(${r.id}))">
      <span class="cat-view-icon" style="--cat-color:${r.color}">${catIconSvg(r.icon)}</span>
      <span class="cat-view-name">${_escText(r.name)}</span>
      <span class="cat-view-amount ${r.net > 0 ? 'positive' : r.net < 0 ? 'negative' : ''}">${fmtCurrency(r.net)}</span>
      <button
        type="button"
        class="cat-view-more"
        aria-label="Buchungen in „${_escAttr(r.name)}“ ansehen"
        onclick="event.stopPropagation(); showTransactionsForCategory(${r.id})"
      ><svg class="ui-icon" aria-hidden="true"><use href="#icon-more-vertical"/></svg></button>
    </div>
  `
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
        // filter is exact-by-id (applySearch checks _categoryFilterId
        // before the substring search path).
        _categoryFilterId = catId;
        _searchQuery = '';
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
              title: 'Buchung wirklich löschen?',
              confirmLabel: 'Löschen',
            });
            if (!ok) {
              row.classList.remove('swiped');
              return;
            }
            try {
              await api('DELETE', `/transactions/${id}`);
              await loadAndRender();
            } catch (err) {
              if (!navigator.onLine && window.PocketLogOutbox) {
                await window.PocketLogOutbox.enqueue({
                  method: 'DELETE',
                  path: `/transactions/${id}`,
                });
                row.classList.remove('swiped');
                // Optimistisch entfernen, Sync übernimmt der SW
                transactions = transactions.filter((t) => t.id !== id);
                renderAll();
                updateSyncBadge();
                return;
              }
              toast('Fehler beim Löschen: ' + err.message, 'error');
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
        { capture: true }
      );

      // ── CHARTS ────────────────────────────────────────────────────────────────────
      function getChartColors() {
        // Read the effective theme from data-dark — same source CSS uses.
        const dark = document.documentElement.getAttribute('data-dark') === 'true';
        return {
          grid: dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
          text: dark ? '#a09d98' : '#6b6760',
        };
      }

      // Liest einen CSS-Custom-Property-Wert aus dem aktiven Theme. Wenn `alpha` < 1
       // wird der Hex-Wert nach rgba() konvertiert, damit Chart.js eine transparente
      // Variante zeichnen kann. Nur Hex-Tokens (#RRGGBB) werden unterstützt — alle
      // Reports-Akzente sind als Hex hinterlegt.
      function cssColor(name, alpha = 1) {
        const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        if (alpha >= 1 || !v.startsWith('#')) return v;
        const n = parseInt(v.slice(1), 16);
        return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
      }

      // ── REPORTS — RANGE & DATA ────────────────────────────────────────────────────

      function _iso(y, m, d) {
        return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      }
      function _daysInMonth(y, m) {
        return new Date(y, m + 1, 0).getDate();
      }
      function computeRange(kind, a) {
        if (kind === 'month') {
          const last = _daysInMonth(a.y, a.m);
          return { from: _iso(a.y, a.m, 1), to: _iso(a.y, a.m, last) };
        }
        if (kind === 'quarter') {
          const startM = a.q * 3;
          const endM = startM + 2;
          const last = _daysInMonth(a.y, endM);
          return { from: _iso(a.y, startM, 1), to: _iso(a.y, endM, last) };
        }
        if (kind === 'year') {
          return { from: _iso(a.y, 0, 1), to: _iso(a.y, 11, 31) };
        }
        // custom: from/to bleiben wie zuletzt eingegeben.
        return { from: reportRange.from, to: reportRange.to };
      }

      function applyRange(opts = {}) {
        const r = computeRange(reportRange.kind, reportRange.anchor);
        if (reportRange.kind !== 'custom') {
          reportRange.from = r.from;
          reportRange.to = r.to;
        }
        updatePickerUI();
        if (!opts.skipRender && _activePanel === 'charts') renderReport();
      }

      function setRangeKind(kind, opts = {}) {
        if (_rangeLock && kind !== _rangeLock) return;
        if (!['month', 'quarter', 'year', 'custom'].includes(kind)) return;
        reportRange.kind = kind;
        if (kind === 'custom' && (!reportRange.from || !reportRange.to)) {
          // Beim Wechsel auf „Eigen" mit den aktuellen Monatsgrenzen vorbelegen.
          const r = computeRange('month', reportRange.anchor);
          reportRange.from = r.from;
          reportRange.to = r.to;
        }
        applyRange(opts);
      }

      function shiftRange(delta) {
        const a = reportRange.anchor;
        if (reportRange.kind === 'month') {
          let m = a.m + delta, y = a.y;
          while (m < 0) { m += 12; y--; }
          while (m > 11) { m -= 12; y++; }
          a.m = m; a.y = y; a.q = Math.floor(m / 3);
        } else if (reportRange.kind === 'quarter') {
          let q = a.q + delta, y = a.y;
          while (q < 0) { q += 4; y--; }
          while (q > 3) { q -= 4; y++; }
          a.q = q; a.y = y; a.m = q * 3;
        } else if (reportRange.kind === 'year') {
          a.y += delta;
        } else {
          return; // Custom hat keinen Stepper
        }
        applyRange();
      }

      function onCustomRangeChange() {
        const from = document.getElementById('rangeFrom').value;
        const to = document.getElementById('rangeTo').value;
        if (!from || !to) return;
        if (from > to) {
          toast('Enddatum muss nach Startdatum liegen.');
          return;
        }
        reportRange.from = from;
        reportRange.to = to;
        renderReport();
      }

      function setRangeLock(kind) {
        _rangeLock = kind;
        const tabs = document.querySelectorAll('#rangeKindTabs button');
        tabs.forEach((b) => {
          const allowed = !kind || b.dataset.kind === kind;
          b.disabled = !allowed;
          b.setAttribute('aria-disabled', String(!allowed));
        });
      }

      function _rangeStepperLabel() {
        const a = reportRange.anchor;
        if (reportRange.kind === 'month') return `${MONTHS[a.m]} ${a.y}`;
        if (reportRange.kind === 'quarter') return `Q${a.q + 1} ${a.y}`;
        if (reportRange.kind === 'year') return `${a.y}`;
        return '';
      }

      function _rangeSubtitle(txCount) {
        const noun = txCount === 1 ? 'Buchung' : 'Buchungen';
        if (reportRange.kind === 'custom') {
          const fmt = (iso) => {
            const [y, m, d] = iso.split('-');
            return `${d}.${m}.${y}`;
          };
          return `${fmt(reportRange.from)} – ${fmt(reportRange.to)} · ${txCount} ${noun}`;
        }
        return `${_rangeStepperLabel()} · ${txCount} ${noun}`;
      }

      function updatePickerUI() {
        document.querySelectorAll('#rangeKindTabs button').forEach((b) => {
          const active = b.dataset.kind === reportRange.kind;
          b.setAttribute('aria-selected', String(active));
          b.classList.toggle('is-active', active);
        });
        const stepper = document.getElementById('rangeStepper');
        const custom = document.getElementById('rangeCustom');
        if (reportRange.kind === 'custom') {
          stepper.hidden = true;
          custom.hidden = false;
          document.getElementById('rangeFrom').value = reportRange.from || '';
          document.getElementById('rangeTo').value = reportRange.to || '';
        } else {
          stepper.hidden = false;
          custom.hidden = true;
          document.getElementById('rangeStepperLabel').textContent = _rangeStepperLabel();
        }
      }

      async function _loadYearTxs(year) {
        if (_txCacheByYear.has(year)) return _txCacheByYear.get(year);
        try {
          const raw = await api('GET', `/transactions?year=${year}`);
          const txs = raw.map(normalizeTx);
          _txCacheByYear.set(year, txs);
          return txs;
        } catch (e) {
          return [];
        }
      }

      async function loadRangeTxs(from, to) {
        if (!from || !to) return [];
        const y1 = parseInt(from.slice(0, 4), 10);
        const y2 = parseInt(to.slice(0, 4), 10);
        const years = [];
        for (let y = y1; y <= y2; y++) years.push(y);
        const pools = await Promise.all(years.map(_loadYearTxs));
        const all = pools.flat();
        return all.filter((t) => t.date >= from && t.date <= to);
      }

      // ── REPORTS — RENDER DISPATCH ─────────────────────────────────────────────────

      async function renderReport(id = currentReport) {
        if (!REPORT_IDS.includes(id)) id = 'overview';
        currentReport = id;
        try {
          localStorage.setItem(REPORT_STORAGE_KEY, id);
        } catch (e) {}
        document.body.setAttribute('data-report', id);
        if (id === 'trend') {
          await _ensureTrendDefaultRange();
        }
        const locks = { month: 'month', year: 'year' };
        setRangeLock(locks[id] || null);
        if (_rangeLock && reportRange.kind !== _rangeLock) {
          reportRange.kind = _rangeLock;
          applyRange({ skipRender: true });
        }
        updatePickerUI();
        document.getElementById('reportTitle').textContent = REPORT_TITLES[id];

        Object.keys(chartInsts).forEach((k) => {
          if (chartInsts[k]) {
            chartInsts[k].destroy();
            chartInsts[k] = null;
          }
        });

        const body = document.getElementById('reportBody');
        body.innerHTML = '';

        // Trend uses its own private year range and never touches reportRange.
        const rangeFrom = id === 'trend' ? `${_trendYearFrom}-01-01` : reportRange.from;
        const rangeTo   = id === 'trend' ? `${_trendYearTo}-12-31`   : reportRange.to;
        const txs = await loadRangeTxs(rangeFrom, rangeTo);
        _reportTxPool = txs;
        document.getElementById('reportRangeLabel').textContent = _rangeSubtitle(txs.length);

        if (id === 'overview') await renderReportOverview(body, txs);
        else if (id === 'month') renderReportMonth(body, txs);
        else if (id === 'year') await renderReportYear(body, txs);
        else if (id === 'categories') renderReportCategories(body, txs);
        else if (id === 'tags') renderReportTags(body, txs);
        else if (id === 'trend') await renderReportTrend(body, txs);
        else if (id === 'forecast') await renderReportForecast(body, txs);
        else if (id === 'top') renderReportTop(body, txs);
      }

      // ── REPORTS — SHARED HELPERS ──────────────────────────────────────────────────

      function _sumByType(txs) {
        let out = 0, inn = 0;
        for (const t of txs) {
          if (t.type === 'out') out += t.amount;
          else inn += t.amount;
        }
        return { out, in: inn };
      }

      function _totalsByCategory(txs, type = 'out') {
        const totals = {};
        for (const t of txs) {
          if (t.type !== type) continue;
          totals[t.category_id] = (totals[t.category_id] || 0) + t.amount;
        }
        return Object.entries(totals)
          .map(([id, amt]) => ({ catId: parseInt(id, 10), amount: amt }))
          .sort((a, b) => b.amount - a.amount);
      }

      function _catRowMarkup(catId, amount, max, opts = {}) {
        const cat = getCatById(catId);
        if (!cat) return '';
        const pct = max > 0 ? (amount / max) * 100 : 0;
        const drill = opts.drillDown
          ? `role="button" tabindex="0" onclick="drillDownCategory(${catId})" onkeydown="handleRowActivate(event, () => drillDownCategory(${catId}))"`
          : '';
        return `<div class="cat-row" ${drill}>
          <div class="cat-icon" style="--cat-color:${cat.color}">${catIconSvg(cat.icon)}</div>
          <div class="cat-info">
            <div class="cat-name">${_escText(cat.name)}</div>
            <div class="cat-bar-wrap"><div class="cat-bar" style="width:${pct}%;background:${cat.color}"></div></div>
          </div>
          <div class="cat-amount">${fmtCurrency(-Math.abs(amount))}</div>
        </div>`;
      }

      function _txRowMarkup(t) {
        const cat = getCatById(t.category_id);
        const sign = t.type === 'out' ? -t.amount : t.amount;
        const dateLbl = (() => {
          const [y, m, d] = t.date.split('-');
          return `${d}.${m}.${y}`;
        })();
        const tagsHtml = (t.tags || []).map((tag) => `<span class="t-tag">${_escText(tag)}</span>`).join('');
        return `<div class="report-tx-row" role="button" tabindex="0"
          onclick="editTransaction(${t.id})"
          onkeydown="handleRowActivate(event, () => editTransaction(${t.id}))">
          <div class="cat-icon" style="--cat-color:${cat.color}">${catIconSvg(cat.icon)}</div>
          <div class="report-tx-main">
            <div class="report-tx-desc">${_escText(t.desc || cat.name)}</div>
            <div class="t-tags">${tagsHtml}</div>
            <div class="report-tx-meta">${dateLbl}</div>
          </div>
          <div class="report-tx-amount ${t.type === 'out' ? 'negative' : 'positive'}">${fmtSignedCurrency(sign)}</div>
        </div>`;
      }

      function _emptyState(msg) {
        return `<p class="empty-state-hint center">${msg}</p>`;
      }

      // ── REPORTS — OVERVIEW ────────────────────────────────────────────────────────

      async function renderReportOverview(body, txs) {
        const totals = _sumByType(txs);
        const balance = totals.in - totals.out;
        const cats = _totalsByCategory(txs, 'out').slice(0, 3);
        const tags = _totalsByTag(txs, 'out').slice(0, 3);
        const topTx = [...txs]
          .filter((t) => t.type === 'out')
          .sort((a, b) => b.amount - a.amount)
          .slice(0, 3);
        const maxCat = cats[0]?.amount || 1;
        const maxTag = tags[0]?.amount || 1;

        body.innerHTML = `
          <div class="report-kpis">
            <div class="summary-card"><div class="label">Einnahmen</div><div class="amount positive">${fmtCurrency(totals.in)}</div></div>
            <div class="summary-card"><div class="label">Ausgaben</div><div class="amount negative">${fmtCurrency(totals.out)}</div></div>
            <div class="summary-card"><div class="label">Bilanz</div><div class="amount ${balance >= 0 ? 'positive' : 'negative'}">${fmtSignedCurrency(balance)}</div></div>
          </div>

          <div class="report-section">
            <h3 class="report-section-title">Vorjahr im Verlauf</h3>
            <div class="report-sparkline-wrap"><canvas id="overviewSparkline" role="img" aria-label="Bilanz Vorjahr pro Monat"></canvas></div>
            <p class="report-sparkline-caption" id="sparklineCaption"></p>
          </div>

          <div class="report-section">
            <h3 class="report-section-title">Top-Kategorien</h3>
            <div id="overviewCats">${cats.length ? cats.map((c) => _catRowMarkup(c.catId, c.amount, maxCat, { drillDown: true })).join('') : _emptyState('Keine Ausgaben im Zeitraum.')}</div>
          </div>

          <div class="report-section">
            <h3 class="report-section-title">Top-Tags</h3>
            <div id="overviewTags">${tags.length ? tags.map((t) => _tagRowMarkup(t.name, t.amount, maxTag, { drillDown: true })).join('') : _emptyState('Keine getaggten Ausgaben im Zeitraum.')}</div>
          </div>

          <div class="report-section">
            <h3 class="report-section-title">Größte Ausgaben</h3>
            <div id="overviewTop">${topTx.length ? topTx.map(_txRowMarkup).join('') : _emptyState('Keine Ausgaben im Zeitraum.')}</div>
          </div>

        `;

        // Sparkline: Vorjahr des Range-Endjahres.
        const endYear = parseInt(reportRange.to.slice(0, 4), 10);
        const prevYear = endYear - 1;
        const prevTxs = await _loadYearTxs(prevYear);
        const monthly = Array.from({ length: 12 }, (_, m) => {
          const tx = prevTxs.filter((t) => new Date(t.date).getMonth() === m);
          const out = tx.filter((t) => t.type === 'out').reduce((a, t) => a + t.amount, 0);
          const inn = tx.filter((t) => t.type === 'in').reduce((a, t) => a + t.amount, 0);
          return inn - out;
        });
        const c = getChartColors();
        const canvas = document.getElementById('overviewSparkline');
        chartInsts.sparkline = new Chart(canvas, {
          type: 'line',
          data: {
            labels: MONTHS_SHORT,
            datasets: [{
              data: monthly,
              borderColor: cssColor('--accent'),
              backgroundColor: cssColor('--accent', 0.1),
              tension: 0.35,
              fill: true,
              pointRadius: 0,
              borderWidth: 2,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false }, tooltip: { enabled: false } },
            scales: {
              x: { ticks: { color: c.text, font: { size: 10 } }, grid: { display: false } },
              y: { display: false },
            },
          },
        });
        document.getElementById('sparklineCaption').textContent =
          `Monatliche Bilanz ${prevYear}`;
      }

      // ── REPORTS — MONTH ───────────────────────────────────────────────────────────

      function renderReportMonth(body, txs) {
        const a = reportRange.anchor;
        const days = _daysInMonth(a.y, a.m);
        const labels = Array.from({ length: days }, (_, i) => i + 1);
        const byDay = {};
        txs.forEach((t) => {
          const d = new Date(t.date).getDate();
          if (!byDay[d]) byDay[d] = { out: 0, in: 0 };
          byDay[d][t.type] += t.amount;
        });
        const outData = labels.map((d) => byDay[d]?.out || 0);
        const inData = labels.map((d) => byDay[d]?.in || 0);
        const totals = _sumByType(txs);

        body.innerHTML = `
          <div class="report-section">
            <div class="report-canvas-wrap"><canvas id="monthChart" role="img" aria-labelledby="reportTitle" aria-describedby="monthChartSummary"></canvas></div>
            <p id="monthChartSummary" class="visually-hidden" aria-live="polite">${MONTHS[a.m]} ${a.y}: Einnahmen ${fmtCurrency(totals.in)}, Ausgaben ${fmtCurrency(totals.out)}.</p>
          </div>
          <div class="report-kpis">
            <div class="summary-card"><div class="label">Einnahmen</div><div class="amount positive">${fmtCurrency(totals.in)}</div></div>
            <div class="summary-card"><div class="label">Ausgaben</div><div class="amount negative">${fmtCurrency(totals.out)}</div></div>
            <div class="summary-card"><div class="label">Bilanz</div><div class="amount ${totals.in - totals.out >= 0 ? 'positive' : 'negative'}">${fmtSignedCurrency(totals.in - totals.out)}</div></div>
          </div>
        `;

        const c = getChartColors();
        chartInsts.month = new Chart(document.getElementById('monthChart'), {
          type: 'bar',
          data: {
            labels,
            datasets: [
              { label: 'Ausgaben', data: outData, backgroundColor: cssColor('--accent', 0.7), borderRadius: 4, borderSkipped: false },
              { label: 'Einnahmen', data: inData, backgroundColor: cssColor('--green', 0.7), borderRadius: 4, borderSkipped: false },
            ],
          },
          options: {
            responsive: true,
            plugins: { legend: { labels: { color: c.text, font: { family: 'DM Sans', size: 11 } } } },
            scales: {
              x: { ticks: { color: c.text, font: { size: 10 } }, grid: { color: c.grid } },
              y: { ticks: { color: c.text, font: { size: 10 }, callback: (v) => fmtCurrency(v) }, grid: { color: c.grid } },
            },
          },
        });
      }

      // ── REPORTS — YEAR ────────────────────────────────────────────────────────────

      async function renderReportYear(body, txs) {
        const a = reportRange.anchor;
        const aggregate = (pool) =>
          Array.from({ length: 12 }, (_, m) => {
            const tx = pool.filter((t) => new Date(t.date).getMonth() === m);
            return {
              out: tx.filter((t) => t.type === 'out').reduce((s, t) => s + t.amount, 0),
              in: tx.filter((t) => t.type === 'in').reduce((s, t) => s + t.amount, 0),
            };
          });
        const monthly = aggregate(txs);
        const prevTxs = await _loadYearTxs(a.y - 1);
        const hasPrev = prevTxs.length > 0;
        const prevMonthly = hasPrev ? aggregate(prevTxs) : null;
        const totals = _sumByType(txs);

        body.innerHTML = `
          <div class="report-section">
            <div class="report-canvas-wrap"><canvas id="yearChart" role="img" aria-labelledby="reportTitle" aria-describedby="yearChartSummary"></canvas></div>
            <p id="yearChartSummary" class="visually-hidden" aria-live="polite">Jahr ${a.y}: Einnahmen ${fmtCurrency(totals.in)}, Ausgaben ${fmtCurrency(totals.out)}.</p>
          </div>
          <div class="report-kpis">
            <div class="summary-card"><div class="label">Einnahmen</div><div class="amount positive">${fmtCurrency(totals.in)}</div></div>
            <div class="summary-card"><div class="label">Ausgaben</div><div class="amount negative">${fmtCurrency(totals.out)}</div></div>
            <div class="summary-card"><div class="label">Bilanz</div><div class="amount ${totals.in - totals.out >= 0 ? 'positive' : 'negative'}">${fmtSignedCurrency(totals.in - totals.out)}</div></div>
          </div>
        `;

        const c = getChartColors();
        const datasets = [
          { label: `Ausgaben ${a.y}`, data: monthly.map((m) => m.out), borderColor: cssColor('--accent'), backgroundColor: cssColor('--accent', 0.1), tension: 0.4, fill: true, pointRadius: 3 },
          { label: `Einnahmen ${a.y}`, data: monthly.map((m) => m.in), borderColor: cssColor('--green'), backgroundColor: cssColor('--green', 0.1), tension: 0.4, fill: true, pointRadius: 3 },
        ];
        if (prevMonthly) {
          datasets.push({
            label: `Ausgaben ${a.y - 1}`,
            data: prevMonthly.map((m) => m.out),
            borderColor: cssColor('--accent', 0.5),
            borderDash: [5, 4],
            backgroundColor: 'transparent',
            tension: 0.4,
            fill: false,
            pointRadius: 0,
          });
        }
        chartInsts.year = new Chart(document.getElementById('yearChart'), {
          type: 'line',
          data: { labels: MONTHS_SHORT, datasets },
          options: {
            responsive: true,
            plugins: { legend: { labels: { color: c.text, font: { family: 'DM Sans', size: 11 } } } },
            scales: {
              x: { ticks: { color: c.text, font: { size: 10 } }, grid: { color: c.grid } },
              y: { ticks: { color: c.text, font: { size: 10 }, callback: (v) => fmtCurrency(v) }, grid: { color: c.grid } },
            },
          },
        });
      }

      // ── REPORTS — CATEGORIES ──────────────────────────────────────────────────────

      function renderReportCategories(body, txs) {
        const sorted = _totalsByCategory(txs, 'out');
        if (!sorted.length) {
          body.innerHTML = _emptyState('Keine Ausgaben im Zeitraum.');
          return;
        }
        const total = sorted.reduce((s, c) => s + c.amount, 0);
        const max = sorted[0].amount;

        body.innerHTML = `
          <div class="report-section">
            <div class="donut-wrap">
              <canvas id="categoriesDonut" role="img" aria-label="Ausgaben pro Kategorie"></canvas>
              <div class="donut-center">
                <div class="donut-center-value">${fmtCurrency(total)}</div>
                <div class="donut-center-label">Ausgaben gesamt</div>
              </div>
            </div>
          </div>
          <div class="report-section">
            ${sorted.map((c) => _catRowMarkup(c.catId, c.amount, max, { drillDown: true })).join('')}
          </div>
        `;

        chartInsts.categories = new Chart(document.getElementById('categoriesDonut'), {
          type: 'doughnut',
          data: {
            labels: sorted.map((c) => getCatById(c.catId)?.name || ''),
            datasets: [{
              data: sorted.map((c) => c.amount),
              backgroundColor: sorted.map((c) => getCatById(c.catId)?.color || cssColor('--accent')),
              borderWidth: 0,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: true,
            cutout: '64%',
            plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${fmtCurrency(ctx.parsed)}` } } },
          },
        });
      }

      async function drillDownCategory(catId, fromIso, toIso) {
        _searchExitTarget = 'charts';
        _categoryFilterId = catId;
        const from = fromIso || reportRange.from;
        const to = toIso || reportRange.to;
        _allTransactions = await loadRangeTxs(from, to);
        document.body.classList.add('searching');
        await _setSearchPanelActive(true);
        applySearch();
      }

      // ── REPORTS — TAGS ────────────────────────────────────────────────────────────

      // Stable hue per tag — same name always maps to the same color. Avoids
      // a per-tag color setting while keeping the donut visually distinct.
      function _tagColor(name) {
        let h = 0;
        for (let i = 0; i < name.length; i++) {
          h = ((h << 5) - h + name.charCodeAt(i)) | 0;
        }
        return `hsl(${Math.abs(h) % 360}deg 58% 52%)`;
      }

      // Sum amounts per tag for the given type. A transaction with multiple
      // tags contributes its full amount to each tag (tags are categorical
      // labels, not splits) — mirrors how Top-Kategorien aggregates.
      function _totalsByTag(txs, type = 'out') {
        const totals = {};
        for (const t of txs) {
          if (t.type !== type) continue;
          if (!Array.isArray(t.tags) || !t.tags.length) continue;
          for (const tag of t.tags) {
            totals[tag] = (totals[tag] || 0) + t.amount;
          }
        }
        return Object.entries(totals)
          .map(([name, amount]) => ({ name, amount }))
          .sort((a, b) => b.amount - a.amount);
      }

      function _escAttr(s) {
        return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      }
      function _escText(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      }

      function _tagRowMarkup(name, amount, max, opts = {}) {
        const color = _tagColor(name);
        const pct = max > 0 ? (amount / max) * 100 : 0;
        const attrName = _escAttr(name);
        const drill = opts.drillDown
          ? `role="button" tabindex="0" data-tag-drill="${attrName}"`
          : '';
        return `<div class="cat-row" ${drill}>
          <div class="cat-icon" style="--cat-color:${color}">#</div>
          <div class="cat-info">
            <div class="cat-name">${_escText(name)}</div>
            <div class="cat-bar-wrap"><div class="cat-bar" style="width:${pct}%;background:${color}"></div></div>
          </div>
          <div class="cat-amount">${fmtCurrency(-Math.abs(amount))}</div>
        </div>`;
      }

      function renderReportTags(body, txs) {
        const sorted = _totalsByTag(txs, 'out');
        if (!sorted.length) {
          body.innerHTML = _emptyState('Keine Ausgaben mit Tags im Zeitraum.');
          return;
        }
        const total = sorted.reduce((s, t) => s + t.amount, 0);
        const max = sorted[0].amount;

        body.innerHTML = `
          <div class="report-section">
            <div class="donut-wrap">
              <canvas id="tagsDonut" role="img" aria-label="Ausgaben pro Tag"></canvas>
              <div class="donut-center">
                <div class="donut-center-value">${fmtCurrency(total)}</div>
                <div class="donut-center-label">Ausgaben gesamt</div>
              </div>
            </div>
          </div>
          <div class="report-section">
            ${sorted.map((t) => _tagRowMarkup(t.name, t.amount, max, { drillDown: true })).join('')}
          </div>
        `;

        chartInsts.tags = new Chart(document.getElementById('tagsDonut'), {
          type: 'doughnut',
          data: {
            labels: sorted.map((t) => t.name),
            datasets: [{
              data: sorted.map((t) => t.amount),
              backgroundColor: sorted.map((t) => _tagColor(t.name)),
              borderWidth: 0,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: true,
            cutout: '64%',
            plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${fmtCurrency(ctx.parsed)}` } } },
          },
        });

        body.querySelectorAll('[data-tag-drill]').forEach((el) => {
          const name = el.dataset.tagDrill;
          el.addEventListener('click', () => drillDownTag(name));
          el.addEventListener('keydown', (ev) => handleRowActivate(ev, () => drillDownTag(name)));
        });
      }

      async function drillDownTag(name, fromIso, toIso) {
        _searchExitTarget = 'charts';
        _tagFilterName = name;
        const from = fromIso || reportRange.from;
        const to = toIso || reportRange.to;
        _allTransactions = await loadRangeTxs(from, to);
        document.body.classList.add('searching');
        await _setSearchPanelActive(true);
        applySearch();
      }

      // ── REPORTS — TREND ───────────────────────────────────────────────────────────

      function _persistTrendState() {
        try {
          localStorage.setItem(
            TREND_STORAGE_KEY,
            JSON.stringify({ kind: _trendKind, selection: _trendSelection })
          );
        } catch (e) {}
      }

      function _persistTrendRange() {
        try {
          localStorage.setItem(
            TREND_RANGE_KEY,
            JSON.stringify({ yearFrom: _trendYearFrom, yearTo: _trendYearTo })
          );
        } catch (e) {}
      }

      async function _findEarliestTxDate() {
        if (_earliestTxDate) return _earliestTxDate;
        const today = new Date();
        let year = today.getFullYear();
        let earliest = null;
        let consecutiveEmpty = 0;
        const floor = year - 20;
        while (consecutiveEmpty < 2 && year >= floor) {
          const yearTxs = await _loadYearTxs(year);
          if (!yearTxs.length) {
            consecutiveEmpty++;
          } else {
            consecutiveEmpty = 0;
            for (const t of yearTxs) {
              if (!earliest || t.date < earliest) earliest = t.date;
            }
          }
          year--;
        }
        if (!earliest) {
          // Noch keine Buchung — default ein Jahr zurück, damit der Picker eine sinnvolle Range zeigt.
          const fallback = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate());
          earliest = _iso(fallback.getFullYear(), fallback.getMonth(), fallback.getDate());
        }
        _earliestTxDate = earliest;
        return earliest;
      }

      async function _ensureTrendDefaultRange() {
        // _earliestTxDate immer auflösen — der Jahres-Picker im Render
        // braucht minYear, auch wenn die Range aus localStorage kommt.
        const earliest = await _findEarliestTxDate();
        if (_trendYearFrom && _trendYearTo) return;
        const today = new Date();
        _trendYearFrom = parseInt(earliest.slice(0, 4), 10);
        _trendYearTo = today.getFullYear();
        _persistTrendRange();
      }

      function _monthSpan(fromIso, toIso) {
        const fy = parseInt(fromIso.slice(0, 4), 10);
        const fm = parseInt(fromIso.slice(5, 7), 10);
        const ty = parseInt(toIso.slice(0, 4), 10);
        const tm = parseInt(toIso.slice(5, 7), 10);
        return (ty - fy) * 12 + (tm - fm) + 1;
      }

      function _autoGranularity(fromIso, toIso) {
        const months = _monthSpan(fromIso, toIso);
        if (months < 24) return 'month';
        if (months <= 60) return 'quarter';
        return 'year';
      }

      function _bucketKey(iso, granularity) {
        const y = iso.slice(0, 4);
        const m = parseInt(iso.slice(5, 7), 10);
        if (granularity === 'year') return y;
        if (granularity === 'quarter') return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
        return `${y}-${String(m).padStart(2, '0')}`;
      }

      function _bucketLabel(key, granularity) {
        if (granularity === 'year') return key;
        if (granularity === 'quarter') {
          const [y, q] = key.split('-');
          return `${q} ${y}`;
        }
        const [y, m] = key.split('-');
        return `${MONTHS_SHORT[parseInt(m, 10) - 1]} ${y.slice(2)}`;
      }

      function _bucketAxis(fromIso, toIso, granularity) {
        const fy = parseInt(fromIso.slice(0, 4), 10);
        const fm = parseInt(fromIso.slice(5, 7), 10);
        const ty = parseInt(toIso.slice(0, 4), 10);
        const tm = parseInt(toIso.slice(5, 7), 10);
        const keys = [];
        if (granularity === 'year') {
          for (let y = fy; y <= ty; y++) keys.push(String(y));
          return keys;
        }
        if (granularity === 'quarter') {
          let y = fy;
          let q = Math.floor((fm - 1) / 3);
          const endQ = Math.floor((tm - 1) / 3);
          while (y < ty || (y === ty && q <= endQ)) {
            keys.push(`${y}-Q${q + 1}`);
            q++;
            if (q > 3) { q = 0; y++; }
          }
          return keys;
        }
        let y = fy;
        let m = fm;
        while (y < ty || (y === ty && m <= tm)) {
          keys.push(`${y}-${String(m).padStart(2, '0')}`);
          m++;
          if (m > 12) { m = 1; y++; }
        }
        return keys;
      }

      function _movingAverage(values, window) {
        if (window <= 1) return values.slice();
        const result = [];
        const half = Math.floor(window / 2);
        for (let i = 0; i < values.length; i++) {
          const start = Math.max(0, i - half);
          const end = Math.min(values.length - 1, i + half);
          let sum = 0;
          for (let j = start; j <= end; j++) sum += values[j];
          result.push(sum / (end - start + 1));
        }
        return result;
      }

      // Stabile Hue wie _tagColor, aber mit klemmender Helligkeit, damit
      // Light- und Dark-Mode beide Kontrast zur Chart-Linie haben.
      function _tagLineColor(name) {
        let h = 0;
        for (let i = 0; i < name.length; i++) {
          h = ((h << 5) - h + name.charCodeAt(i)) | 0;
        }
        return `hsl(${Math.abs(h) % 360}deg 55% 50%)`;
      }

      function _trendEntityFromId(id) {
        if (!id) return null;
        if (id.startsWith('cat:')) {
          const catId = parseInt(id.slice(4), 10);
          const cat = categories.find((c) => c.id === catId);
          if (!cat) return null;
          return { kind: 'category', id, catId, name: cat.name, color: cat.color };
        }
        if (id.startsWith('tag:')) {
          const name = id.slice(4);
          return { kind: 'tag', id, name, color: _tagLineColor(name) };
        }
        return null;
      }

      function _trendMatchesEntity(t, entity) {
        if (t.type !== 'out') return false;
        if (entity.kind === 'category') return t.category_id === entity.catId;
        return Array.isArray(t.tags) && t.tags.includes(entity.name);
      }

      function _pickDefaultTrendEntity(txs, kind) {
        if (kind === 'category') {
          for (const r of _totalsByCategory(txs, 'out')) {
            if (categories.find((c) => c.id === r.catId)) return `cat:${r.catId}`;
          }
        } else {
          const top = _totalsByTag(txs, 'out')[0];
          if (top) return `tag:${top.name}`;
        }
        return null;
      }

      function _trendSeries(txs, entityId, granularity, bucketKeys) {
        const entity = _trendEntityFromId(entityId);
        if (!entity) return null;
        const sums = new Map(bucketKeys.map((k) => [k, 0]));
        for (const t of txs) {
          if (!_trendMatchesEntity(t, entity)) continue;
          const key = _bucketKey(t.date, granularity);
          if (sums.has(key)) sums.set(key, sums.get(key) + t.amount);
        }
        return {
          entity,
          label: entity.kind === 'tag' ? `#${entity.name}` : entity.name,
          color: entity.color,
          data: bucketKeys.map((k) => sums.get(k) || 0),
        };
      }

      function _monthlyTotals(txs, entity) {
        const sums = new Map();
        for (const t of txs) {
          if (!_trendMatchesEntity(t, entity)) continue;
          const key = t.date.slice(0, 7);
          sums.set(key, (sums.get(key) || 0) + t.amount);
        }
        return sums;
      }

      function _trendStats(monthlyMap, fromIso, toIso) {
        const months = _bucketAxis(fromIso, toIso, 'month');
        if (!months.length) return null;
        let total = 0;
        let peak = null;
        for (const k of months) {
          const v = monthlyMap.get(k) || 0;
          total += v;
          if (peak === null || v > peak.value) peak = { key: k, value: v };
        }
        const mean = total / months.length;
        const yearGroups = new Map();
        for (const k of months) {
          const y = k.slice(0, 4);
          if (!yearGroups.has(y)) yearGroups.set(y, []);
          yearGroups.get(y).push(monthlyMap.get(k) || 0);
        }
        // Schwelle bewusst niedrig (≥3 Monate), damit das laufende Jahr ab Q2
        // sichtbar wird — der renderReportTrend-Callsite kappt toIso auf heute,
        // also rechnet jeder Jahresmittelwert nur über tatsächlich verfügbare
        // Monate (Projektion auf Monatsbasis statt Verwässerung durch Nullen).
        const years = Array.from(yearGroups.entries()).filter(([, list]) => list.length >= 3);
        let yoy = null;
        if (years.length >= 2) {
          const first = years[0];
          const last = years[years.length - 1];
          if (first[0] !== last[0]) {
            const firstMean = first[1].reduce((s, v) => s + v, 0) / first[1].length;
            const lastMean = last[1].reduce((s, v) => s + v, 0) / last[1].length;
            const pct = firstMean > 0 ? ((lastMean - firstMean) / firstMean) * 100 : null;
            yoy = { firstYear: first[0], lastYear: last[0], firstMean, lastMean, pct };
          }
        }
        return { mean, peak, yoy, monthCount: months.length };
      }

      function _trendPeakLabel(key) {
        const [y, m] = key.split('-');
        return `${MONTHS[parseInt(m, 10) - 1]} ${y}`;
      }

      function _trendChipMarkup(id, name, color, selected) {
        const sel = selected ? 'is-selected' : '';
        return `<button type="button" class="trend-chip ${sel}" data-trend-id="${_escAttr(id)}">
          <span class="dot" style="background:${color}"></span>${_escText(name)}
        </button>`;
      }

      function _trendPickerOptions(txs, kind, selectedId, filter) {
        const options = [];
        if (kind === 'category') {
          const ranked = _totalsByCategory(txs, 'out');
          const seen = new Set();
          for (const r of ranked) {
            const cat = categories.find((c) => c.id === r.catId);
            if (!cat) continue;
            seen.add(r.catId);
            options.push({ id: `cat:${r.catId}`, label: cat.name, color: cat.color });
          }
          const rest = categories
            .filter((c) => !seen.has(c.id))
            .sort((a, b) => a.name.localeCompare(b.name, 'de'));
          for (const c of rest) {
            options.push({ id: `cat:${c.id}`, label: c.name, color: c.color });
          }
        } else {
          for (const r of _totalsByTag(txs, 'out')) {
            options.push({ id: `tag:${r.name}`, label: `#${r.name}`, color: _tagLineColor(r.name) });
          }
        }
        // Mit Suchquery: alle Treffer aus dem vollen Set, kein Top-N-Cap.
        const q = (filter || '').trim().toLowerCase();
        if (q) {
          return options.filter((o) => o.label.toLowerCase().includes(q));
        }
        // Ohne Query: Top 10 nach Summe. Wenn die aktive Auswahl außerhalb
        // der Top 10 liegt, den letzten Slot durch sie ersetzen — sonst wäre
        // die im active-row sichtbare Auswahl im aufgeklappten Picker nicht zu sehen.
        const TOP_N = 10;
        const limited = options.slice(0, TOP_N);
        if (selectedId && !limited.some((o) => o.id === selectedId)) {
          const selectedOpt = options.find((o) => o.id === selectedId);
          if (selectedOpt) {
            limited.pop();
            limited.push(selectedOpt);
          }
        }
        return limited;
      }

      function _trendStatsMarkup(stats) {
        if (!stats || stats.monthCount === 0) return '';
        const meanCard = `<div class="stat-card">
          <div class="trend-stat-label">Mittelwert</div>
          <div class="trend-stat-value">${fmtCurrency(stats.mean)}</div>
          <div class="trend-stat-sub">pro Monat</div>
        </div>`;
        const peakCard = stats.peak && stats.peak.value > 0
          ? `<div class="stat-card">
              <div class="trend-stat-label">Höchster Monat</div>
              <div class="trend-stat-value">${fmtCurrency(stats.peak.value)}</div>
              <div class="trend-stat-sub">${_trendPeakLabel(stats.peak.key)}</div>
            </div>`
          : '';
        const yoyCard = stats.yoy && stats.yoy.pct !== null
          ? `<div class="stat-card wide">
              <div class="trend-stat-label">Veränderung pro Jahr</div>
              <div class="trend-stat-value">${stats.yoy.firstYear} → ${stats.yoy.lastYear}
                <span class="trend-stat-delta">${stats.yoy.pct >= 0 ? '+' : ''}${stats.yoy.pct.toFixed(0)} %</span>
              </div>
              <div class="trend-stat-sub">⌀ ${fmtCurrency(stats.yoy.firstMean)} → ⌀ ${fmtCurrency(stats.yoy.lastMean)} pro Monat</div>
            </div>`
          : '';
        return `<div class="trend-stats">${meanCard}${peakCard}${yoyCard}</div>`;
      }

      function setTrendKind(kind) {
        if (kind !== 'category' && kind !== 'tag') return;
        if (_trendKind === kind) return;
        _trendKind = kind;
        _trendSelection = [];
        _trendPickerOpen = false;
        _trendPickerFilter = '';
        _persistTrendState();
        renderReport();
      }

      function selectTrendEntity(id) {
        _trendSelection = [id];
        _trendPickerOpen = false;
        _trendPickerFilter = '';
        _persistTrendState();
        renderReport();
      }

      function toggleTrendPicker(open) {
        _trendPickerOpen = open === undefined ? !_trendPickerOpen : !!open;
        const activeRow = document.getElementById('trendActiveRow');
        const picker = document.getElementById('trendPickerOpen');
        if (activeRow) activeRow.hidden = _trendPickerOpen;
        if (picker) picker.hidden = !_trendPickerOpen;
        if (_trendPickerOpen && picker) {
          const input = picker.querySelector('input');
          if (input) input.focus();
        }
      }

      function filterTrendChips(value) {
        _trendPickerFilter = value;
        const container = document.getElementById('trendPickerChips');
        if (!container) return;
        const selectedId = _trendSelection[0] || null;
        const options = _trendPickerOptions(_reportTxPool || [], _trendKind, selectedId, value);
        container.innerHTML = options
          .map((o) => _trendChipMarkup(o.id, o.label, o.color, selectedId && o.id === selectedId))
          .join('');
        _bindTrendChipHandlers(container);
      }

      async function setTrendYear(field, value) {
        const today = new Date().getFullYear();
        const minYear = _earliestTxDate ? parseInt(_earliestTxDate.slice(0, 4), 10) : today - 20;
        value = Math.round(Math.max(minYear, Math.min(today, value)));
        if (field === 'from') {
          _trendYearFrom = value;
          if (_trendYearTo < _trendYearFrom) _trendYearTo = _trendYearFrom;
        } else {
          _trendYearTo = value;
          if (_trendYearFrom > _trendYearTo) _trendYearFrom = _trendYearTo;
        }
        _persistTrendRange();
        await renderReport('trend');
      }

      async function renderReportTrend(body, txs) {
        // Beim ersten Öffnen oder nach Kategorie-Löschung: Selection neu setzen
        let selected = _trendSelection[0] ? _trendEntityFromId(_trendSelection[0]) : null;
        if (selected && selected.kind !== _trendKind) selected = null;
        if (!selected) {
          const def = _pickDefaultTrendEntity(txs, _trendKind);
          if (def) {
            _trendSelection = [def];
            _persistTrendState();
            selected = _trendEntityFromId(def);
          } else {
            _trendSelection = [];
          }
        }

        const today = new Date().getFullYear();
        const minYear = _earliestTxDate ? parseInt(_earliestTxDate.slice(0, 4), 10) : today - 20;
        const yearOptions = (selectedYear) => {
          let html = '';
          for (let y = minYear; y <= today; y++) {
            html += `<option value="${y}"${y === selectedYear ? ' selected' : ''}>${y}</option>`;
          }
          return html;
        };

        const yearPickerMarkup = `<div class="range-custom trend-year-picker">
            <label class="range-custom-field">
              <span>Von</span>
              <select aria-label="Von Jahr" onchange="setTrendYear('from', +this.value)">${yearOptions(_trendYearFrom || today)}</select>
            </label>
            <label class="range-custom-field">
              <span>Bis</span>
              <select aria-label="Bis Jahr" onchange="setTrendYear('to', +this.value)">${yearOptions(_trendYearTo || today)}</select>
            </label>
          </div>`;

        const options = _trendPickerOptions(txs, _trendKind, selected && selected.id, _trendPickerFilter);
        const chipsMarkup = options
          .map((o) => _trendChipMarkup(o.id, o.label, o.color, selected && o.id === selected.id))
          .join('');
        const searchPlaceholder = _trendKind === 'category' ? 'Kategorie suchen' : 'Tag suchen';

        const segmentedMarkup = `<div class="segmented" role="tablist" aria-label="Trend-Auswahl">
            <button type="button" role="tab" aria-selected="${_trendKind === 'category'}" class="${_trendKind === 'category' ? 'is-active' : ''}" onclick="setTrendKind('category')">Kategorien</button>
            <button type="button" role="tab" aria-selected="${_trendKind === 'tag'}" class="${_trendKind === 'tag' ? 'is-active' : ''}" onclick="setTrendKind('tag')">Tags</button>
          </div>`;

        const activeMarkup = selected
          ? `<div class="trend-active-row" id="trendActiveRow"${_trendPickerOpen ? ' hidden' : ''}>
              <div class="trend-active-info">
                <span class="trend-active-dot" style="background:${selected.color}"></span>
                <div class="trend-active-text">
                  <div class="trend-active-label">${_escText(selected.kind === 'tag' ? `#${selected.name}` : selected.name)}</div>
                  <span class="trend-active-sub">Größter Posten im Zeitraum</span>
                </div>
              </div>
              <button type="button" class="trend-switch-btn" onclick="toggleTrendPicker(true)">Wechseln</button>
            </div>`
          : '';

        const pickerOpenMarkup = `<div class="trend-picker-open" id="trendPickerOpen"${_trendPickerOpen || !selected ? '' : ' hidden'}>
            <div class="search-wrap">
              <svg class="ui-icon" aria-hidden="true"><use href="#icon-search" /></svg>
              <input type="search" placeholder="${searchPlaceholder}" value="${_escAttr(_trendPickerFilter)}" oninput="filterTrendChips(this.value)" autocomplete="off" />
            </div>
            <div class="tag-picker-chips" id="trendPickerChips">${chipsMarkup}</div>
          </div>`;

        if (!selected) {
          body.innerHTML = `
            ${yearPickerMarkup}
            <div class="report-section">${segmentedMarkup}${pickerOpenMarkup}</div>
            <div class="report-section">${_emptyState(_trendKind === 'category' ? 'Keine Kategorien mit Ausgaben im Zeitraum.' : 'Keine Tags mit Ausgaben im Zeitraum.')}</div>
          `;
          _bindTrendChipHandlers(body);
          return;
        }

        // Granularität fix Monat — Legende skaliert über autoSkip/maxTicksLimit.
        // Bei toIso > heute auf den aktuellen Monat kappen, damit weder die
        // Chart-Linie auf null abstürzt noch der laufende Jahres-Mittelwert
        // durch zukünftige Nullmonate verwässert wird.
        const granularity = 'month';
        const todayDate = new Date();
        const todayIso = _iso(todayDate.getFullYear(), todayDate.getMonth(), todayDate.getDate());
        const trendFromIso = `${_trendYearFrom}-01-01`;
        const trendToIso   = `${_trendYearTo}-12-31`;
        const effectiveTo = trendToIso > todayIso ? todayIso : trendToIso;
        const bucketKeys = _bucketAxis(trendFromIso, effectiveTo, granularity);
        const bucketLabels = bucketKeys.map((k) => _bucketLabel(k, granularity));
        const series = _trendSeries(txs, selected.id, granularity, bucketKeys);
        const monthlyMap = _monthlyTotals(txs, selected);
        const stats = _trendStats(monthlyMap, trendFromIso, effectiveTo);

        body.innerHTML = `
          ${yearPickerMarkup}
          <div class="report-section">${segmentedMarkup}${activeMarkup}${pickerOpenMarkup}</div>
          <div class="report-section">
            <div class="report-canvas-wrap"><canvas id="trendChart" role="img" aria-labelledby="reportTitle" aria-describedby="trendChartSummary"></canvas></div>
            <p id="trendChartSummary" class="visually-hidden" aria-live="polite">${_escText(series.label)}, Mittelwert ${fmtCurrency(stats?.mean || 0)} pro Monat.</p>
          </div>
          ${_trendStatsMarkup(stats)}
        `;
        _bindTrendChipHandlers(body);

        const c = getChartColors();
        const datasets = [
          {
            label: series.label,
            data: series.data,
            borderColor: series.color,
            backgroundColor: 'transparent',
            tension: 0.25,
            pointRadius: 3,
            borderWidth: 2.5,
            fill: false,
          },
        ];
        // Glättungs-Fenster wächst mit dem Zeitraum, damit die zweite Linie
        // auch über mehrere Jahre noch glättet statt 1:1 auf der Rohlinie zu liegen.
        const maWindow = bucketKeys.length > 60 ? 12 : bucketKeys.length > 24 ? 6 : 3;
        if (bucketKeys.length >= maWindow * 2) {
          const smoothed = _movingAverage(series.data, maWindow);
          datasets.push({
            label: `${series.label} (Glättung)`,
            data: smoothed,
            borderColor: series.color,
            borderDash: [4, 3],
            backgroundColor: 'transparent',
            tension: 0,
            pointRadius: 0,
            borderWidth: 1.5,
            fill: false,
          });
        }

        chartInsts.trend = new Chart(document.getElementById('trendChart'), {
          type: 'line',
          data: { labels: bucketLabels, datasets },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
              legend: { display: false },
              tooltip: {
                callbacks: {
                  label: (ctx) => `${ctx.dataset.label}: ${fmtCurrency(ctx.parsed.y)}`,
                },
              },
            },
            scales: {
              x: { ticks: { color: c.text, font: { size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 12 }, grid: { color: c.grid } },
              y: { ticks: { color: c.text, font: { size: 10 }, callback: (v) => fmtCurrency(v) }, grid: { color: c.grid } },
            },
          },
        });
      }

      function _bindTrendChipHandlers(scope) {
        scope.querySelectorAll('[data-trend-id]').forEach((el) => {
          el.addEventListener('click', () => selectTrendEntity(el.dataset.trendId));
          el.addEventListener('keydown', (ev) => handleRowActivate(ev, () => selectTrendEntity(el.dataset.trendId)));
        });
      }

      // ── REPORTS — FORECAST ────────────────────────────────────────────────────────

      async function renderReportForecast(body, rangeTxs) {
        const today = new Date();
        const todayY = today.getFullYear();
        const todayM = today.getMonth();
        const msDay = 86400000;

        // Historie: letzte 12 vollständige Monate vor dem aktuellen Monat.
        // Anker bewusst „heute", nicht der Zielmonat — so basiert die
        // Prognose auf den jüngsten echten Daten, auch wenn der User in
        // die Zukunft schaut.
        const histEndDate = new Date(todayY, todayM, 0);
        const histStartDate = new Date(todayY, todayM - 12, 1);
        const histStartIso = _iso(histStartDate.getFullYear(), histStartDate.getMonth(), 1);
        const histEndIso = _iso(histEndDate.getFullYear(), histEndDate.getMonth(), histEndDate.getDate());
        const histTxs = await loadRangeTxs(histStartIso, histEndIso);
        const histOut = histTxs.filter((t) => t.type === 'out');

        if (histOut.length === 0) {
          body.innerHTML = _emptyState('Noch nicht genug Daten für eine Prognose. Mindestens vier Wochen Buchungen werden benötigt.');
          return;
        }

        const histDays = Math.round((histEndDate - histStartDate) / msDay) + 1;
        const dailyAvg = histOut.reduce((s, t) => s + t.amount, 0) / histDays;

        // Gewählter Zeitraum aus dem Time-Picker.
        const rangeFromIso = reportRange.from;
        const rangeToIso = reportRange.to;
        const rangeFromDate = new Date(rangeFromIso + 'T00:00:00');
        const rangeToDate = new Date(rangeToIso + 'T00:00:00');
        const daysTotal = Math.round((rangeToDate - rangeFromDate) / msDay) + 1;
        const todayStartOfDay = new Date(todayY, todayM, today.getDate());
        let daysPassed;
        if (todayStartOfDay < rangeFromDate) {
          daysPassed = 0;
        } else if (todayStartOfDay >= rangeToDate) {
          daysPassed = daysTotal;
        } else {
          daysPassed = Math.round((todayStartOfDay - rangeFromDate) / msDay) + 1;
        }
        if (daysPassed > daysTotal) daysPassed = daysTotal;

        const rangeOut = (rangeTxs || []).filter((t) => t.type === 'out');
        const rangeSum = rangeOut.reduce((s, t) => s + t.amount, 0);

        // Prognose: vergangene Tage = Ist, restliche Tage = Tagesdurchschnitt.
        let projected;
        if (daysPassed === 0) {
          projected = dailyAvg * daysTotal;
        } else if (daysPassed >= daysTotal) {
          projected = rangeSum;
        } else {
          projected = rangeSum + dailyAvg * (daysTotal - daysPassed);
        }

        // Pro Kategorie: Ø skaliert auf Range-Länge, Status pace-bereinigt.
        const histByCat = {};
        for (const t of histOut) {
          histByCat[t.category_id] = (histByCat[t.category_id] || 0) + t.amount;
        }
        const curByCat = {};
        for (const t of rangeOut) {
          curByCat[t.category_id] = (curByCat[t.category_id] || 0) + t.amount;
        }
        const rows = Object.entries(histByCat)
          .map(([id, sum]) => ({
            catId: parseInt(id, 10),
            avg: (sum / histDays) * daysTotal,
            current: curByCat[id] || 0,
          }))
          .sort((a, b) => b.avg - a.avg);

        const statusFor = (cur, avg) => {
          if (avg <= 0 || daysPassed === 0) return { label: '', cls: '' };
          const pace = (cur / daysPassed) * daysTotal;
          const ratio = pace / avg;
          if (ratio < 0.9) return { label: 'unter Ø', cls: 'is-ok' };
          if (ratio < 1.1) return { label: 'auf Ø', cls: 'is-neutral' };
          return { label: 'über Ø', cls: 'is-warn' };
        };

        // Labels skalieren mit Time-Picker-Kind.
        const kind = reportRange.kind;
        const cardLabel = kind === 'month' ? 'Voraussichtliche Monats-Ausgaben'
          : kind === 'quarter' ? 'Voraussichtliche Quartals-Ausgaben'
          : kind === 'year' ? 'Voraussichtliche Jahres-Ausgaben'
          : 'Voraussichtliche Ausgaben';
        const avgColLabel = kind === 'month' ? 'Ø Monat'
          : kind === 'quarter' ? 'Ø Quartal'
          : kind === 'year' ? 'Ø Jahr'
          : 'Ø Zeitraum';
        const periodLabel = kind === 'custom'
          ? (() => {
              const fmt = (iso) => { const [y, m, d] = iso.split('-'); return `${d}.${m}.${y}`; };
              return `${fmt(rangeFromIso)} – ${fmt(rangeToIso)}`;
            })()
          : _rangeStepperLabel();

        body.innerHTML = `
          <div class="report-section">
            <div class="forecast-card">
              <div class="forecast-card-label">${cardLabel}</div>
              <div class="forecast-card-value">${fmtCurrency(projected)}</div>
              <div class="forecast-card-hint">${periodLabel} · Tag ${daysPassed} von ${daysTotal} · Basis: letzte 12 Monate</div>
            </div>
          </div>
          <div class="report-section">
            <h3 class="report-section-title">Pro Kategorie</h3>
            <table class="forecast-table">
              <thead><tr><th>Kategorie</th><th class="num">${avgColLabel}</th><th class="num">Aktuell</th><th class="num">Status</th></tr></thead>
              <tbody>
                ${rows.map((r) => {
                  const cat = getCatById(r.catId);
                  if (!cat) return '';
                  const s = statusFor(r.current, r.avg);
                  return `<tr class="is-clickable" role="button" tabindex="0"
                    onclick="drillDownCategory(${r.catId}, '${rangeFromIso}', '${rangeToIso}')"
                    onkeydown="handleRowActivate(event, () => drillDownCategory(${r.catId}, '${rangeFromIso}', '${rangeToIso}'))">
                    <td><span class="forecast-cat-name"><span class="forecast-cat-dot" style="background:${cat.color}"></span>${_escText(cat.name)}</span></td>
                    <td class="num">${fmtCurrency(r.avg)}</td>
                    <td class="num">${fmtCurrency(r.current)}</td>
                    <td class="num"><span class="forecast-status ${s.cls}">${s.label}</span></td>
                  </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>
        `;
      }

      // ── REPORTS — TOP EXPENSES ────────────────────────────────────────────────────

      function renderReportTop(body, txs) {
        const top = txs.filter((t) => t.type === 'out').sort((a, b) => b.amount - a.amount).slice(0, 10);
        if (!top.length) {
          body.innerHTML = _emptyState('Keine Ausgaben im Zeitraum.');
          return;
        }
        body.innerHTML = `<div class="report-section">${top.map(_txRowMarkup).join('')}</div>`;
      }

      // ── MODAL ─────────────────────────────────────────────────────────────────────
      function openModal(tx) {
        rememberModalFocus('booking');
        currentTags = tx?.tags ? tx.tags.slice() : [];
        document.getElementById('inputAmount').value =
          tx?.amount != null ? _formatAmountInput(Number(tx.amount)) : '';
        document.getElementById('inputDesc').value = tx?.desc || '';
        document.getElementById('inputDate').value =
          tx?.date || new Date().toISOString().split('T')[0];
        const catSel = document.getElementById('inputCat');
        // Alphabetical de_DE sort — consistent with renderCategories()
        // and renderCategoryView() so the user sees the same order
        // wherever they look at categories.
        catSel.innerHTML = [...categories]
          .sort((a, b) => a.name.localeCompare(b.name, 'de', { sensitivity: 'base' }))
          .map((c) => `<option value="${c.id}">${_escText(c.name)}</option>`)
          .join('');
        if (tx) catSel.value = tx.category_id;
        setType(tx?.type || 'out', document.querySelector('.type-btn.out'));
        renderTagPills();
        renderTagSuggestions();
        document.querySelector('.modal h2').textContent = tx
          ? 'Buchung bearbeiten'
          : 'Neue Buchung';
        document.getElementById('deleteBtn').style.display = tx ? 'block' : 'none';
        document.getElementById('modalOverlay').classList.add('open');
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
      function closeModalOutside(e) {
        if (e.target === document.getElementById('modalOverlay')) closeModal();
      }
      function editTransaction(id) {
        const num = Number(id);
        const pools = [_allTransactions, _reportTxPool, transactions];
        for (const p of pools) {
          if (!p) continue;
          const t = p.find((t) => t.id === num);
          if (t) return openModal(t);
        }
        // Falls die TX in keinem Pool liegt (etwa weil sie gerade per Sync entfernt
        // wurde): kein stilles Öffnen der Neuanlage — Hinweis geben.
        toast('Buchung wurde nicht gefunden.');
      }

      async function deleteCurrentTransaction() {
        const editId = document.getElementById('modalOverlay').dataset.editId;
        if (!editId) return;
        if (!(await confirmAction({ title: 'Buchung wirklich löschen?', confirmLabel: 'Löschen' })))
          return;
        try {
          await api('DELETE', `/transactions/${editId}`);
          closeModal();
          await loadAndRender();
        } catch (e) {
          if (!navigator.onLine && window.PocketLogOutbox) {
            await window.PocketLogOutbox.enqueue({
              method: 'DELETE',
              path: `/transactions/${editId}`,
            });
            closeModal();
            updateSyncBadge();
            return;
          }
          toast('Fehler beim Löschen: ' + e.message, 'error');
        }
      }

      function setType(type, btn) {
        currentType = type;
        document.querySelectorAll('.type-btn').forEach((b) => b.classList.remove('active'));
        document.querySelector('.type-btn.' + type).classList.add('active');
        document.getElementById('submitBtn').className =
          'submit-btn' + (type === 'in' ? ' green' : '');
        document.getElementById('submitBtn').textContent =
          type === 'out' ? 'Ausgabe speichern' : 'Einnahme speichern';
      }

      // The amount field is type="text" so iOS shows the decimal keypad
      // (which uses a comma on de_DE), so we accept both `,` and `.` as
      // the decimal separator here. Used by both the on-blur normalize
      // and by the save handler.
      function parseAmount(raw) {
        if (raw == null) return NaN;
        return parseFloat(String(raw).trim().replace(',', '.'));
      }

      // Display the amount in the input with the German decimal comma so
      // it matches what the user typed on the iOS decimal keypad and the
      // formatted output everywhere else (fmtCurrency). No thousand
      // separator — keeps round-tripping through parseAmount() lossless.
      function _formatAmountInput(n) {
        return n.toFixed(2).replace('.', ',');
      }

      function normalizeAmountInput() {
        const inp = document.getElementById('inputAmount');
        const n = parseAmount(inp.value);
        if (!isNaN(n)) inp.value = _formatAmountInput(n);
      }

      function removeTag(t) {
        currentTags = currentTags.filter((x) => x !== t);
        renderTagPills();
        renderTagSuggestions();
      }
      function renderTagPills() {
        const wrap = document.getElementById('tagsWrap');
        const btn = document.getElementById('tagPickerBtn');
        wrap.innerHTML = currentTags
          .map(
            (t) =>
              `<span class="tag-pill">${_escText(t)}<button type="button" data-remove-tag="${_escAttr(t)}" aria-label="Tag „${_escAttr(t)}“ entfernen">${ICON_SVG.close}</button></span>`
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
          toast('Gib Betrag und Datum ein.', 'error');
          return;
        }
        const body = {
          amount,
          desc,
          category_id: cat || null,
          date,
          type: currentType,
          tags: currentTags,
        };
        const editId = document.getElementById('modalOverlay').dataset.editId;
        const method = editId ? 'PUT' : 'POST';
        const path = editId ? `/transactions/${editId}` : '/transactions';
        try {
          await api(method, path, body);
          mergeIntoAvailableTags(currentTags);
          closeModal();
          await Promise.all([loadAndRender(), loadTags()]);
        } catch (e) {
          if (!navigator.onLine && window.PocketLogOutbox) {
            await window.PocketLogOutbox.enqueue({ method, path, body });
            mergeIntoAvailableTags(currentTags);
            closeModal();
            updateSyncBadge();
            return;
          }
          toast('Fehler beim Speichern: ' + e.message, 'error');
        }
      }

      function mergeIntoAvailableTags(tags) {
        if (!Array.isArray(tags) || !tags.length) return;
        const lower = new Set(availableTags.map((t) => t.toLowerCase()));
        let changed = false;
        for (const t of tags) {
          const v = (t || '').trim().toLowerCase();
          if (!v) continue;
          tagCounts.set(v, (tagCounts.get(v) || 0) + 1);
          if (!lower.has(v)) {
            availableTags.push(v);
            lower.add(v);
            changed = true;
          }
        }
        if (changed) {
          availableTags.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
          renderTagList();
        }
      }

      // ── CATEGORIES ────────────────────────────────────────────────────────────────
      const CAT_CREATE_COLORS = ['#D97757', '#6b7aa1', '#788C5D', '#c47ab0', '#e0a44a', '#87867F'];

      async function loadCategories() {
        try {
          categories = await api('GET', '/categories');
        } catch (e) {
          categories = [];
        }
      }

      async function loadTags() {
        try {
          const tags = await api('GET', '/tags');
          const list = Array.isArray(tags) ? tags : [];
          availableTags = list.map((t) => (typeof t === 'string' ? t : t.name));
          tagCounts.clear();
          for (const t of list) {
            if (typeof t === 'string') continue;
            tagCounts.set(t.name.toLowerCase(), Number(t.count) || 0);
          }
        } catch (e) {
          availableTags = [];
          tagCounts.clear();
        }
        renderTagList();
      }

      function renderTagSuggestions() {
        const box = document.getElementById('tagSuggestions');
        if (!box) return;
        const selected = new Set(currentTags.map((x) => x.toLowerCase()));
        const remaining = availableTags.filter((t) => !selected.has(t.toLowerCase()));
        // Pick the 10 most-used (last 30 days), then render alphabetically
        // so users can scan the row without re-learning order each open.
        remaining.sort((a, b) => {
          const ca = tagCounts.get(a.toLowerCase()) || 0;
          const cb = tagCounts.get(b.toLowerCase()) || 0;
          if (cb !== ca) return cb - ca;
          return a.localeCompare(b, undefined, { sensitivity: 'base' });
        });
        const top = remaining.slice(0, 10);
        top.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
        box.innerHTML = top
          .map(
            (t) =>
              `<button type="button" class="tag-suggestion" data-add-tag="${_escAttr(t)}">+ ${_escText(t)}</button>`
          )
          .join('');
        box.querySelectorAll('[data-add-tag]').forEach((el) => {
          el.addEventListener('click', () => addTagFromSuggestion(el.dataset.addTag));
        });
      }

      function addTagFromSuggestion(t) {
        if (!t) return;
        const key = t.toLowerCase();
        if (!currentTags.some((x) => x.toLowerCase() === key)) currentTags.push(t);
        renderTagPills();
        renderTagSuggestions();
      }

      // ── TAG PICKER MODAL ──────────────────────────────────────────────────────────
      // Staging state: changes apply to `currentTags` only on „Fertig".
      let pickerSelection = [];

      function openTagPicker() {
        rememberModalFocus('tagPicker');
        pickerSelection = [...currentTags];
        document.getElementById('tagPickerFilter').value = '';
        document.getElementById('tagPickerNew').value = '';
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
        // Booking modal is the parent here — keep scroll-lock if it's still open.
        if (!document.getElementById('modalOverlay').classList.contains('open')) {
          document.body.style.overflow = '';
        }
        pickerSelection = [];
        releaseFocusTrap('tagPicker');
        restoreModalFocus('tagPicker');
      }
      function closeTagPickerOutside(e) {
        if (e.target === document.getElementById('tagPickerOverlay')) closeTagPicker();
      }
      function commitTagPicker() {
        currentTags = [...pickerSelection];
        closeTagPicker();
        renderTagPills();
        renderTagSuggestions();
      }
      function renderTagPickerChips() {
        const box = document.getElementById('tagPickerChips');
        if (!box) return;
        const q = (document.getElementById('tagPickerFilter').value || '')
          .trim()
          .toLowerCase();
        const filtered = q
          ? availableTags.filter((t) => t.toLowerCase().includes(q))
          : availableTags;
        const selected = new Set(pickerSelection.map((x) => x.toLowerCase()));
        box.innerHTML = filtered
          .map((t) => {
            const isSel = selected.has(t.toLowerCase());
            return `<button type="button" class="tag-picker-chip${isSel ? ' selected' : ''}" data-pick-tag="${_escAttr(t)}">${_escText(t)}</button>`;
          })
          .join('');
        box.querySelectorAll('[data-pick-tag]').forEach((el) => {
          el.addEventListener('click', () => togglePickerTag(el.dataset.pickTag));
        });
      }
      function togglePickerTag(t) {
        const i = pickerSelection.findIndex((x) => x.toLowerCase() === t.toLowerCase());
        if (i >= 0) pickerSelection.splice(i, 1);
        else pickerSelection.push(t);
        renderTagPickerChips();
      }
      function handleTagPickerNew(e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          addTagFromPicker();
        }
      }
      function addTagFromPicker() {
        const inp = document.getElementById('tagPickerNew');
        const val = inp.value.trim();
        if (!val) return;
        const key = val.toLowerCase();
        const existing = availableTags.find((t) => t.toLowerCase() === key);
        const name = existing || val;
        if (!existing) {
          availableTags.push(name);
          availableTags.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
        }
        if (!pickerSelection.some((x) => x.toLowerCase() === key)) {
          pickerSelection.push(name);
        }
        inp.value = '';
        renderTagPickerChips();
      }

      function renderCategories() {
        const box = document.getElementById('catList');
        if (!box) return;
        if (!categories.length) {
          box.innerHTML =
            '<p class="empty-state-hint">Noch keine Kategorien vorhanden.</p>';
          return;
        }
        const sorted = [...categories].sort((a, b) =>
          a.name.localeCompare(b.name, 'de', { sensitivity: 'base' })
        );
        box.innerHTML = sorted
          .map(
            (c) => `
    <div class=”tag-pill cat-pill-edit” role=”button” tabindex=”0”
      aria-label=”Kategorie „${_escAttr(c.name)}” bearbeiten”
      onclick=”openCatModal(${c.id})”
      onkeydown=”handleRowActivate(event, () => openCatModal(${c.id}))”><div class=”drawer-nav-icon-wrap” style=”--nav-icon-bg:${c.color}”>${catIconSvg(c.icon)}</div>${_escText(c.name)}</div>
  `
          )
          .join('');
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
          title: 'Haus & Haushalt',
          ids: ['house', 'buildings', 'door', 'bed', 'armchair', 'couch',
            'chair', 'television', 'lightbulb', 'fan', 'oven', 'plug',
            'key', 'wrench', 'hammer', 'paint-brush', 'broom', 'fire'],
        },
        {
          title: 'Kleidung & Pflege',
          ids: ['t-shirt', 'dress', 'hoodie', 'pants', 'sneaker',
            'eyeglasses', 'watch', 'backpack', 'handbag', 'baby',
            'coat-hanger', 'washing-machine', 'scissors', 'shower',
            'drop', 'toilet-paper'],
        },
        {
          title: 'Lebensmittel & Getränke',
          ids: ['shopping-cart', 'basket', 'bag', 'bag-simple', 'bread',
            'egg', 'carrot', 'fish', 'orange', 'avocado', 'pepper',
            'hamburger', 'pizza', 'cookie', 'cake', 'ice-cream',
            'bowl-food', 'bowl-steam', 'coffee', 'beer-stein', 'wine',
            'martini', 'fork-knife', 'knife'],
        },
        {
          title: 'Mobilität',
          ids: ['car', 'taxi', 'bus', 'truck', 'motorcycle', 'scooter',
            'bicycle', 'train', 'train-regional', 'airplane', 'boat',
            'gas-pump', 'map-pin', 'road-horizon'],
        },
        {
          title: 'Freizeit',
          ids: ['film-strip', 'camera', 'game-controller', 'dice-five',
            'music-note', 'guitar', 'headphones', 'microphone',
            'palette', 'confetti', 'book', 'books', 'gift', 'ticket',
            'soccer-ball', 'basketball', 'tennis-ball', 'tree-palm'],
        },
        {
          title: 'Gesundheit',
          ids: ['pill', 'first-aid-kit', 'bandaids', 'heartbeat',
            'stethoscope', 'syringe', 'hospital', 'brain', 'virus',
            'mask-happy', 'tooth', 'dog', 'cat'],
        },
        {
          title: 'Büro & Bildung',
          ids: ['briefcase', 'graduation-cap', 'chalkboard', 'book-open',
            'pencil', 'envelope', 'calendar', 'clipboard', 'calculator',
            'laptop', 'folder', 'files', 'magnifying-glass',
            'newspaper-clipping', 'paperclip'],
        },
        {
          title: 'Finanzen',
          ids: ['wallet', 'credit-card', 'bank', 'vault', 'coins', 'coin',
            'coin-vertical', 'piggy-bank', 'currency-eur',
            'currency-dollar', 'hand-coins', 'receipt', 'invoice',
            'money', 'trend-up', 'trend-down', 'chart-line', 'percent'],
        },
        {
          title: 'Sonstiges',
          ids: ['package', 'star', 'heart', 'sparkle', 'magic-wand',
            'globe', 'bell', 'alarm', 'sun', 'moon', 'cloud', 'snowflake',
            'umbrella', 'mountains', 'tree', 'plant', 'leaf',
            'flower-tulip', 'butterfly', 'smiley', 'anchor', 'tag',
            'question'],
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
      // category breakdown, picker). The file is cache-first via the SW.
      async function loadCategoryIconSprite() {
        if (document.getElementById('cat-icon-sprite')) return;
        try {
          const res = await fetch('/icons/categories/sprite.svg');
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

      let editingCatId = null;
      let editingCatColor = '#9e9b96';
      let editingCatIcon = CAT_ICON_FALLBACK;

      function openCatModal(id) {
        rememberModalFocus('cat');
        const deleteBtn = document.getElementById('catDeleteBtn');
        const title = document.getElementById('catModalTitle');
        if (id) {
          const c = categories.find((x) => x.id === id);
          if (!c) return;
          editingCatId = c.id;
          editingCatColor = c.color || '#9e9b96';
          editingCatIcon = CAT_ICON_VALID.has(c.icon) ? c.icon : CAT_ICON_FALLBACK;
          document.getElementById('catEditName').value = c.name || '';
          title.textContent = 'Kategorie bearbeiten';
          deleteBtn.style.display = '';
        } else {
          editingCatId = null;
          editingCatColor = CAT_CREATE_COLORS[categories.length % CAT_CREATE_COLORS.length];
          editingCatIcon = CAT_ICON_FALLBACK;
          document.getElementById('catEditName').value = '';
          title.textContent = 'Neue Kategorie';
          deleteBtn.style.display = 'none';
        }
        renderCatColorSwatches();
        renderCatIconPreview();
        document.getElementById('catModalOverlay').classList.add('open');
        document.body.style.overflow = 'hidden';
        setTimeout(() => document.getElementById('catEditName').focus(), 200);
        trapFocusIn(document.querySelector('#catModalOverlay .modal'), 'cat');
      }

      function renderCatIconPreview() {
        const el = document.getElementById('catEditIconPreview');
        if (!el) return;
        el.style.color = editingCatColor;
        el.innerHTML = catIconSvg(editingCatIcon);
      }

      function renderCatColorSwatches() {
        const presets = [...CAT_COLOR_PRESETS];
        const hasCurrent = presets.some(
          (p) => p.hex.toLowerCase() === editingCatColor.toLowerCase()
        );
        if (!hasCurrent) presets.push({ hex: editingCatColor, name: 'Eigene Farbe' });
        const box = document.getElementById('catEditColors');
        box.innerHTML =
          presets
            .map((p) => {
              const isActive = p.hex.toLowerCase() === editingCatColor.toLowerCase();
              return `<button type="button" class="color-swatch${isActive ? ' active' : ''}" style="background:${p.hex}" aria-label="Farbe ${p.name} wählen" aria-pressed="${isActive}" onclick="pickCatColor('${p.hex}')"></button>`;
            })
            .join('') +
          `<label class="color-swatch-custom" title="Eigene Farbe">
     <input type="color" value="${editingCatColor}" onchange="pickCatColor(this.value)" aria-label="Eigene Farbe wählen">
   </label>`;
      }

      function pickCatColor(c) {
        editingCatColor = c;
        renderCatColorSwatches();
        renderCatIconPreview();
      }

      function closeCatModal() {
        document.getElementById('catModalOverlay').classList.remove('open');
        document.body.style.overflow = '';
        editingCatId = null;
        releaseFocusTrap('cat');
        restoreModalFocus('cat');
      }
      function closeCatModalOutside(e) {
        if (e.target === document.getElementById('catModalOverlay')) closeCatModal();
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
          const cells = g.ids.map((id) => {
            const active = id === editingCatIcon ? ' active' : '';
            const pressed = active ? 'true' : 'false';
            return `<button type="button" class="icon-picker-cell${active}"
              aria-pressed="${pressed}" aria-label="${id}"
              onclick="pickIcon('${id}')">${catIconSvg(id)}</button>`;
          }).join('');
          return `<section class="icon-picker-section">
            <h3 class="icon-picker-section-title">${g.title}</h3>
            <div class="icon-picker-grid">${cells}</div>
          </section>`;
        }).join('');
      }

      function pickIcon(id) {
        editingCatIcon = CAT_ICON_VALID.has(id) ? id : CAT_ICON_FALLBACK;
        renderCatIconPreview();
        closeIconPicker();
      }

      async function saveCategoryEdit() {
        const name = document.getElementById('catEditName').value.trim();
        const icon = CAT_ICON_VALID.has(editingCatIcon)
          ? editingCatIcon
          : CAT_ICON_FALLBACK;
        if (!name) {
          toast('Name ist ein Pflichtfeld.', 'error');
          return;
        }
        if (!/^#[0-9a-fA-F]{6}$/.test(editingCatColor)) {
          toast(
            'Die Farbe ist ungültig. Ein gültiger Hex-Wert wird benötigt, z. B. #D97757.',
            'error'
          );
          return;
        }
        try {
          if (editingCatId) {
            await api('PUT', `/categories/${editingCatId}`, { name, icon, color: editingCatColor });
          } else {
            await api('POST', '/categories', { name, icon, color: editingCatColor });
          }
          closeCatModal();
          await loadCategories();
          renderCategories();
          await loadAndRender();
        } catch (e) {
          if (e.message && e.message.includes('409')) {
            toast('Eine Kategorie mit diesem Namen existiert bereits.', 'error');
          } else {
            toast('Fehler beim Speichern: ' + e.message, 'error');
          }
        }
      }

      async function deleteCategoryEdit() {
        if (!editingCatId) return;
        const ok = await confirmAction({
          title: 'Kategorie wirklich löschen?',
          confirmLabel: 'Löschen',
        });
        if (!ok) return;
        try {
          await api('DELETE', `/categories/${editingCatId}`);
          closeCatModal();
          await loadCategories();
          renderCategories();
          await loadAndRender();
        } catch (e) {
          if (e.message && e.message.includes('409')) {
            toast(
              'Kategorie wird noch in Buchungen verwendet und kann nicht gelöscht werden.',
              'error'
            );
          } else {
            toast('Fehler beim Löschen: ' + e.message, 'error');
          }
        }
      }

      // ── TAGS (Einstellungen) ──────────────────────────────────────────────────────
      let editingTagName = null;

      function renderTagList() {
        const box = document.getElementById('tagList');
        if (!box) return;
        if (!availableTags.length) {
          box.innerHTML =
            '<p class="empty-state-hint">Noch keine Tags vorhanden.</p>';
          return;
        }
        box.innerHTML = availableTags
          .map(
            (t) =>
              `<div class="tag-pill cat-pill-edit" data-tag="${_escAttr(t)}">${_escText(t)}</div>`
          )
          .join('');
        box.querySelectorAll('[data-tag]').forEach((el) => {
          el.addEventListener('click', () => openTagModal(el.dataset.tag));
        });
      }

      function openTagModal(name) {
        rememberModalFocus('tag');
        const deleteBtn = document.getElementById('tagDeleteBtn');
        const title = document.getElementById('tagModalTitle');
        if (name) {
          editingTagName = name;
          document.getElementById('tagEditName').value = name;
          title.textContent = 'Tag bearbeiten';
          deleteBtn.style.display = '';
        } else {
          editingTagName = null;
          document.getElementById('tagEditName').value = '';
          title.textContent = 'Neuer Tag';
          deleteBtn.style.display = 'none';
        }
        document.getElementById('tagModalOverlay').classList.add('open');
        document.body.style.overflow = 'hidden';
        setTimeout(() => document.getElementById('tagEditName').focus(), 200);
        trapFocusIn(document.querySelector('#tagModalOverlay .modal'), 'tag');
      }

      function closeTagModal() {
        document.getElementById('tagModalOverlay').classList.remove('open');
        document.body.style.overflow = '';
        editingTagName = null;
        releaseFocusTrap('tag');
        restoreModalFocus('tag');
      }
      function closeTagModalOutside(e) {
        if (e.target === document.getElementById('tagModalOverlay')) closeTagModal();
      }

      async function saveTagEdit() {
        const newName = document.getElementById('tagEditName').value.trim();
        if (!newName) {
          toast('Name ist ein Pflichtfeld.', 'error');
          return;
        }
        if (editingTagName && newName === editingTagName) {
          closeTagModal();
          return;
        }
        try {
          if (editingTagName) {
            await api('PUT', `/tags/${encodeURIComponent(editingTagName)}`, { new_name: newName });
          } else {
            await api('POST', '/tags', { name: newName });
          }
          closeTagModal();
          await loadTags();
          renderTagList();
          await loadAndRender();
        } catch (e) {
          if (e.message && e.message.includes('409')) {
            toast('Ein Tag mit diesem Namen existiert bereits.', 'error');
          } else {
            toast('Fehler beim Speichern: ' + e.message, 'error');
          }
        }
      }

      async function deleteTagEdit() {
        if (!editingTagName) return;
        const ok = await confirmAction({
          title: 'Tag wirklich löschen?',
          message: 'Der Tag wird aus allen Buchungen entfernt.',
          confirmLabel: 'Löschen',
        });
        if (!ok) return;
        try {
          await api('DELETE', `/tags/${encodeURIComponent(editingTagName)}`);
          closeTagModal();
          await loadTags();
          renderTagList();
          await loadAndRender();
        } catch (e) {
          toast('Fehler beim Löschen: ' + e.message, 'error');
        }
      }

      // ── SYNC (Service-Worker-Outbox) ──────────────────────────────────────────────
      // Online-Schreibvorgänge laufen direkt; offline landen sie in der IndexedDB-
      // Outbox (frontend/db.js) und werden bei wieder hergestellter Verbindung
      // vom Service Worker bzw. diesem Aufruf nachgespielt.
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
        if (btn) btn.setAttribute('aria-label', `Synchronisieren – ${status}`);
        // The dedicated live region announces the change actively; the
        // aria-label above gives a stable description on focus.
        const live = document.getElementById('syncAriaLive');
        if (live) live.textContent = status;
      }

      async function syncNow() {
        const btn = document.getElementById('syncBtn');
        const dot = document.getElementById('syncDot');

        btn.classList.remove('error');
        dot.classList.remove('error');
        dot.classList.add('syncing');
        setSyncAria('Wird synchronisiert');

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
            console.error('Sync (drain) fehlgeschlagen:', e);
          }
        }

        if (!networkErr) {
          try {
            const r = await fetch(API + '/health', { cache: 'no-store' });
            if (!r.ok) throw new Error('HTTP ' + r.status);
          } catch (e) {
            networkErr = true;
            console.error('Sync (health) fehlgeschlagen:', e);
          }
        }

        const remaining = window.PocketLogOutbox ? await window.PocketLogOutbox.count() : 0;
        dot.classList.remove('syncing');

        if (networkErr) {
          btn.classList.add('error');
          dot.classList.add('error');
          setSyncBadge(remaining);
          const msg = 'Offline – Änderungen werden gespeichert';
          setSyncAria(msg);
          toast(msg, 'error');
          return;
        }
        if (remaining > 0) {
          btn.classList.add('error');
          dot.classList.add('error');
          setSyncBadge(remaining);
          const msg = 'Synchronisation fehlgeschlagen – Verbindung prüfen';
          setSyncAria(msg);
          toast(msg, 'error');
          return;
        }

        setSyncBadge(0);
        setSyncAria('Gespeichert');
        if (failed > 0) {
          const msg = failed === 1
            ? '1 Buchung konnte nicht gespeichert werden.'
            : `${failed} Buchungen konnten nicht gespeichert werden.`;
          toast(msg, 'error');
        }
        if (flushed > 0 || failed > 0) await loadTags();
        await loadAndRender();
      }

      function saveDefaultView(view) {
        localStorage.setItem('pocketlog.defaultView', view);
        pushSettings({ default_view: view });
      }

      function loadDefaultView() {
        return localStorage.getItem('pocketlog.defaultView') || 'transactions';
      }

      function syncDefaultViewRadios() {
        const val = loadDefaultView();
        document.querySelectorAll('input[name="defaultView"]').forEach((r) => {
          r.checked = r.value === val;
        });
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
      window
        .matchMedia('(prefers-color-scheme: dark)')
        .addEventListener('change', (e) => {
          const manual = localStorage.getItem(THEME_KEY);
          if (manual === 'dark' || manual === 'light') return;
          document.documentElement.setAttribute('data-dark', e.matches ? 'true' : 'false');
          if (_activePanel === 'charts') renderReport();
        });

      function saveTheme(theme) {
        localStorage.setItem(THEME_KEY, theme);
        applyTheme(theme);
        pushSettings({ theme });
        if (_activePanel === 'charts') renderReport();
      }

      function loadTheme() {
        return localStorage.getItem(THEME_KEY) || 'system';
      }

      function syncThemeRadios() {
        const val = loadTheme();
        document.querySelectorAll('input[name="appTheme"]').forEach((r) => {
          r.checked = r.value === val;
        });
      }

      // ── SETTINGS-BACKUP (Server) ──────────────────────────────────────────────────
      // localStorage rendert sofort — diese Helpers gleichen das mit der DB ab,
      // damit das Theme + die Startansicht eine iOS-localStorage-Eviction überleben.
      // PUT geht durchs api()-Helper, im Offline-Fall fängt der SW-Outbox alles ab.
      function pushSettings(patch) {
        api('PUT', '/settings', patch).catch(() => {});
      }

      async function reconcileSettingsFromServer() {
        let s;
        try {
          s = await api('GET', '/settings');
        } catch (_) {
          return; // offline / nicht erreichbar → localStorage gilt
        }
        if (!s || s.offline) return;
        if (s.theme && s.theme !== loadTheme()) {
          localStorage.setItem(THEME_KEY, s.theme);
          applyTheme(s.theme);
          syncThemeRadios();
        }
        if (s.default_view && s.default_view !== loadDefaultView()) {
          // Panel-Switch mitten in der Session wäre disruptiv — nur die
          // Persistenz nachziehen, beim nächsten Start greift der Wert.
          localStorage.setItem('pocketlog.defaultView', s.default_view);
          syncDefaultViewRadios();
        }
      }


      async function updateSyncBadge() {
        const btn = document.getElementById('syncBtn');
        const dot = document.getElementById('syncDot');
        if (!window.PocketLogOutbox) {
          btn.classList.remove('error');
          dot.classList.remove('error');
          setSyncBadge(0);
          setSyncAria('Gespeichert');
          return;
        }
        const pending = await window.PocketLogOutbox.count();
        if (pending > 0) {
          setSyncBadge(pending);
          setSyncAria('Änderungen werden gespeichert');
        } else {
          btn.classList.remove('error');
          dot.classList.remove('error');
          setSyncBadge(0);
          setSyncAria('Gespeichert');
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
        const inField =
          ['input', 'textarea', 'select'].includes(tag) || e.target.isContentEditable;
        const modalOpen = !!document.querySelector('.modal-overlay.open');
        const drawerOpenMobile =
          document.getElementById('drawer').classList.contains('open') &&
          !_mqTablet.matches;

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
        if (!modalOpen && !drawerOpenMobile && !inField) {
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
        const confirmOverlay = Array.from(
          document.querySelectorAll('.modal-overlay.open')
        ).find((o) => o.querySelector('.confirm-modal'));
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
        if (document.getElementById('modalOverlay').classList.contains('open')) {
          closeModal();
          return;
        }
        if (document.getElementById('drawer').classList.contains('open')) {
          closeDrawer();
        }
      });

      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', (ev) => {
          if (ev.data?.type === 'SYNC_DONE') {
            const failed = ev.data.failed || 0;
            if (failed > 0) {
              const msg = failed === 1
                ? '1 Buchung konnte nicht gespeichert werden.'
                : `${failed} Buchungen konnten nicht gespeichert werden.`;
              toast(msg, 'error');
            }
            loadTags();
            loadAndRender();
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
            await navigator.share({ files: [file], title: 'PocketLog Export' });
          } else {
            _triggerDownload(blob, 'pocketlog.csv');
          }
        } catch (e) {
          if (e.name !== 'AbortError') showToast('Export fehlgeschlagen', 'error');
        }
      }

      async function downloadExampleCSV() {
        try {
          const res = await fetch('/example-import.csv');
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const blob = await res.blob();
          const file = new File([blob], 'pocketlog-beispiel.csv', { type: 'text/csv' });
          if (navigator.canShare?.({ files: [file] })) {
            await navigator.share({ files: [file], title: 'PocketLog Beispieldatei' });
          } else {
            _triggerDownload(blob, 'pocketlog-beispiel.csv');
          }
        } catch (e) {
          if (e.name !== 'AbortError') showToast('Download fehlgeschlagen', 'error');
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
        status.textContent = 'Wird importiert';
        status.className = 'status-msg';
        const fd = new FormData();
        fd.append('file', file);
        try {
          const res = await fetch(API + '/import/csv', { method: 'POST', body: fd });
          if (!res.ok) {
            const txt = await res.text();
            throw new Error('HTTP ' + res.status + ' – ' + txt.slice(0, 200));
          }
          const r = await res.json();
          const parts = [`${r.imported} Buchungen importiert`];
          if (r.skipped) parts.push(`${r.skipped} übersprungen`);
          if (r.errors && r.errors.length) {
            parts.push(`${r.errors.length} Zeilen übersprungen`);
            console.warn('CSV-Import: Fehlerhafte Zeilen', r.errors);
          }
          status.textContent = parts.join(' · ');
          status.className = 'status-msg ' + (r.imported > 0 ? 'ok' : 'err');
          await loadCategories();
          await loadTags();
          await loadAndRender();
        } catch (e) {
          status.textContent = 'Import fehlgeschlagen – Verbindung prüfen';
          status.className = 'status-msg err';
        } finally {
          ev.target.value = ''; // gleichen File-Reimport erlauben
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
      function closeResetModalOutside(e) {
        if (e.target === document.getElementById('resetModalOverlay')) closeResetModal();
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
          toast('Löschen fehlgeschlagen: ' + e.message, 'error');
        }
      }

      async function resetTransactionsOnly() {
        await _runReset('/admin/transactions', 'Alle Buchungen gelöscht.');
      }

      async function resetAllData() {
        await _runReset('/admin/all-data', 'Alle Daten gelöscht.');
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
            ? 'Möglicherweise nicht synchronisierte Änderungen gehen dabei verloren.'
            : pending > 0
              ? `${pending} noch nicht synchronisierte Änderungen gehen dabei verloren.`
              : 'App-Daten werden beim nächsten Laden neu geholt.';
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

      function closeCacheModalOutside(e) {
        if (e.target === document.getElementById('cacheModalOverlay')) closeCacheModal();
      }

      async function confirmClearAppCache() {
        try {
          if ('caches' in window) {
            const keys = await caches.keys();
            await Promise.all(
              keys.filter((k) => k.startsWith('pocketlog-api-')).map((k) => caches.delete(k))
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
          toast('Cache geleert.', 'ok');
        } catch (e) {
          toast('Cache konnte nicht geleert werden: ' + e.message, 'error');
        }
      }

      // ── INFO PANEL ────────────────────────────────────────────────────────────────
      // Beste-Aufwand-Erkennung. UA-Strings sind notorisch unzuverlässig —
      // diese Werte sind ausschließlich für Debug-Anzeige gedacht, niemals
      // als Logik-Schalter.
      function _detectPlatform() {
        const ua = navigator.userAgent || '';
        const touch = navigator.maxTouchPoints || 0;
        const fmt = (a, b, c) => `${a}.${b}${c ? '.' + c : ''}`;
        let m;
        // Apple deckelt OS-Versionen mittlerweile in allen Browser-UAs ein
        // (macOS auf 10_15_7 seit Safari 14, iPadOS gibt im Desktop-Spoof
        // gar nichts mehr aus, und seit iOS 26 friert auch der iPhone-UA
        // auf „18_x" ein). Daher überall nur den Plattformnamen.
        if (/iPad/.test(ua) || (/Macintosh/.test(ua) && touch > 1)) return 'iPad';
        if (/iPhone/.test(ua)) return 'iPhone';
        if (/Android/.test(ua)) {
          const v = ua.match(/Android (\d+(?:\.\d+)*)/);
          // Modell steht hinter dem zweiten Semikolon und vor ' Build/' bzw. ')'.
          const mm = ua.match(/Android[^;]*;[^;]*;\s*([^;)]+?)(?:\s+Build|\))/)
                  || ua.match(/;\s*([^;)]+)\s+Build\//);
          const model = mm ? mm[1].trim() : '';
          return `Android${v ? ' ' + v[1] : ''}${model ? ' · ' + model : ''}`;
        }
        if (/Macintosh/.test(ua)) return 'Mac';
        if (/Windows NT/.test(ua)) {
          m = ua.match(/Windows NT (\d+\.\d+)/);
          const map = { '10.0': '10/11', '6.3': '8.1', '6.2': '8', '6.1': '7' };
          return m ? `Windows ${map[m[1]] || m[1]}` : 'Windows';
        }
        if (/CrOS/.test(ua)) return 'ChromeOS';
        if (/Linux/.test(ua)) return 'Linux';
        return 'Unbekannt';
      }

      function _detectBrowser() {
        const ua = navigator.userAgent || '';
        let m;
        // iOS-Alternativbrowser sind alle WebKit, lassen sich aber am
        // herstellerspezifischen Token erkennen — wichtig vor dem Safari-Match.
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
        if (window.matchMedia('(display-mode: fullscreen)').matches) return 'Vollbild';
        // iOS-Safari nutzt die nicht-standardisierte navigator.standalone-Flag
        // statt display-mode, bis heute.
        if (navigator.standalone === true) return 'PWA (Home-Bildschirm)';
        return 'Browser-Tab';
      }

      function _detectPointer() {
        const coarse = window.matchMedia('(pointer: coarse)').matches;
        const fine = window.matchMedia('(pointer: fine)').matches;
        const hover = window.matchMedia('(hover: hover)').matches;
        const parts = [];
        if (coarse && fine) parts.push('Touch + Maus');
        else if (coarse) parts.push('Touch');
        else if (fine) parts.push('Maus/Trackpad');
        else parts.push('Unbekannt');
        const touchPts = navigator.maxTouchPoints || 0;
        if (touchPts > 0) parts.push(`max ${touchPts} Touch-Punkte`);
        if (!hover) parts.push('kein Hover');
        return parts.join(' · ');
      }

      // Jede renderInfoPanel-Invocation bekommt eine Sequenznummer; async
      // Antworten (Backend-Version, Health-Probe) überschreiben das DOM nur
      // dann, wenn sie noch zum aktuellen Durchgang gehören. Verhindert,
      // dass eine alte, langsame Antwort einen neueren Stand überschreibt,
      // wenn der User das Panel schnell zweimal öffnet.
      let _infoPanelSeq = 0;

      async function renderInfoPanel() {
        const mySeq = ++_infoPanelSeq;
        const set = (id, value) => {
          if (mySeq !== _infoPanelSeq) return;
          const el = document.getElementById(id);
          if (el) el.textContent = value;
        };

        const dpr = window.devicePixelRatio || 1;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const sw = window.screen ? window.screen.width : 0;
        const sh = window.screen ? window.screen.height : 0;
        // Browser-Zoom näherungsweise aus outerWidth/innerWidth. Auf macOS
        // Safari/Firefox zählt das Fenster-Chrome minimal mit, daher runden.
        // visualViewport.scale fängt Pinch-Zoom auf Touch-Geräten ein.
        const zoomRatio = window.outerWidth && vw ? window.outerWidth / vw : 1;
        const zoomPct = Math.round(zoomRatio * 100);
        const pinch = window.visualViewport ? window.visualViewport.scale : 1;
        const zoomParts = [`${zoomPct}%`];
        if (pinch && Math.abs(pinch - 1) > 0.01) {
          zoomParts.push(`Pinch ${Math.round(pinch * 100) / 100}×`);
        }

        set('infoBackendVersion', 'Wird geladen');
        set('infoSwVersion', '–');
        set('infoOnline', navigator.onLine ? 'Prüfe Backend…' : 'Offline');
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
              set('infoSwState', 'Nicht registriert');
            } else {
              const sw = reg.active || reg.waiting || reg.installing;
              const state = sw ? sw.state : 'unbekannt';
              const controlled = navigator.serviceWorker.controller ? ' · aktiv' : '';
              set('infoSwState', `${state}${controlled}`);
            }
          } catch (e) {
            set('infoSwState', 'Fehler');
          }
          try {
            const keys = await caches.keys();
            const shellKey = keys.find((k) => k.startsWith('pocketlog-shell-'));
            set('infoSwVersion', shellKey ? shellKey.replace('pocketlog-shell-', '') : '–');
          } catch (e) {
            set('infoSwVersion', '–');
          }
        } else {
          set('infoSwState', 'Nicht unterstützt');
        }

        // Outbox-Stand
        try {
          const pending = window.PocketLogOutbox ? await window.PocketLogOutbox.count() : 0;
          set('infoOutbox', String(pending));
        } catch (e) {
          set('infoOutbox', '–');
        }

        // Backend-Health-Probe – ehrlicher als navigator.onLine, das nur
        // sagt, ob irgendein Netzwerk-Interface da ist. Läuft nur beim
        // Öffnen des Panels (kein Polling) und nur wenn der Browser
        // überhaupt online meldet — sonst wäre der Fetch sicher umsonst.
        if (navigator.onLine) {
          try {
            const res = await fetch(API + '/health', { cache: 'no-store' });
            set('infoOnline', res.ok ? 'Online · Backend erreichbar' : `Online · HTTP ${res.status}`);
          } catch (e) {
            set('infoOnline', 'Online · Backend unerreichbar');
          }
        }

        // Backend-Version – ohne api()-Helper, da /api/version öffentlich ist
        // und keinen Auth-Header braucht. Direkter Fetch vermeidet außerdem,
        // dass die SW-Outbox bei Offline-Zustand eine Schreib-Operation queued.
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

      // ── LOGOUT + KONTO ────────────────────────────────────────────────────────────
      async function logoutWithConfirm() {
        let pending = 0;
        try {
          pending = window.PocketLogOutbox ? await window.PocketLogOutbox.count() : 0;
        } catch (_) {}
        if (pending > 0) {
          const ok = await confirmAction({
            title: 'Trotzdem abmelden?',
            message:
              `${pending} noch nicht synchronisierte Änderung${pending === 1 ? '' : 'en'} ` +
              'geht beim Abmelden verloren.',
            confirmLabel: 'Trotzdem abmelden',
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
        try {
          if (navigator.serviceWorker?.controller) {
            navigator.serviceWorker.controller.postMessage({ type: 'CLEAR_API_CACHE' });
          }
        } catch (_) {}
        location.reload();
      }

      // ── PASSWORT ÄNDERN (Self-Service) ────────────────────────────────────────────
      function openChangePasswordModal() {
        document.getElementById('pwModalCurrent').value = '';
        document.getElementById('pwModalNew').value = '';
        document.getElementById('pwModalConfirm').value = '';
        _setAuthError('pwModalError', '');
        document.getElementById('pwModalOverlay').classList.add('open');
        document.body.style.overflow = 'hidden';
        setTimeout(() => document.getElementById('pwModalCurrent')?.focus(), 50);
      }
      function closePwModal() {
        document.getElementById('pwModalOverlay').classList.remove('open');
        if (!document.getElementById('drawer').classList.contains('open')) {
          document.body.style.overflow = '';
        }
      }
      function closePwModalOutside(e) {
        if (e.target === document.getElementById('pwModalOverlay')) closePwModal();
      }
      async function submitChangePassword() {
        _setAuthError('pwModalError', '');
        const current = document.getElementById('pwModalCurrent').value;
        const next = document.getElementById('pwModalNew').value;
        const confirmPw = document.getElementById('pwModalConfirm').value;
        if (next !== confirmPw) {
          _setAuthError('pwModalError', 'Die neuen Passwörter stimmen nicht überein.');
          return;
        }
        const pwErr = validateNewPassword(next);
        if (pwErr) {
          _setAuthError('pwModalError', pwErr);
          return;
        }
        if (next === current) {
          _setAuthError('pwModalError',
            'Das neue Passwort muss sich vom alten unterscheiden.');
          return;
        }
        try {
          const res = await authFetch('POST', '/auth/change-password', {
            current_password: current, new_password: next,
          });
          if (res.status === 400) {
            const data = await res.json().catch(() => ({}));
            if (data.detail === 'current_password_wrong') {
              _setAuthError('pwModalError', 'Das aktuelle Passwort stimmt nicht.');
            } else if (data.detail === 'password_reused') {
              _setAuthError('pwModalError',
                'Das neue Passwort muss sich vom alten unterscheiden.');
            } else {
              _setAuthError('pwModalError', 'Passwortwechsel fehlgeschlagen.');
            }
            return;
          }
          if (!res.ok) {
            _setAuthError('pwModalError', 'Passwortwechsel fehlgeschlagen.');
            return;
          }
          closePwModal();
          // Andere Sessions sind serverseitig gekillt — diese hier
          // bleibt aktiv. Toast nur zur Bestätigung.
          toast('Passwort geändert.', 'ok');
        } catch (e) {
          _setAuthError('pwModalError', 'Verbindung zum Server fehlgeschlagen.');
        }
      }

      // ── ADMIN: BENUTZERVERWALTUNG ─────────────────────────────────────────────────
      let _adminUsers = [];
      let _currentMe = null;

      async function loadAdminUsers() {
        const list = document.getElementById('adminUserList');
        if (!list) return;
        list.textContent = 'Wird geladen …';
        try {
          _adminUsers = await api('GET', '/admin/users');
        } catch (e) {
          list.textContent = 'Liste konnte nicht geladen werden.';
          return;
        }
        // Aktuelle Identität nochmal frisch ziehen, falls das Body-Flag
        // veraltet ist.
        try {
          const meRes = await fetch(API + '/auth/me', { credentials: 'same-origin' });
          if (meRes.ok) _currentMe = await meRes.json();
        } catch (_) {}
        renderAdminUserList();
      }

      function _escText(s) {
        const tmp = document.createElement('div');
        tmp.textContent = s == null ? '' : String(s);
        return tmp.innerHTML;
      }

      function renderAdminUserList() {
        const list = document.getElementById('adminUserList');
        if (!list) return;
        if (!_adminUsers.length) {
          list.textContent = 'Keine Benutzer gefunden.';
          return;
        }
        // _currentMe MUSS gesetzt sein, sonst kann die UI ihre Self-Schutz-
        // Regeln nicht durchsetzen (Buttons würden auf der eigenen Zeile
        // aktivierbar wirken, obwohl das Backend sie 400/403't). Lieber
        // einen Render-Fehler zeigen als eine UI-Lüge.
        if (!_currentMe || _currentMe.id == null) {
          list.textContent = 'Benutzerliste kann ohne Identitätsdaten nicht angezeigt werden.';
          return;
        }
        const meId = _currentMe.id;
        list.innerHTML = _adminUsers
          .map((u) => {
            const isSelf = u.id === meId;
            const tags = [];
            if (u.is_admin) tags.push('<span class="admin-user-tag admin">Administrator</span>');
            if (!u.is_active) tags.push('<span class="admin-user-tag inactive">Deaktiviert</span>');
            if (u.force_change_password)
              tags.push('<span class="admin-user-tag">Passwortwechsel offen</span>');
            const actions = [];
            actions.push(
              `<button type="button" onclick="openAdminResetPwModal(${u.id})">Passwort zurücksetzen</button>`
            );
            if (!u.is_admin) {
              if (u.is_active) {
                actions.push(
                  `<button type="button" ${isSelf ? 'disabled' : ''} ` +
                  `onclick="adminToggleActive(${u.id}, false)">Deaktivieren</button>`
                );
              } else {
                actions.push(
                  `<button type="button" onclick="adminToggleActive(${u.id}, true)">Reaktivieren</button>`
                );
              }
            }
            actions.push(
              `<button type="button" class="btn-destructive" ${isSelf ? 'disabled' : ''} ` +
              `onclick="adminDeleteUserConfirm(${u.id})">Löschen</button>`
            );
            return `
              <div class="admin-user-row">
                <div class="admin-user-row-head">
                  <span class="admin-user-name">${_escText(u.username)}${isSelf ? ' (du)' : ''}</span>
                </div>
                ${tags.length ? `<div class="admin-user-tags">${tags.join('')}</div>` : ''}
                <div class="admin-user-actions">${actions.join('')}</div>
              </div>`;
          })
          .join('');
      }

      function openAdminCreateUserModal() {
        document.getElementById('adminCreateUsername').value = '';
        document.getElementById('adminCreatePassword').value = '';
        _setAuthError('adminCreateError', '');
        document.getElementById('adminCreateUserOverlay').classList.add('open');
        document.body.style.overflow = 'hidden';
        setTimeout(() => document.getElementById('adminCreateUsername')?.focus(), 50);
      }
      function closeAdminCreateUserModal() {
        document.getElementById('adminCreateUserOverlay').classList.remove('open');
        if (!document.getElementById('drawer').classList.contains('open')) {
          document.body.style.overflow = '';
        }
      }
      function closeAdminCreateUserModalOutside(e) {
        if (e.target === document.getElementById('adminCreateUserOverlay'))
          closeAdminCreateUserModal();
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
            _setAuthError('adminCreateError', 'Der Benutzername ist bereits vergeben.');
            return;
          }
          if (!res.ok) {
            _setAuthError('adminCreateError', 'Benutzer konnte nicht angelegt werden.');
            return;
          }
          closeAdminCreateUserModal();
          await loadAdminUsers();
          toast('Benutzer angelegt.', 'ok');
        } catch (e) {
          _setAuthError('adminCreateError', 'Verbindung zum Server fehlgeschlagen.');
        }
      }

      let _resetPwTargetId = null;
      function openAdminResetPwModal(userId) {
        _resetPwTargetId = userId;
        const target = _adminUsers.find((u) => u.id === userId);
        document.getElementById('adminResetPwIntro').textContent = target
          ? `Setzt das Passwort für „${target.username}" zurück.`
          : '';
        document.getElementById('adminResetPwInput').value = '';
        _setAuthError('adminResetPwError', '');
        document.getElementById('adminResetPwOverlay').classList.add('open');
        document.body.style.overflow = 'hidden';
        setTimeout(() => document.getElementById('adminResetPwInput')?.focus(), 50);
      }
      function closeAdminResetPwModal() {
        document.getElementById('adminResetPwOverlay').classList.remove('open');
        if (!document.getElementById('drawer').classList.contains('open')) {
          document.body.style.overflow = '';
        }
      }
      function closeAdminResetPwModalOutside(e) {
        if (e.target === document.getElementById('adminResetPwOverlay'))
          closeAdminResetPwModal();
      }
      async function submitAdminResetPassword() {
        _setAuthError('adminResetPwError', '');
        if (_resetPwTargetId == null) return;
        const pw = document.getElementById('adminResetPwInput').value;
        const pwErr = validateNewPassword(pw);
        if (pwErr) {
          _setAuthError('adminResetPwError', pwErr);
          return;
        }
        try {
          const res = await authFetch(
            'POST',
            `/admin/users/${_resetPwTargetId}/reset-password`,
            { new_password: pw }
          );
          if (!res.ok) {
            _setAuthError('adminResetPwError', 'Passwort konnte nicht gesetzt werden.');
            return;
          }
          closeAdminResetPwModal();
          await loadAdminUsers();
          toast('Passwort zurückgesetzt.', 'ok');
        } catch (e) {
          _setAuthError('adminResetPwError', 'Verbindung zum Server fehlgeschlagen.');
        }
      }

      async function adminToggleActive(userId, activate) {
        const target = _adminUsers.find((u) => u.id === userId);
        const name = target ? target.username : 'Benutzer';
        const ok = await confirmAction({
          title: activate ? `${name} reaktivieren?` : `${name} deaktivieren?`,
          message: activate
            ? `${name} kann sich anschließend wieder anmelden.`
            : `${name} kann sich danach nicht mehr anmelden. Daten bleiben erhalten.`,
          confirmLabel: activate ? 'Reaktivieren' : 'Deaktivieren',
          destructive: !activate,
        });
        if (!ok) return;
        try {
          const res = await authFetch(
            'POST',
            `/admin/users/${userId}/${activate ? 'activate' : 'deactivate'}`
          );
          if (!res.ok) {
            toast('Aktion fehlgeschlagen.', 'error');
            return;
          }
          await loadAdminUsers();
          toast(activate ? 'Benutzer reaktiviert.' : 'Benutzer deaktiviert.', 'ok');
        } catch (e) {
          toast('Verbindung fehlgeschlagen.', 'error');
        }
      }

      async function adminDeleteUserConfirm(userId) {
        const target = _adminUsers.find((u) => u.id === userId);
        const name = target ? target.username : 'Benutzer';
        const ok = await confirmAction({
          title: `${name} löschen?`,
          message:
            `Alle Buchungen, Kategorien und Tags von ${name} werden ebenfalls gelöscht. ` +
            'Diese Aktion lässt sich nicht rückgängig machen.',
          confirmLabel: 'Endgültig löschen',
          destructive: true,
        });
        if (!ok) return;
        try {
          const res = await authFetch('DELETE', `/admin/users/${userId}`);
          if (!res.ok) {
            toast('Löschen fehlgeschlagen.', 'error');
            return;
          }
          await loadAdminUsers();
          toast('Benutzer gelöscht.', 'ok');
        } catch (e) {
          toast('Verbindung fehlgeschlagen.', 'error');
        }
      }

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
            'POST', '/auth/login',
            { username, password, remember_me: remember },
            { csrf: false, reloadOn401: false }
          );
          if (res.status === 429) {
            const data = await res.json().catch(() => ({}));
            const secs = data.retry_after || 1;
            _setAuthError('loginError',
              `Zu viele Versuche. Warte ${secs} Sekunden und versuche es erneut.`);
            return;
          }
          if (!res.ok) {
            _setAuthError('loginError', 'Benutzername oder Passwort stimmt nicht.');
            return;
          }
          const data = await res.json();
          window._csrfToken = data.user.csrf_token;
          _broadcastCsrfToSw(window._csrfToken);
          await _afterAuthSuccess(data.user);
        } catch (e) {
          _setAuthError('loginError', 'Verbindung zum Server fehlgeschlagen.');
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
          _setAuthError('setupError', 'Die Passwörter stimmen nicht überein.');
          return;
        }
        const pwErr = validateNewPassword(password);
        if (pwErr) {
          _setAuthError('setupError', pwErr);
          return;
        }
        try {
          const res = await authFetch('POST', '/auth/setup',
            { username, password }, { csrf: false, reloadOn401: false });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            const detail = data.detail || '';
            if (detail === 'setup_already_done') {
              _setAuthError('setupError',
                'Die Ersteinrichtung ist bereits abgeschlossen. Bitte neu laden.');
            } else {
              _setAuthError('setupError',
                'Einrichtung fehlgeschlagen. Eingaben prüfen und erneut versuchen.');
            }
            return;
          }
          location.reload();
        } catch (e) {
          _setAuthError('setupError', 'Verbindung zum Server fehlgeschlagen.');
        }
      }

      async function submitForcePassword() {
        _setAuthError('forcePwError', '');
        const next = document.getElementById('forcePwNew').value;
        const confirm = document.getElementById('forcePwConfirm').value;
        if (next !== confirm) {
          _setAuthError('forcePwError', 'Die neuen Passwörter stimmen nicht überein.');
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
          const res = await authFetch('POST', '/auth/change-password',
            { current_password: null, new_password: next },
            { reloadOn401: false });
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
            _setAuthError('forcePwError', 'Passwortwechsel fehlgeschlagen.');
            return;
          }
          location.reload();
        } catch (e) {
          _setAuthError('forcePwError', 'Verbindung zum Server fehlgeschlagen.');
        }
      }

      async function _afterAuthSuccess(me) {
        _currentMe = me;
        document.body.classList.toggle('is-admin', !!me.is_admin);
        const usernameLabel = document.getElementById('accountUsername');
        if (usernameLabel) usernameLabel.textContent = `Angemeldet als ${me.username}`;
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
        await loadAndRender();
        showPanel(loadDefaultView());
        updateSyncBadge();
        reconcileSettingsFromServer();
      }

      // ── INIT ──────────────────────────────────────────────────────────────────────
      async function init() {
        applyTheme(loadTheme());
        syncThemeRadios();
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
        try {
          const res = await fetch(API + '/auth/setup-status', {
            credentials: 'same-origin',
          });
          if (res.ok) {
            const data = await res.json();
            needsSetup = !!data.needs_setup;
            suggested = data.suggested_username || null;
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
            if (intro) intro.textContent =
              `Vergib ein Passwort für das vorhandene Admin-Konto „${suggested}".`;
          }
          _showAuthView('setup');
          setTimeout(() => {
            const focusEl = document.getElementById(
              suggested ? 'setupPassword' : 'setupUsername'
            );
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
