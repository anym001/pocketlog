// PocketLog i18n runtime.
//
// Loaded as a classic <script> before app.js so the global `t()` and the
// `window.I18N` helpers exist for every app function. Translations live in
// static JSON bundles under /i18n/<bundle>.json — shipped with the app and
// precached by the Service Worker, so language switching works offline and
// needs no API round-trip.
//
// Locale vs. bundle:
//   - The stored preference is a full BCP-47 LOCALE (de-DE, de-AT, en-GB,
//     en-US, …). The full tag drives the number/date LOCALE via Intl.
//   - The translation BUNDLE is the primary subtag (de-AT → de): one en.json
//     serves every English locale; only formatting differs (en-GB vs en-US).
//   - Currency is a separate ISO 4217 code; display-only, never converted.
// Static markup carries data-i18n / data-i18n-attr; dynamic strings go
// through t(). A re-render after a locale change re-resolves both.
(function () {
  'use strict';

  // Curated locales offered in the picker. Keep in sync with the backend
  // SUPPORTED_LOCALES and the <option> list in index.html.
  const SUPPORTED_LOCALES = ['de-DE', 'de-AT', 'de-CH', 'en-GB', 'en-US'];
  const BUNDLES = ['de', 'en']; // translation files that actually ship
  const DEFAULT_LOCALE = 'de-DE';
  const DEFAULT_CURRENCY = 'EUR';
  const LOCALE_KEY = 'pocketlog.locale';
  const LEGACY_LANG_KEY = 'pocketlog.lang'; // pre-locale builds stored 'de'/'en'
  const CURRENCY_KEY = 'pocketlog.currency';

  let _locale = DEFAULT_LOCALE;
  let _currency = DEFAULT_CURRENCY;
  let _dict = {};
  const _cache = Object.create(null); // bundle -> flat dict

  // Translation bundle for a locale (primary subtag, fallback to first bundle).
  function bundleFor(locale) {
    const sub = String(locale || '')
      .split('-')[0]
      .toLowerCase();
    return BUNDLES.indexOf(sub) !== -1 ? sub : BUNDLES[0];
  }

  // Coerce any input to a supported locale: exact match wins; otherwise map
  // by primary subtag to the first supported variant (en → en-GB); else the
  // default. Also case-normalises (de_at → de-AT).
  function normaliseLocale(loc) {
    if (!loc) return DEFAULT_LOCALE;
    const parts = String(loc).replace('_', '-').split('-');
    const lang = (parts[0] || '').toLowerCase();
    const region = (parts[1] || '').toUpperCase();
    const full = region ? lang + '-' + region : lang;
    if (SUPPORTED_LOCALES.indexOf(full) !== -1) return full;
    for (let i = 0; i < SUPPORTED_LOCALES.length; i++) {
      if (SUPPORTED_LOCALES[i].split('-')[0] === lang) return SUPPORTED_LOCALES[i];
    }
    return DEFAULT_LOCALE;
  }

  // Nested catalogue → flat dotted keys, so the JSON can be grouped by area
  // ({"auth": {"login": "Anmelden"}}) while lookups stay O(1) on "auth.login".
  function _flatten(obj, prefix, out) {
    for (const k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      const val = obj[k];
      const key = prefix ? prefix + '.' + k : k;
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        _flatten(val, key, out);
      } else {
        out[key] = val;
      }
    }
    return out;
  }

  async function loadDict(bundle) {
    bundle = BUNDLES.indexOf(bundle) !== -1 ? bundle : BUNDLES[0];
    if (_cache[bundle]) return _cache[bundle];
    try {
      const res = await fetch('/i18n/' + bundle + '.json', { credentials: 'same-origin' });
      if (!res.ok) throw new Error('i18n ' + bundle + ' → ' + res.status);
      _cache[bundle] = _flatten(await res.json(), '', Object.create(null));
    } catch (e) {
      console.warn('i18n: failed to load', bundle, e);
      _cache[bundle] = _cache[bundle] || Object.create(null);
    }
    return _cache[bundle];
  }

  // Translate. Unknown keys return the key itself (visible, greppable),
  // never throw. {placeholder} tokens are filled from params.
  function t(key, params) {
    let s = _dict[key];
    if (s == null) s = key;
    if (params) {
      s = String(s).replace(/\{(\w+)\}/g, function (m, name) {
        return params[name] != null ? params[name] : m;
      });
    }
    return s;
  }

  function getLocale() {
    return _locale;
  }
  function getBundle() {
    return bundleFor(_locale);
  }
  function getCurrency() {
    return _currency;
  }

  // Walk the DOM and translate static nodes. data-i18n sets textContent;
  // data-i18n-attr sets one or more attributes, format
  // "placeholder:key.path;aria-label:other.key".
  function applyStatic(root) {
    root = root || document;
    const nodes = root.querySelectorAll('[data-i18n]');
    for (let i = 0; i < nodes.length; i++) {
      nodes[i].textContent = t(nodes[i].getAttribute('data-i18n'));
    }
    const attrNodes = root.querySelectorAll('[data-i18n-attr]');
    for (let i = 0; i < attrNodes.length; i++) {
      const spec = attrNodes[i].getAttribute('data-i18n-attr');
      const pairs = spec.split(';');
      for (let j = 0; j < pairs.length; j++) {
        const idx = pairs[j].indexOf(':');
        if (idx === -1) continue;
        const attr = pairs[j].slice(0, idx).trim();
        const key = pairs[j].slice(idx + 1).trim();
        if (attr && key) attrNodes[i].setAttribute(attr, t(key));
      }
    }
    document.documentElement.setAttribute('lang', bundleFor(_locale));
  }

  // Switch locale: load the bundle, persist, re-translate static markup, and
  // notify the app (app.js listens on 'i18n:changed' to re-render dynamic
  // views and rebuild month names). Returns a promise the caller can await.
  async function setLocale(locale, opts) {
    opts = opts || {};
    _locale = normaliseLocale(locale);
    if (opts.persist !== false) {
      try {
        localStorage.setItem(LOCALE_KEY, _locale);
      } catch (e) {}
    }
    _dict = await loadDict(bundleFor(_locale));
    applyStatic(document);
    if (opts.silent !== true) {
      document.dispatchEvent(
        new CustomEvent('i18n:changed', { detail: { locale: _locale, currency: _currency } }),
      );
    }
    return _locale;
  }

  function setCurrency(cur, opts) {
    opts = opts || {};
    _currency = (cur || DEFAULT_CURRENCY).toUpperCase();
    if (opts.persist !== false) {
      try {
        localStorage.setItem(CURRENCY_KEY, _currency);
      } catch (e) {}
    }
    if (opts.silent !== true) {
      document.dispatchEvent(
        new CustomEvent('i18n:changed', { detail: { locale: _locale, currency: _currency } }),
      );
    }
  }

  // The decimal separator of the active locale ("," for de-*, "." for en-*).
  function decimalSeparator() {
    try {
      const parts = new Intl.NumberFormat(_locale).formatToParts(1.1);
      const dec = parts.find(function (p) {
        return p.type === 'decimal';
      });
      return dec ? dec.value : '.';
    } catch (e) {
      return '.';
    }
  }

  // The currency symbol of the active locale+currency ("€", "$", "CHF" …).
  function currencySymbol() {
    try {
      const parts = new Intl.NumberFormat(_locale, {
        style: 'currency',
        currency: _currency,
      }).formatToParts(0);
      const cur = parts.find(function (p) {
        return p.type === 'currency';
      });
      return cur ? cur.value : _currency;
    } catch (e) {
      return _currency;
    }
  }

  // Synchronous bootstrap from localStorage (the JSON bundle still loads
  // async via setLocale()). Order: stored locale → legacy 'de'/'en' key →
  // browser language → default. So a fresh install opens in the user's
  // locale when supported.
  (function bootstrap() {
    try {
      const stored = localStorage.getItem(LOCALE_KEY);
      if (stored) {
        _locale = normaliseLocale(stored);
      } else {
        const legacy = localStorage.getItem(LEGACY_LANG_KEY);
        _locale = normaliseLocale(legacy || navigator.language || '');
      }
      const storedCur = localStorage.getItem(CURRENCY_KEY);
      if (storedCur) _currency = storedCur.toUpperCase();
    } catch (e) {}
    document.documentElement.setAttribute('lang', bundleFor(_locale));
  })();

  window.I18N = {
    SUPPORTED_LOCALES: SUPPORTED_LOCALES,
    BUNDLES: BUNDLES,
    DEFAULT_LOCALE: DEFAULT_LOCALE,
    DEFAULT_CURRENCY: DEFAULT_CURRENCY,
    t: t,
    getLocale: getLocale,
    getBundle: getBundle,
    getCurrency: getCurrency,
    setLocale: setLocale,
    setCurrency: setCurrency,
    applyStatic: applyStatic,
    loadDict: loadDict,
    normaliseLocale: normaliseLocale,
    bundleFor: bundleFor,
    decimalSeparator: decimalSeparator,
    currencySymbol: currencySymbol,
  };
  // Convenience global — app.js calls t() heavily (via its own `tr` alias).
  window.t = t;
  // Kicks off the initial bundle load; app.js awaits this before first render.
  window.I18N.ready = setLocale(_locale, { persist: false, silent: true });
})();
