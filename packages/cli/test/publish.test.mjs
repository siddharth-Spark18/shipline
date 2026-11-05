// Phase 1 plan, section A and Tests: the package is @forgeyard/shipline, `npm pack` ships what `npx` needs,
// nothing in the package points users at the unscoped `npx shipline` (someone else's package), and the publish
// workflow does what the plan says. Node 18+ (runs in test:hooks).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { BIN, CLI_ROOT, FIXTURES, removeDir, run, tmpDir } from './helpers.mjs';
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
    assert.equal(pkg.version, '0.10.0');
    assert.deepEqual(pkg.bin, { shipline: 'bin/shipline.mjs' });
    for (const f of ['bin', 'src', 'templates', 'ui-dist']) assert.ok(pkg.files.includes(f), f);
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
    assert.equal(typeof pkg.license, 'string');
    assert.match(pkg.description, /npx @forgeyard\/shipline init/);
    assert.equal(pkg.engines.node, '>=18');
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
    ]) {
      assert.ok(files.includes(f), f);
    }
    assert.ok(!files.includes('templates/shipline/gitignore'), 'the gitignore template is gone');
    assert.ok(!files.some((f) => f.startsWith('test/') || f.startsWith('scripts/')), files.filter((f) => /^(test|scripts)\//.test(f)).join(', '));
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
  test('--help names the scoped package and the upgrade command', () => {
    const r = run(process.execPath, [BIN, '--help'], { cwd: CLI_ROOT });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /npx @forgeyard\/shipline init \[dir\] \[--yes\] \[--dry-run\]/);
    assert.match(r.stdout, /npx @forgeyard\/shipline uninstall \[dir\] \[--yes\] \[--dry-run\] \[--purge\]/);
    assert.match(r.stdout, /npx @forgeyard\/shipline upgrade \[dir\] \[--yes\] \[--dry-run\] \[--force\]/);
    assert.match(r.stdout, /npx @forgeyard\/shipline ui \[dir\]/);
    assert.ok(!UNSCOPED.test(r.stdout));
  });

  test('an unknown command prints the help and exits 1', () => {
    const r = run(process.execPath, [BIN, 'bogus'], { cwd: CLI_ROOT });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /Usage:/);
  });
});

describe('known-hashes.json', () => {
  const KNOWN = require('../src/known-hashes.json');

  test('records every current template hash (hash-templates.mjs was run for this version)', () => {
    const missing = Object.entries(templateHashes()).filter(([p, h]) => !(KNOWN[p] && KNOWN[p][h])).map(([p]) => p);
    assert.deepEqual(missing, [], 'run: node packages/cli/scripts/hash-templates.mjs');
    assert.ok(Object.values(KNOWN).some((byHash) => Object.values(byHash).includes(PACKAGE_VERSION)), 'the publish workflow check passes');
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

  test('is seeded with 0.6.0: every Shipline file of the legacy-0.6 fixture (brown-bg-tracker) is known as 0.6.0', () => {
    const legacy = path.join(FIXTURES, 'legacy-0.6');
    for (const p of Object.keys(KNOWN)) {
      if (p.includes('#')) continue;
      const file = path.join(legacy, p);
      if (!existsSync(file)) continue;
      assert.equal(KNOWN[p][sha256(readFileSync(file))], '0.6.0', p);
    }
    assert.ok(Object.values(KNOWN['CLAUDE.md#shipline']).includes('0.6.0'));
    assert.ok(Object.values(KNOWN['.claude/settings.json#shipline']).includes('0.6.0'));
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
    assert.match(yml, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
  });
});
