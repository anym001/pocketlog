// Early boot decisions that must land before first paint. Loaded as a
// BLOCKING script in <head> (no defer — a deferred run would flash the
// wrong theme/sidebar state for one frame). Lived inline in index.html
// until the CSP dropped script-src 'unsafe-inline'; the file is tiny, so
// the extra request costs less than keeping the CSP escape hatch open.

// Single early decision for the active theme. Sets two attributes:
//   data-theme  — the user's preference: 'dark' | 'light' | (none = system)
//   data-dark   — the effective, resolved value used for CSS theming
// CSS only reads data-dark, so light tokens live in :root and dark tokens
// live in one html[data-dark='true'] block.
(function () {
  var html = document.documentElement;
  var manual = null;
  try {
    manual = localStorage.getItem('pocketlog.theme');
  } catch (e) {}
  if (manual === 'dark' || manual === 'light') {
    html.setAttribute('data-theme', manual);
  }
  var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  var isDark = manual === 'dark' || (manual !== 'light' && prefersDark);
  html.setAttribute('data-dark', isDark ? 'true' : 'false');
})();

// Restore the sidebar-collapsed state before first paint so the
// tablet sidebar doesn't animate in on every page load. The class
// sits on <html> because <body> doesn't exist yet at head-parse
// time; CSS targets html.sidebar-collapsed for the same reason.
(function () {
  try {
    if (localStorage.getItem('pocketlog.sidebarCollapsed') === '1') {
      document.documentElement.classList.add('sidebar-collapsed');
    }
  } catch (e) {}
})();
