// Phase 1 plan, section A and Tests: the package is @forgeyard/shipline, `npm pack` ships what `npx` needs,
// nothing in the package points users at the unscoped `npx shipline` (someone else's package), and the publish
// workflow does what the plan says. Node 18+ (runs in test:hooks).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { BIN, CLI_ROOT, makeRepo, removeDir, run, tmpDir } from './helpers.mjs';
import { PACKAGE_VERSION, templateHashes, sha256 } from '../src/hashes.mjs';

const require = createRequire(import.meta.url);
const REPO = path.resolve(CLI_ROOT, '..', '..');
const pkg = JSON.parse(readFileSync(path.join(CLI_ROOT, 'package.json'), 'utf8'));
// An unscoped `npx shipline` / `npx --yes shipline` (also `npx shipline@1.2.3`). `npx @forgeyard/shipline` is fine.
const UNSCOPED = /\bnpx\s+(?:(?:--yes|-y)\s+)?shipline(?![\w-])/;

// `npm pack --dry-run --json`, without lifecycle scripts (prepack would build the UI). Returns the file paths.
let packed;
function packFiles() {
  if (packed) return packed;
  // Windows: npm is npm.cmd, which Node only starts through a shell (EINVAL otherwise); the arguments are fixed.
  const win = process.platform === 'win32';
  const r = spawnSync(win ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: CLI_ROOT, encoding: 'utf8', shell: win });
  assert.equal(r.status, 0, r.stderr);
  const json = JSON.parse(r.stdout.slice(r.stdout.indexOf('[')));
  assert.equal(json[0].name, '@forgeyard/shipline');
  assert.equal(json[0].version, PACKAGE_VERSION);
  packed = json[0].files.map((f) => f.path);
  return packed;
}

describe('package.json', () => {
  test('name, version, bin and files', () => {
    assert.equal(pkg.name, '@forgeyard/shipline');
    assert.equal(pkg.version, '1.2.0');
    assert.deepEqual(pkg.bin, { shipline: 'bin/shipline.mjs' });
    // npm adds LICENSE on its own but not CHANGELOG.md; both are listed (1.0 plan, item 1-2).
    for (const f of ['bin', 'src', 'templates', 'ui-dist', 'CHANGELOG.md', 'LICENSE']) assert.ok(pkg.files.includes(f), f);
    assert.ok(!pkg.files.includes('test'));
    // Prepublish plan: the one runtime dependency is @inquirer/prompts (interactive init).
    assert.deepEqual(Object.keys(pkg.dependencies || {}), ['@inquirer/prompts'], 'the only dependency is @inquirer/prompts');
    assert.match(pkg.dependencies['@inquirer/prompts'], /^\^8\./);
    assert.ok(!pkg.devDependencies || Object.keys(pkg.devDependencies).length === 0, 'no devDependencies');
    assert.ok(!pkg.optionalDependencies && !pkg.peerDependencies);
  });

  test('publishConfig, repository, license, description and engines', () => {
    assert.equal(pkg.publishConfig.access, 'public');
    assert.match(pkg.repository.url, /github\.com\/.+\/shipline/);
    assert.equal(pkg.repository.directory, 'packages/cli');
    assert.equal(pkg.license, 'MIT');
    assert.match(pkg.description, /npx @forgeyard\/shipline init/);
    assert.equal(pkg.engines.node, '>=22');
    assert.equal(pkg.scripts.prepack, 'node scripts/build-ui.mjs', 'prepack builds ui-dist');
  });

  test('the root workspace scripts filter on the new name (or the folder), never the old one', () => {
    const root = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8'));
    for (const [name, script] of Object.entries(root.scripts || {})) {
      assert.ok(!/--filter[ =]shipline\b/.test(script), `${name}: ${script}`);
    }
  });
});

describe('npm pack --dry-run', () => {
  test('includes the bin, the templates, the store/upgrade code and src/known-hashes.json; no tests', () => {
    const files = packFiles();
    for (const f of [
      'package.json',
      'bin/shipline.mjs',
      'src/init.mjs',
      'src/upgrade.mjs',
      'src/hashes.mjs',
      'src/store.mjs',
      'src/known-hashes.json',
      'templates/settings-hooks.json',
      'templates/claude-md-section.md',
      'templates/shipline/bin/lib.mjs',
      'templates/shipline/bin/guard.mjs',
      'templates/shipline/config.yml',
      'templates/shipline/workflows/feature.yml',
      'templates/shipline/workflows/small.yml',
      'src/uninstall.mjs',
      'src/init-prompts.mjs',
      'templates/claude/skills/shipline-workflow/SKILL.md',
      'LICENSE',
      'CHANGELOG.md',
    ]) {
      assert.ok(files.includes(f), f);
    }
    assert.ok(!files.includes('templates/shipline/gitignore'), 'the gitignore template is gone');
    assert.ok(!files.some((f) => f.startsWith('test/') || f.startsWith('scripts/')), files.filter((f) => /^(test|scripts)\//.test(f)).join(', '));
    assert.ok(!files.some((f) => f.startsWith('examples/') || f.includes('todo-node')), 'the example app is not in the package');
  });

  test('includes ui-dist/index.html', { skip: existsSync(path.join(CLI_ROOT, 'ui-dist', 'index.html')) ? false : 'ui-dist is not built here (prepack builds it on publish)' }, () => {
    assert.ok(packFiles().includes('ui-dist/index.html'));
  });

  // ui-dist is a local build (gitignored, rebuilt by prepack on publish), so the browser UI's sources are
  // checked instead of whatever bundle happens to be on disk.
  test('no file in the package (and no browser UI source) refers to an unscoped `npx shipline`', () => {
    const offenders = [];
    const scan = (abs, label) => {
      readFileSync(abs, 'utf8').split('\n').forEach((line, i) => {
        const m = UNSCOPED.exec(line);
        if (m) offenders.push(`${label}:${i + 1}: ...${line.slice(Math.max(0, m.index - 40), m.index + 60)}...`);
      });
    };
    for (const f of packFiles()) {
      if (f.startsWith('ui-dist/') || !/\.(mjs|js|json|md|yml|html|txt)$/.test(f)) continue;
      scan(path.join(CLI_ROOT, f), f);
    }
    const uiSrc = path.join(REPO, 'packages', 'ui', 'src');
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.(tsx?|css|html)$/.test(e.name)) scan(full, path.relative(REPO, full));
      }
    };
    if (existsSync(uiSrc)) walk(uiSrc);
    for (const f of ['packages/ui/vite.config.ts', 'packages/ui/index.html']) if (existsSync(path.join(REPO, f))) scan(path.join(REPO, f), f);
    assert.deepEqual(offenders, []);
  });

  // The hub (and its own `npx shipline`) is gone, so the whole README is held to the same rule as the package.
  // Setup polish plan, item 7: the npm page shows packages/cli/README.md, so every link in it must be absolute.
  test('the npm README is in the package, explains the package, and has only absolute links', () => {
    assert.ok(packFiles().includes('README.md'), 'npm always includes README.md');
    const text = readFileSync(path.join(CLI_ROOT, 'README.md'), 'utf8');
    assert.match(text, /npx @forgeyard\/shipline init/);
    for (const want of ['--terminal', '--yes', '`init`', '`ui`', '`upgrade`', '`uninstall`']) assert.ok(text.includes(want), want);
    assert.ok(!/\]\(\.{0,2}\//.test(text), 'no relative ](./ or ](../ or ](/ links');
    const links = [...text.matchAll(/\]\(([^)\s]+)/g)].map((m) => m[1]);
    assert.ok(links.length >= 4, links.join(', '));
    for (const l of links) assert.match(l, /^(https:\/\/|#)/, l);
    for (const f of ['#readme', 'CHANGELOG.md', 'LICENSE', '/issues']) {
      assert.ok(links.some((l) => l.startsWith('https://github.com/siddharth-Spark18/shipline') && l.includes(f)), f);
    }
  });

  test('the README uses the scoped name everywhere', () => {
    const offenders = [];
    readFileSync(path.join(REPO, 'README.md'), 'utf8').split('\n').forEach((line, i) => {
      if (UNSCOPED.test(line)) offenders.push(`README.md:${i + 1}: ${line.trim()}`);
    });
    assert.match(readFileSync(path.join(REPO, 'README.md'), 'utf8'), /npx @forgeyard\/shipline init/);
    assert.deepEqual(offenders, []);
  });

  test('the retired plugin and its marketplace entry are gone', () => {
    for (const f of ['packages/plugin', '.claude-plugin/marketplace.json', 'turbo.json']) {
      assert.ok(!existsSync(path.join(REPO, f)), `${f} was removed with the hub`);
    }
  });
});

describe('the bin', () => {
  test('--help names the scoped package and every command; each command\'s --help has its usage', () => {
    const r = run(process.execPath, [BIN, '--help'], { cwd: CLI_ROOT });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /npx @forgeyard\/shipline <command> \[options\]/);
    for (const c of ['init', 'upgrade', 'uninstall', 'ui']) assert.match(r.stdout, new RegExp(`^ {2}${c} `, 'm'), c);
    assert.ok(!UNSCOPED.test(r.stdout));
    const usage = {
      init: /npx @forgeyard\/shipline init \[--dir <path>\] \[--yes\] \[--dry-run\]/,
      uninstall: /npx @forgeyard\/shipline uninstall \[--dir <path>\] \[--yes\] \[--dry-run\] \[--purge\]/,
      upgrade: /npx @forgeyard\/shipline upgrade \[--dir <path>\] \[--yes\] \[--dry-run\] \[--force\]/,
      ui: /npx @forgeyard\/shipline ui \[--dir <path>\] \[--port <n>\] \[--no-open\]/,
    };
    for (const [c, re] of Object.entries(usage)) {
      const h = run(process.execPath, [BIN, c, '--help'], { cwd: CLI_ROOT });
      assert.equal(h.code, 0, c);
      assert.match(h.stdout, re, c);
      assert.ok(!UNSCOPED.test(h.stdout), c);
    }
  });

  test('an unknown command prints the help and exits 2', () => {
    const r = run(process.execPath, [BIN, 'bogus'], { cwd: CLI_ROOT });
    assert.equal(r.code, 2);
    assert.match(r.stdout, /Usage:/);
    assert.match(r.stderr, /unknown command bogus/);
  });
});

describe('known-hashes.json', () => {
  const KNOWN = require('../src/known-hashes.json');

  test('records every current template hash (hash-templates.mjs was run for this version)', () => {
    const missing = Object.entries(templateHashes()).filter(([p, h]) => !(KNOWN[p] && KNOWN[p][h])).map(([p]) => p);
    assert.deepEqual(missing, [], 'run: node packages/cli/scripts/hash-templates.mjs');
    // The publish workflow makes the same check (.github/workflows/publish.yml). It no longer asks for an entry
    // under this version: a release that changes no template (0.12.0) adds none.
    const workflow = readFileSync(path.join(REPO, '.github', 'workflows', 'publish.yml'), 'utf8');
    assert.match(workflow, /known-hashes\.json must record every current template hash/);
    assert.match(workflow, /templateHashes\(\)/);
  });

  test('format: { "<install path>": { "<sha256>": "<version>" } }, sorted by path', () => {
    const paths = Object.keys(KNOWN);
    assert.deepEqual(paths, [...paths].sort());
    for (const [p, byHash] of Object.entries(KNOWN)) {
      // The optional CI workflow (Trust plan, C) is the one Shipline-owned file outside .shipline/ and .claude/.
      assert.ok(/^\.(shipline|claude)\/|^CLAUDE\.md#shipline$|^\.github\/workflows\/shipline\.yml$/.test(p), p);
      for (const [h, v] of Object.entries(byHash)) {
        assert.match(h, /^[0-9a-f]{64}$/, p);
        assert.match(v, /^\d+\.\d+\.\d+$/, p);
      }
      assert.ok(!/^\.shipline\/(config\.yml|workflows\/|rules\/)/.test(p), `${p} is team-owned and must not be listed`);
    }
  });

  // 1.0 plan, item 3: the upgrade history starts over at 1.0.0. Setup polish plan, item 9: 1.1.0 adds its hashes
  // (only the shipline-setup skill changed) and keeps every 1.0.0 one, so upgrade from 1.0.0 refreshes unedited files.
  test('keeps one 1.0.0 hash per path and adds the 1.1.0 shipline-setup skill', () => {
    const current = templateHashes();
    assert.deepEqual(Object.keys(KNOWN).sort(), Object.keys(current).sort());
    const SKILL = '.claude/skills/shipline-setup/SKILL.md';
    for (const [p, byHash] of Object.entries(KNOWN)) {
      assert.equal(Object.values(byHash).filter((v) => v === '1.0.0').length, 1, `${p}: its 1.0.0 entry`);
      assert.ok(Object.values(byHash).every((v) => v === '1.0.0' || v === '1.1.0'), p);
      if (p !== SKILL) assert.deepEqual(byHash, { [current[p]]: '1.0.0' }, p);
    }
    assert.deepEqual(KNOWN[SKILL], {
      dada383a26cf8d85288156129d53c3b684455bea529fa78c314c299667cc3c39: '1.0.0',
      [current[SKILL]]: '1.1.0',
    });
    assert.equal(current[SKILL], sha256(readFileSync(path.join(CLI_ROOT, 'templates', 'claude', 'skills', 'shipline-setup', 'SKILL.md'))));
  });

  test('every Shipline file a fresh init writes (and its CLAUDE.md block and settings part) is known', () => {
    const dir = makeRepo();
    try {
      const v = JSON.parse(readFileSync(path.join(dir, '.shipline', 'bin', 'VERSION'), 'utf8'));
      assert.equal(v.package, PACKAGE_VERSION);
      let checked = 0;
      for (const [p, h] of Object.entries(v.files)) {
        if (!KNOWN[p]) continue; // files known-hashes.json doesn't track (none expected beyond the team-owned ones)
        assert.equal(KNOWN[p][h], p === '.claude/skills/shipline-setup/SKILL.md' ? '1.1.0' : '1.0.0', p);
        if (!p.includes('#')) assert.equal(sha256(readFileSync(path.join(dir, p))), h, p);
        checked++;
      }
      assert.ok(checked >= 10, `checked ${checked} files`);
      assert.equal(KNOWN['CLAUDE.md#shipline'][v.files['CLAUDE.md#shipline']], '1.0.0');
      assert.equal(KNOWN['.claude/settings.json#shipline'][v.files['.claude/settings.json#shipline']], '1.0.0');
    } finally {
      removeDir(dir);
    }
  });
});

// 1.0 plan, item 3: known-stub-rules.mjs keeps only the 1.0 stubs, one per shipped rules file.
describe('known-stub-rules.mjs', () => {
  test('one hash per shipped rules file: the LF-normalised 1.0 template', async () => {
    const { KNOWN_STUB_RULES } = await import('../src/known-stub-rules.mjs');
    const dir = path.join(CLI_ROOT, 'templates', 'shipline', 'rules');
    const shipped = readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
    assert.deepEqual(Object.keys(KNOWN_STUB_RULES).sort(), shipped);
    for (const f of shipped) {
      assert.deepEqual(KNOWN_STUB_RULES[f], [sha256(readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n'))], f);
    }
  });
});

describe('scripts/hash-templates.mjs', () => {
  // Run on a copy of the package (it writes src/known-hashes.json next to itself).
  test('is idempotent for this version, and records an edited template under the package version', () => {
    const copy = tmpDir('shipline-pkg-');
    try {
      for (const p of ['package.json', 'src', 'scripts', 'templates']) cpSync(path.join(CLI_ROOT, p), path.join(copy, p), { recursive: true });
      const file = path.join(copy, 'src', 'known-hashes.json');
      const original = readFileSync(file, 'utf8');
      const r1 = run(process.execPath, [path.join(copy, 'scripts', 'hash-templates.mjs')], { cwd: copy });
      assert.equal(r1.code, 0, r1.stderr);
      assert.equal(r1.stdout, `known-hashes.json: 0 new hash(es) recorded for ${PACKAGE_VERSION}.\n`);
      assert.equal(readFileSync(file, 'utf8'), original);

      appendFileSync(path.join(copy, 'templates', 'shipline', 'bin', 'guard.mjs'), '// changed\n');
      const r2 = run(process.execPath, [path.join(copy, 'scripts', 'hash-templates.mjs')], { cwd: copy });
      assert.equal(r2.code, 0, r2.stderr);
      assert.equal(r2.stdout, `known-hashes.json: 1 new hash(es) recorded for ${PACKAGE_VERSION}.\n`);
      const known = JSON.parse(readFileSync(file, 'utf8'));
      const h = sha256(readFileSync(path.join(copy, 'templates', 'shipline', 'bin', 'guard.mjs')));
      assert.equal(known['.shipline/bin/guard.mjs'][h], PACKAGE_VERSION);
      // Older entries are kept.
      for (const [p, byHash] of Object.entries(JSON.parse(original))) for (const [hh, v] of Object.entries(byHash)) assert.equal(known[p][hh], v);
    } finally {
      removeDir(copy);
    }
  });
});

describe('.github/workflows/publish.yml', () => {
  const yml = readFileSync(path.join(REPO, '.github', 'workflows', 'publish.yml'), 'utf8');

  test('runs on a v*.*.* tag push with contents: read and id-token: write', () => {
    assert.match(yml, /on:\n\s+push:\n\s+tags:\n\s+- 'v\*\.\*\.\*'/);
    assert.match(yml, /permissions:\n\s+contents: read\n\s+id-token: write/);
  });

  test('checks the tag against package.json and known-hashes.json, tests, typechecks, then publishes with provenance', () => {
    const steps = ['GITHUB_REF_NAME', 'known-hashes.json', 'pnpm install', 'packages/cli test', '@shipline/ui typecheck', 'npm publish --access public --provenance'];
    let at = -1;
    for (const s of steps) {
      const i = yml.indexOf(s, at + 1);
      assert.ok(i > at, `${s} comes after the previous step`);
      at = i;
    }
    assert.match(yml, /\$\{GITHUB_REF_NAME\}" != "v\$\{version\}"/);
    assert.match(yml, /working-directory: packages\/cli/);
    // Trusted publishing (OIDC): no token secret, npm 11.5.1+ via Node 24, and an already-published version is skipped.
    assert.doesNotMatch(yml, /NPM_TOKEN|NODE_AUTH_TOKEN/);
    assert.match(yml, /node-version: 24/);
    assert.ok(yml.indexOf('npm view "@forgeyard/shipline@${version}" version') < yml.indexOf('npm publish --access public --provenance'));
    assert.match(yml, /if: steps\.published\.outputs\.skip != 'true'/);
  });

  test('fails when CHANGELOG.md has no heading for the version, before publishing', () => {
    const i = yml.indexOf('packages/cli/CHANGELOG.md');
    assert.ok(i > 0 && i < yml.indexOf('npm publish'), 'the CHANGELOG check runs before npm publish');
    assert.match(yml, /grep -qF "## \[\$\{version\}\]" packages\/cli\/CHANGELOG\.md/);
  });
});

describe('LICENSE and CHANGELOG.md', () => {
  test('MIT, 2026 Siddharth Paneri, at the repo root and in the package (same text)', () => {
    const root = readFileSync(path.join(REPO, 'LICENSE'), 'utf8');
    assert.match(root, /^MIT License\n/);
    assert.match(root, /Copyright \(c\) 2026 Siddharth Paneri/);
    assert.equal(readFileSync(path.join(CLI_ROOT, 'LICENSE'), 'utf8'), root);
  });

  test('CHANGELOG.md has a Keep a Changelog heading for this version, and none before 1.0.0', () => {
    const log = readFileSync(path.join(CLI_ROOT, 'CHANGELOG.md'), 'utf8');
    assert.match(log, /Keep a Changelog/);
    assert.ok(log.includes(`## [${PACKAGE_VERSION}] - `), `## [${PACKAGE_VERSION}]`);
    assert.equal(PACKAGE_VERSION, '1.2.0');
    assert.ok(log.indexOf('## [1.2.0] - ') < log.indexOf('## [1.0.0] - '), 'newest first, 1.0.0 kept');
    assert.deepEqual([...log.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]).filter((v) => v.startsWith('0.')), []);
  });
});
