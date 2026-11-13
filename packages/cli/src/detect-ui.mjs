// Detects whether a repo has a user interface, from the files at hand. Reads files only: it never runs a project
// script or a package manager. Node 18+, no dependencies.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const FRAMEWORKS = ['react', 'vue', 'svelte', '@angular/core', 'next', 'nuxt', 'solid-js', 'preact', 'astro', '@remix-run/react'];
// File-name endings that mean a UI: web pages and components, server-side templates (Rails, Laravel, Phoenix,
// ASP.NET, Twig, Jinja) and iOS view files.
const UI_EXT = [
  '.html', '.jsx', '.tsx', '.vue', '.svelte', '.astro', '.html.erb', '.html.haml', '.html.slim', '.blade.php', '.heex', '.cshtml',
  '.razor', '.twig', '.jinja', '.jinja2', '.storyboard', '.xib',
];
// Dependency, build-output, coverage and cache folders: their HTML (cargo doc, htmlcov, lcov-report) is not the repo's UI.
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'vendor', 'target', 'out', 'coverage', 'htmlcov', '.nyc_output', '.venv', 'venv',
  '__pycache__', '.tox', '.nox', '.mypy_cache', '.pytest_cache', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '_build',
  'storybook-static', 'playwright-report', 'test-results', 'site-packages', 'Pods', 'DerivedData', '.gradle', 'bin', 'obj',
]);
const MAX_DEPTH = 4; // folders below the root (a file in the root is at depth 0)
const MAX_ENTRIES = 5000;

function fromPackageJson(root) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch {
    return null; // missing or unparsable: skip this check, quietly
  }
  if (!pkg || typeof pkg !== 'object') return null;
  for (const key of ['dependencies', 'devDependencies']) {
    const deps = pkg[key];
    if (!deps || typeof deps !== 'object' || Array.isArray(deps)) continue;
    const hit = FRAMEWORKS.find((f) => Object.prototype.hasOwnProperty.call(deps, f));
    if (hit) return `${hit} in package.json`;
  }
  return null;
}

const isUiFile = (name) => UI_EXT.some((ext) => name.toLowerCase().endsWith(ext));

// Flutter: pubspec.yaml that depends on the flutter SDK.
function fromPubspec(root) {
  try {
    return /^\s+flutter:\s*\n\s+sdk:\s*flutter/m.test(readFileSync(path.join(root, 'pubspec.yaml'), 'utf8')) ? 'flutter in pubspec.yaml' : null;
  } catch {
    return null;
  }
}

// Breadth first, so the entry cap treats every folder fairly. Returns the first UI file's relative path, or null.
function fromFiles(root) {
  let level = [{ dir: root, depth: 0 }];
  let seen = 0;
  while (level.length) {
    const next = [];
    for (const { dir, depth } of level) {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const e of entries) {
        if (++seen > MAX_ENTRIES) return null;
        if (e.isDirectory()) {
          if (depth < MAX_DEPTH && !SKIP_DIRS.has(e.name)) next.push({ dir: path.join(dir, e.name), depth: depth + 1 });
        } else if (isUiFile(e.name)) {
          return path.relative(root, path.join(dir, e.name)).split(path.sep).join('/');
        }
      }
    }
    level = next;
  }
  return null;
}

// -> { ui: boolean, source: string | null } (source says what was found).
export function detectUi(root) {
  const dep = fromPackageJson(root) || fromPubspec(root);
  if (dep) return { ui: true, source: dep };
  const file = fromFiles(root);
  if (file) return { ui: true, source: file };
  return { ui: false, source: null };
}
