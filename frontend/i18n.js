// PocketLog i18n runtime.
//
// Loaded as a classic <script> before app.js so the global `t()` and the
// `window.I18N` helpers exist for every app function. Translations live in
// static JSON bundles under /i18n/<lang>.json — shipped with the app and
// precached by the Service Worker, so language switching works offline and
// needs no API round-trip.
//
// Design:
//   - The active language drives BOTH the UI strings and the number/date
//     LOCALE (de → de-DE, en → en-US). Currency is a separate ISO 4217
//     code; Intl.NumberFormat resolves symbol + position from the locale.
//   - Currency is display-only: amounts are never converted, only rendered.
//   - Static markup carries data-i18n / data-i18n-attr; dynamic strings go
//     through t(). A re-render after a language change re-resolves both.
(function () {
  'use strict';

  const SUPPORTED = ['de', 'en'];
  const DEFAULT_LANG = 'de';
  const DEFAULT_CURRENCY = 'EUR';
  const LANG_KEY = 'pocketlog.lang';
  const CURRENCY_KEY = 'pocketlog.currency';
  // BCP-47 locale used for Intl formatting per UI language. Kept here so a
  // new language only needs an entry plus its JSON bundle.
  const LOCALES = { de: 'de-DE', en: 'en-US' };

  let _lang = DEFAULT_LANG;
  let _currency = DEFAULT_CURRENCY;
  let _dict = {};
  const _cache = Object.create(null); // lang -> flat dict

  function normaliseLang(l) {
    return SUPPORTED.indexOf(l) !== -1 ? l : DEFAULT_LANG;
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

  async function loadDict(lang) {
    lang = normaliseLang(lang);
    if (_cache[lang]) return _cache[lang];
    try {
      const res = await fetch('/i18n/' + lang + '.json', { credentials: 'same-origin' });
      if (!res.ok) throw new Error('i18n ' + lang + ' → ' + res.status);
      _cache[lang] = _flatten(await res.json(), '', Object.create(null));
    } catch (e) {
      // Offline before the bundle was ever cached, or a fetch error: fall
      // back to whatever is loaded (possibly the empty dict, in which case
      // t() returns the key — better than throwing during render).
      console.warn('i18n: failed to load', lang, e);
      _cache[lang] = _cache[lang] || Object.create(null);
    }
    return _cache[lang];
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

  function getLang() {
    return _lang;
  }
  function getLocale() {
    return LOCALES[_lang] || LOCALES[DEFAULT_LANG];
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
    document.documentElement.setAttribute('lang', _lang);
  }

  // Switch language: load bundle, persist, re-translate static markup, and
  // notify the app (app.js listens on 'i18n:changed' to re-render dynamic
  // views and rebuild month names). Returns a promise the caller can await.
  async function setLanguage(lang, opts) {
    opts = opts || {};
    _lang = normaliseLang(lang);
    if (opts.persist !== false) {
      try {
        localStorage.setItem(LANG_KEY, _lang);
      } catch (e) {}
    }
    _dict = await loadDict(_lang);
    applyStatic(document);
    if (opts.silent !== true) {
      document.dispatchEvent(
        new CustomEvent('i18n:changed', { detail: { lang: _lang, currency: _currency } })
      );
    }
    return _lang;
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
        new CustomEvent('i18n:changed', { detail: { lang: _lang, currency: _currency } })
      );
    }
  }

  // The decimal separator of the active locale ("," for de, "." for en).
  function decimalSeparator() {
    try {
      const parts = new Intl.NumberFormat(getLocale()).formatToParts(1.1);
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
      const parts = new Intl.NumberFormat(getLocale(), {
        style: 'currency',
        currency: getCurrency(),
      }).formatToParts(0);
      const cur = parts.find(function (p) {
        return p.type === 'currency';
      });
      return cur ? cur.value : getCurrency();
    } catch (e) {
      return getCurrency();
    }
  }

  // Synchronous bootstrap from localStorage (the JSON bundle still loads
  // async via setLanguage()). Falls back to the browser language on first
  // run so a fresh install opens in the user's language when supported.
  (function bootstrap() {
    try {
      const storedLang = localStorage.getItem(LANG_KEY);
      if (storedLang) {
        _lang = normaliseLang(storedLang);
      } else {
        const nav = (navigator.language || '').slice(0, 2).toLowerCase();
        _lang = normaliseLang(nav);
      }
      const storedCur = localStorage.getItem(CURRENCY_KEY);
      if (storedCur) _currency = storedCur.toUpperCase();
    } catch (e) {}
    document.documentElement.setAttribute('lang', _lang);
  })();

  window.I18N = {
    SUPPORTED: SUPPORTED,
    DEFAULT_LANG: DEFAULT_LANG,
    DEFAULT_CURRENCY: DEFAULT_CURRENCY,
    LOCALES: LOCALES,
    t: t,
    getLang: getLang,
    getLocale: getLocale,
    getCurrency: getCurrency,
    setLanguage: setLanguage,
    setCurrency: setCurrency,
    applyStatic: applyStatic,
    loadDict: loadDict,
    normaliseLang: normaliseLang,
    decimalSeparator: decimalSeparator,
    currencySymbol: currencySymbol,
  };
  // Convenience global — app.js calls t() heavily.
  window.t = t;
  // Kicks off the initial bundle load; app.js awaits this before first render.
  window.I18N.ready = setLanguage(_lang, { persist: false, silent: true });
})();
