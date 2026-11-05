// Setup wizard plan, B: src/detect-ui.mjs decides the default of "Does this repo have a UI?" from the files at
// hand (a framework dependency in the root package.json, or a UI file within 4 folder levels). Node 18+.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { detectUi } from '../src/detect-ui.mjs';
import { removeDir, tmpDir } from './helpers.mjs';

const dirs = [];
after(() => dirs.forEach(removeDir));

function repo(files = {}) {
  const dir = tmpDir();
  dirs.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

const pkg = (deps) => ({ 'package.json': JSON.stringify(deps) });

describe('package.json', () => {
  const FRAMEWORKS = ['react', 'vue', 'svelte', '@angular/core', 'next', 'nuxt', 'solid-js', 'preact', 'astro', '@remix-run/react'];

  test('each framework, in dependencies or devDependencies, means a UI', () => {
    for (const f of FRAMEWORKS) {
      for (const key of ['dependencies', 'devDependencies']) {
        const r = detectUi(repo(pkg({ [key]: { [f]: '^1.0.0' } })));
        assert.deepEqual(r, { ui: true, source: `${f} in package.json` }, `${f} in ${key}`);
      }
    }
  });

  test('other dependencies, scripts or peerDependencies alone are not a UI', () => {
    for (const p of [
      { dependencies: { express: '^4.0.0', 'react-is': '^18.0.0' } },
      { peerDependencies: { react: '^18.0.0' } },
      { scripts: { start: 'react-scripts start' } },
      { dependencies: ['react'] },
      { dependencies: null },
      {},
    ]) {
      assert.deepEqual(detectUi(repo(pkg(p))), { ui: false, source: null }, JSON.stringify(p));
    }
  });

  test('a broken package.json is skipped quietly; the file scan still runs', () => {
    assert.deepEqual(detectUi(repo({ 'package.json': '{ "dependencies": { "react": ' })), { ui: false, source: null });
    assert.deepEqual(detectUi(repo({ 'package.json': 'null' })), { ui: false, source: null });
    assert.deepEqual(detectUi(repo({ 'package.json': '{ nope', 'app/index.html': '<p>\n' })), { ui: true, source: 'app/index.html' });
  });

  test('only the root package.json counts', () => {
    const r = detectUi(repo({ 'tools/package.json': JSON.stringify({ dependencies: { react: '^18.0.0' } }) }));
    assert.deepEqual(r, { ui: false, source: null });
  });
});

describe('UI files', () => {
  test('each UI extension (any case) counts; other files do not', () => {
    for (const ext of ['.html', '.jsx', '.tsx', '.vue', '.svelte', '.HTML']) {
      assert.equal(detectUi(repo({ [`src/view${ext}`]: 'x' })).ui, true, ext);
    }
    assert.deepEqual(detectUi(repo({ 'src/a.js': 'x', 'src/b.ts': 'x', 'README.md': 'x', 'src/style.css': 'x' })), { ui: false, source: null });
  });

  test('a file at depth 4 is found; one at depth 5 is not (the root is depth 0)', () => {
    assert.deepEqual(detectUi(repo({ 'index.html': 'x' })), { ui: true, source: 'index.html' });
    assert.deepEqual(detectUi(repo({ 'a/b/c/d/page.tsx': 'x' })), { ui: true, source: 'a/b/c/d/page.tsx' });
    assert.deepEqual(detectUi(repo({ 'a/b/c/d/e/page.tsx': 'x' })), { ui: false, source: null });
  });

  test('node_modules, .git, dist, build and vendor are never scanned', () => {
    for (const d of ['node_modules', '.git', 'dist', 'build', 'vendor']) {
      assert.deepEqual(detectUi(repo({ [`${d}/index.html`]: 'x' })), { ui: false, source: null }, d);
      assert.deepEqual(detectUi(repo({ [`src/${d}/index.html`]: 'x' })), { ui: false, source: null }, `src/${d}`);
    }
    // A folder that merely starts with one of those names is scanned.
    assert.equal(detectUi(repo({ 'builders/index.html': 'x' })).ui, true);
  });

  test('the scan stops after 5 000 entries', () => {
    // Breadth first: the root's a/ and z/, then a/'s files, then z/index.html. With 4 997 files under a/ the
    // UI file is entry 5 000 and is found; with one more it is entry 5 001 and is not looked at.
    const files = {};
    for (let i = 0; i < 4997; i++) files[`a/f${String(i).padStart(4, '0')}.txt`] = '';
    files['z/index.html'] = 'x';
    assert.deepEqual(detectUi(repo(files)), { ui: true, source: 'z/index.html' });
    files['a/f4997.txt'] = '';
    assert.deepEqual(detectUi(repo(files)), { ui: false, source: null });
  });

  test('a framework dependency is reported before a UI file', () => {
    const r = detectUi(repo({ ...pkg({ devDependencies: { vue: '^3.0.0' } }), 'index.html': 'x' }));
    assert.deepEqual(r, { ui: true, source: 'vue in package.json' });
  });
});
