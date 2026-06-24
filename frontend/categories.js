// Category management plus the tag picker and icon picker modals.
// Classic script — see index.html for load order.

// ── CATEGORIES ────────────────────────────────────────────────────────────────
const CAT_CREATE_COLORS = ['#D97757', '#6b7aa1', '#788C5D', '#c47ab0', '#e0a44a', '#87867F'];

async function loadCategories() {
  try {
    appState.ledger.categories = await api('GET', '/categories');
  } catch (e) {
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
      tagCounts.set(t.name.toLowerCase(), Number(t.count) || 0);
    }
  } catch (e) {
    appState.ledger.availableTags = [];
    tagCounts.clear();
  }
  renderTagList();
}

function renderTagSuggestions() {
  const box = document.getElementById('tagSuggestions');
  if (!box) return;
  const selected = new Set(appState.form.tags.map((x) => x.toLowerCase()));
  const remaining = appState.ledger.availableTags.filter((t) => !selected.has(t.toLowerCase()));
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
        `<button type="button" class="tag-suggestion" data-add-tag="${_escAttr(t)}">+ ${_escText(t)}</button>`,
    )
    .join('');
  box.querySelectorAll('[data-add-tag]').forEach((el) => {
    el.addEventListener('click', () => addTagFromSuggestion(el.dataset.addTag));
  });
}

function addTagFromSuggestion(t) {
  if (!t) return;
  const key = t.toLowerCase();
  if (!appState.form.tags.some((x) => x.toLowerCase() === key)) appState.form.tags.push(t);
  renderTagPills();
  renderTagSuggestions();
}

// ── TAG PICKER MODAL ──────────────────────────────────────────────────────────
// Tag-picker staging state lives in appState.tagPicker (state.js):
//   selection     — staged tags; apply to appState.form.tags only on „Fertig"
//   context       — which modal opened the picker: 'transaction' | 'recurring'
//   recurringTags — tags staged in the recurring rule editor

function renderRecurringTagPills() {
  const wrap = document.getElementById('recTagsWrap');
  const btn = document.getElementById('recTagPickerBtn');
  if (!wrap || !btn) return;
  wrap.innerHTML = appState.tagPicker.recurringTags
    .map(
      (t) =>
        `<span class="tag-pill">${_escText(t)}<button type="button" data-remove-rec-tag="${_escAttr(t)}" aria-label="${_escAttr(tr('tags.removeAria', { name: t }))}">${ICON_SVG.close}</button></span>`,
    )
    .join('');
  wrap.querySelectorAll('[data-remove-rec-tag]').forEach((el) => {
    el.addEventListener('click', () => removeRecurringTag(el.dataset.removeRecTag));
  });
  wrap.appendChild(btn);
}
function removeRecurringTag(t) {
  appState.tagPicker.recurringTags = appState.tagPicker.recurringTags.filter((x) => x !== t);
  renderRecurringTagPills();
}

function openTagPicker() {
  openTagPickerFor('transaction');
}
function openTagPickerFor(context) {
  appState.tagPicker.context = context;
  rememberModalFocus('tagPicker');
  // bulkAdd / bulkRemove start from an empty selection (the picked tags are the
  // ones to add / remove); the form contexts seed their current tags.
  appState.tagPicker.selection =
    context === 'recurring'
      ? [...appState.tagPicker.recurringTags]
      : context === 'transaction'
        ? [...appState.form.tags]
        : [];
  // Creating a new tag only makes sense when adding; the remove picker offers
  // only tags already present on the selection.
  const isRemove = context === 'bulkRemove';
  const newGroup = document.getElementById('tagPickerNewGroup');
  if (newGroup) newGroup.style.display = isRemove ? 'none' : '';
  const title = document.getElementById('tagPickerTitle');
  if (title)
    title.textContent =
      context === 'bulkAdd'
        ? tr('selection.addTagTitle')
        : isRemove
          ? tr('selection.removeTagTitle')
          : tr('tags.pickTitle');
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
  // Keep scroll-lock if either parent modal is still open.
  const bookingOpen = document.getElementById('modalOverlay').classList.contains('open');
  const recurringOpen = document.getElementById('recurringModalOverlay').classList.contains('open');
  if (!bookingOpen && !recurringOpen) {
    document.body.style.overflow = '';
  }
  appState.tagPicker.selection = [];
  releaseFocusTrap('tagPicker');
  restoreModalFocus('tagPicker');
}
function closeTagPickerOutside(e) {
  if (e.target === document.getElementById('tagPickerOverlay')) closeTagPicker();
}
function commitTagPicker() {
  const ctx = appState.tagPicker.context;
  if (ctx === 'bulkAdd' || ctx === 'bulkRemove') {
    const tags = [...appState.tagPicker.selection];
    closeTagPicker();
    if (!tags.length) return;
    bulkApply({ action: ctx === 'bulkAdd' ? 'add_tags' : 'remove_tags', tags });
    return;
  }
  if (appState.tagPicker.context === 'recurring') {
    appState.tagPicker.recurringTags = [...appState.tagPicker.selection];
    closeTagPicker();
    renderRecurringTagPills();
  } else {
    appState.form.tags = [...appState.tagPicker.selection];
    closeTagPicker();
    renderTagPills();
    renderTagSuggestions();
  }
}
function renderTagPickerChips() {
  const box = document.getElementById('tagPickerChips');
  if (!box) return;
  const q = (document.getElementById('tagPickerFilter').value || '').trim().toLowerCase();
  // The remove picker is scoped to the tags actually on the selected rows.
  const source =
    appState.tagPicker.context === 'bulkRemove'
      ? appState.tagPicker.bulkRemovePool
      : appState.ledger.availableTags;
  const filtered = q ? source.filter((t) => t.toLowerCase().includes(q)) : source;
  const selected = new Set(appState.tagPicker.selection.map((x) => x.toLowerCase()));
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
  const i = appState.tagPicker.selection.findIndex((x) => x.toLowerCase() === t.toLowerCase());
  if (i >= 0) appState.tagPicker.selection.splice(i, 1);
  else appState.tagPicker.selection.push(t);
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
  const existing = appState.ledger.availableTags.find((t) => t.toLowerCase() === key);
  const name = existing || val;
  if (!existing) {
    appState.ledger.availableTags.push(name);
    appState.ledger.availableTags.sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' }),
    );
  }
  if (!appState.tagPicker.selection.some((x) => x.toLowerCase() === key)) {
    appState.tagPicker.selection.push(name);
  }
  inp.value = '';
  renderTagPickerChips();
}

function renderCategories() {
  const box = document.getElementById('catList');
  if (!box) return;
  if (!appState.ledger.categories.length) {
    box.innerHTML = `<p class="empty-state-hint">${tr('categories.none')}</p>`;
    return;
  }
  const sorted = [...appState.ledger.categories].sort((a, b) =>
    a.name.localeCompare(b.name, _locale(), { sensitivity: 'base' }),
  );
  box.innerHTML = '';
  sorted.forEach((c) => {
    const row = document.createElement('div');
    row.className = 'drawer-nav-item cat-pill-edit';
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    row.setAttribute('aria-label', tr('categories.editAria', { name: c.name }));
    row.onclick = () => openCatModal(c.id);
    row.onkeydown = (e) => handleRowActivate(e, () => openCatModal(c.id));
    const iconWrap = document.createElement('div');
    iconWrap.className = 'drawer-nav-icon-wrap';
    iconWrap.style.setProperty('--nav-icon-bg', c.color);
    iconWrap.innerHTML = catIconSvg(c.icon);
    const label = document.createElement('span');
    label.className = 'drawer-nav-label';
    label.textContent = c.name;
    row.appendChild(iconWrap);
    row.appendChild(label);
    box.appendChild(row);
  });
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

// Category create/edit modal draft lives in appState.catEdit (state.js);
// seed the icon default from CAT_ICON_FALLBACK (defined above).
appState.catEdit.icon = CAT_ICON_FALLBACK;

function openCatModal(id) {
  rememberModalFocus('cat');
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
    document.getElementById('catEditName').value = '';
    title.textContent = tr('categories.newTitle');
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
        return `<button type="button" class="color-swatch${isActive ? ' active' : ''}" style="background:${p.hex}" aria-label="${_escAttr(tr('categories.pickColorAria', { name: p.name }))}" aria-pressed="${isActive}" onclick="${pickFnName}('${p.hex}')"></button>`;
      })
      .join('') +
    `<label class="color-swatch-custom" title="${_escAttr(tr('categories.customColorName'))}">
     <input type="color" value="${currentColor}" onchange="${pickFnName}(this.value)" aria-label="${_escAttr(tr('categories.customColor'))}">
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

function closeCatModal() {
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
              onclick="pickIcon('${id}')">${catIconSvg(id)}</button>`;
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
  try {
    if (appState.catEdit.id) {
      await api('PUT', `/categories/${appState.catEdit.id}`, {
        name,
        icon,
        color: appState.catEdit.color,
      });
    } else {
      await api('POST', '/categories', { name, icon, color: appState.catEdit.color });
    }
    closeCatModal();
    await loadCategories();
    renderCategories();
    await loadAndRender();
  } catch (e) {
    if (e.message && e.message.includes('409')) {
      toast(tr('categories.exists'), 'error');
    } else {
      toast(tr('tx.saveFailed') + e.message, 'error');
    }
  }
}

async function deleteCategoryEdit() {
  if (!appState.catEdit.id) return;
  const ok = await confirmAction({
    title: tr('categories.deleteConfirm'),
    confirmLabel: tr('common.delete'),
  });
  if (!ok) return;
  try {
    await api('DELETE', `/categories/${appState.catEdit.id}`);
    closeCatModal();
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
