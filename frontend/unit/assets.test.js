// Versioned app assets: index.html requests every app script and the
// stylesheet as <path>?v=__APP_VERSION__, and the service worker precaches
// exactly those URLs (v('<path>') in sw.js). If one file slipped through
// unversioned, a fresh page could again boot against an older cached copy
// of it after an update — the half-updated state that once needed a
// visible reload to repair. These checks pin the pairing.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const sw = readFileSync(join(root, 'sw.js'), 'utf8');

const scriptSrcs = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
const styleHrefs = [...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map(
  (m) => m[1],
);
const appAssets = [...scriptSrcs, ...styleHrefs];

describe('versioned app assets', () => {
  it('finds the app scripts and the stylesheet', () => {
    expect(appAssets.length).toBeGreaterThan(15);
  });

  it('requests every script and stylesheet with ?v=__APP_VERSION__', () => {
    const unversioned = appAssets.filter((u) => !u.endsWith('?v=__APP_VERSION__'));
    expect(unversioned).toEqual([]);
  });

  it('declares the version the Dockerfile bakes in', () => {
    expect(html).toMatch(/<meta name="app-version" content="__APP_VERSION__"/);
  });

  it('precaches every one of them under the same versioned URL', () => {
    const missing = appAssets
      .map((u) => u.replace('?v=__APP_VERSION__', ''))
      .filter((path) => !sw.includes(`v('${path}')`));
    expect(missing).toEqual([]);
  });
});
