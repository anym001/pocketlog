// ESLint flat config — scoped to the frontend's app source (classic scripts
// served as-is, CSP `script-src 'self'`). The goal is a conservative bug net,
// not a style enforcer: Prettier owns formatting.
//
// Only frontend/*.js is linted (app.js, db.js, i18n.js, sw.js, utils.js). The
// Playwright (e2e) and Vitest (unit) tooling lives in its own packages and is
// left to its own conventions.
const js = require('@eslint/js');

module.exports = [
  {
    files: ['frontend/*.js'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2022,
      // These files are loaded as classic <script>s, not ES modules.
      sourceType: 'script',
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-undef': 'off',
      // no-unused-vars is unreliable here: the app wires top-level functions
      // (openDrawer, saveTheme, submitLogin, …) to inline `onclick="…"`
      // handlers in index.html, which ESLint never sees, so they all look
      // unused. Off to avoid ~80 false positives; the structural rules below
      // (no-dupe-keys, no-unreachable, no-redeclare, …) are the real net.
      'no-unused-vars': 'off',
      // The app legitimately swallows a few best-effort operations
      // (e.g. `try { localStorage... } catch (e) {}`).
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
];
