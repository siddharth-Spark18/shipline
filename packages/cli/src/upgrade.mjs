// `shipline upgrade`: brings a repo that already has Shipline up to this version, and moves its task data
// into the store outside the repo. Never commits; stages `git rm` only. Node 18+, no dependencies.
import { execFileSync } from 'node:child_process';
import {
  cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline/promises';
import { parseYaml } from '../templates/shipline/bin/lib.mjs';
import {
  CLAUDE_MD_KEY, END, PACKAGE_VERSION, SETTINGS_KEY, START, VERSION_FILE,
  canonicalSettingsPart, claudeMdBlock, claudeMdSection, ownedTemplateFiles, sha256, templateSettings,
} from './hashes.mjs';
import { INTERFACE, compareInterface, readRepoVersion } from './interface.mjs';
import { mergeSettingsObject, parseSettings } from './init.mjs';
import { configLayout } from './setup-schema.mjs';
import { encodePath, shiplineHome, storeDir } from './store.mjs';
import { emitConfig, emitWorkflow } from './yaml-emit.mjs';

const require = createRequire(import.meta.url);
const KNOWN = require('./known-hashes.json');
const RECENT_MS = 30 * 60 * 1000;
const REMOVED_CONFIG_KEYS = ['artifact_root', 'folder_pattern'];

const readText = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null);
const posix = (p) => p.split(path.sep).join('/');

// ---------- small helpers ----------

function semverGt(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

function isGitRepo(root) {
  try {
    return git(root, ['rev-parse', '--is-inside-work-tree']).trim() === 'true';
  } catch {
    return false;
  }
}

// Line diff (LCS) of two texts, printed with 2 lines of context. Returns indented lines.
function lineDiff(a, b) {
  const x = a.split('\n');
  const y = b.split('\n');
  if (x.length * y.length > 4_000_000) return ['    (diff too large to show)'];
  const w = y.length + 1;
  const dp = new Uint32Array((x.length + 1) * w);
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      dp[i * w + j] = x[i] === y[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) ops.push([' ', x[i++]]), j++;
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) ops.push(['-', x[i++]]);
    else ops.push(['+', y[j++]]);
  }
  while (i < x.length) ops.push(['-', x[i++]]);
  while (j < y.length) ops.push(['+', y[j++]]);
  const show = new Array(ops.length).fill(false);
  ops.forEach(([t], k) => {
    if (t === ' ') return;
    for (let d = -2; d <= 2; d++) if (k + d >= 0 && k + d < ops.length) show[k + d] = true;
  });
  const out = [];
  let gap = false;
  ops.forEach(([t, s], k) => {
    if (!show[k]) {
      gap = true;
      return;
    }
    if (gap && out.length) out.push('    ...');
    gap = false;
    out.push(`    ${t} ${s}`);
  });
  return out;
}

// { relative/path: sha256 } for every file under dir.
function treeHashes(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) out[posix(path.relative(dir, full))] = sha256(readFileSync(full));
    }
  };
  walk(dir);
  return out;
}

const sameHashes = (a, b) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};

function leadingHeader(raw) {
  const lines = raw.split('\n');
  let n = 0;
  while (n < lines.length && lines[n].startsWith('#')) n++;
  if (n === 0) return '';
  const blank = lines[n] === '' && n < lines.length - 1;
  return lines.slice(0, n).join('\n') + '\n' + (blank ? '\n' : '');
}

// Read-only look at the store path (nothing is created), for dry runs and the plan.
function peekStore(root) {
  let real = root;
  try {
    real = realpathSync(root);
  } catch {
    // Keep the given path.
  }
  const dir = path.join(shiplineHome(), 'projects', encodePath(real));
  try {
    const meta = JSON.parse(readFileSync(path.join(dir, 'repo.json'), 'utf8'));
    if (meta && typeof meta.root === 'string' && meta.root !== real) {
      throw new Error(`Shipline store collision at ${dir}: it belongs to ${meta.root}, but this repo is ${real}. Nothing was shared.`);
    }
  } catch (e) {
    if (/collision/.test(e.message)) throw e;
  }
  return dir;
}

// ---------- planning ----------

function isUnedited(cur, to, record) {
  const recorded = record && record[to];
  if (recorded) return cur === recorded;
  return Object.prototype.hasOwnProperty.call(KNOWN[to] || {}, cur);
}

function planFiles(root, version, force) {
  const record = version.files || null;
  const plan = { add: [], replace: [], remove: [], skip: [], same: [], hashes: {} };
  const owned = ownedTemplateFiles();
  const ownedPaths = new Set(owned.map((f) => f.to));

  for (const f of owned) {
    const data = readFileSync(f.from);
    const newHash = sha256(data);
    const abs = path.join(root, f.to);
    if (!existsSync(abs)) {
      plan.add.push({ to: f.to, data });
      plan.hashes[f.to] = newHash;
      continue;
    }
    const current = readFileSync(abs);
    const curHash = sha256(current);
    if (curHash === newHash) {
      plan.same.push(f.to);
      plan.hashes[f.to] = newHash;
    } else if (isUnedited(curHash, f.to, record) || force) {
      plan.replace.push({ to: f.to, data, forced: !isUnedited(curHash, f.to, record) });
      plan.hashes[f.to] = newHash;
    } else {
      plan.skip.push({ to: f.to, diff: lineDiff(current.toString('utf8'), data.toString('utf8')) });
      if (record && record[f.to]) plan.hashes[f.to] = record[f.to];
    }
  }

  // Shipline files that this version no longer ships: removed only when unedited.
  const candidates = new Set(record ? Object.keys(record) : Object.keys(KNOWN));
  for (const to of candidates) {
    if (ownedPaths.has(to) || to === CLAUDE_MD_KEY || to === SETTINGS_KEY) continue;
    const abs = path.join(root, to);
    if (!existsSync(abs) || !lstatSync(abs).isFile()) continue;
    const curHash = sha256(readFileSync(abs));
    if (isUnedited(curHash, to, record) || force) plan.remove.push({ to });
    else {
      plan.skip.push({ to, removed: true, diff: [] });
      if (record && record[to]) plan.hashes[to] = record[to];
    }
  }
  return plan;
}

function planShared(root, version, force) {
  const record = version.files || null;
  const shared = { claude: null, settings: null, hashes: {} };

  // CLAUDE.md block
  const mdFile = path.join(root, 'CLAUDE.md');
  const mdText = readText(mdFile);
  const section = claudeMdSection();
  const newBlockHash = sha256(claudeMdBlock(section));
  const curBlock = mdText === null ? null : claudeMdBlock(mdText);
  if (curBlock === null) {
    const text = mdText === null ? section : mdText.replace(/\s*$/, '\n\n') + section;
    shared.claude = { action: 'add', text };
    shared.hashes[CLAUDE_MD_KEY] = newBlockHash;
  } else if (sha256(curBlock) === newBlockHash) {
    shared.claude = { action: 'same' };
    shared.hashes[CLAUDE_MD_KEY] = newBlockHash;
  } else if (isUnedited(sha256(curBlock), CLAUDE_MD_KEY, record) || force) {
    const a = mdText.indexOf(START);
    const b = mdText.indexOf(END, a + START.length) + END.length;
    shared.claude = { action: 'replace', text: mdText.slice(0, a) + section.trimEnd() + mdText.slice(b) };
    shared.hashes[CLAUDE_MD_KEY] = newBlockHash;
  } else {
    shared.claude = { action: 'skip', diff: lineDiff(curBlock, claudeMdBlock(section)) };
    if (record && record[CLAUDE_MD_KEY]) shared.hashes[CLAUDE_MD_KEY] = record[CLAUDE_MD_KEY];
  }

  // settings.json hook entries and allow rules
  const setFile = path.join(root, '.claude', 'settings.json');
  const setText = readText(setFile);
  const settings = parseSettings(setText);
  const tpl = templateSettings();
  const newPart = canonicalSettingsPart(tpl);
  const curPart = canonicalSettingsPart(settings);
  const pretty = (part) => JSON.stringify(JSON.parse(part), null, 2);
  const merged = () => JSON.stringify(mergeSettingsObject(settings, tpl, { replace: true }), null, 2) + '\n';
  const parsedPart = JSON.parse(curPart);
  const hasShipline = Object.keys(parsedPart.hooks).length > 0 || parsedPart.allow.length > 0;
  if (curPart === newPart) {
    shared.settings = { action: 'same' };
    shared.hashes[SETTINGS_KEY] = sha256(newPart);
  } else if (isUnedited(sha256(curPart), SETTINGS_KEY, record) || force || !hasShipline) {
    shared.settings = { action: setText === null ? 'add' : 'replace', text: merged() };
    shared.hashes[SETTINGS_KEY] = sha256(newPart);
  } else {
    shared.settings = { action: 'skip', diff: lineDiff(pretty(curPart), pretty(newPart)) };
    if (record && record[SETTINGS_KEY]) shared.hashes[SETTINGS_KEY] = record[SETTINGS_KEY];
  }
  return shared;
}

// config.yml loses artifact_root and folder_pattern; workflows lose {artifact_root} allow_paths entries.
function planConfig(root) {
  const out = { config: null, workflows: [], artifactRoot: null };
  const cfgFile = path.join(root, '.shipline', 'config.yml');
  const raw = readText(cfgFile);
  if (raw !== null) {
    let model;
    try {
      model = parseYaml(raw) || {};
    } catch (e) {
      throw new Error(`.shipline/config.yml could not be parsed (${e.message}). Fix it first; nothing was changed.`);
    }
    if (typeof model.artifact_root === 'string' && model.artifact_root.trim()) {
      out.artifactRoot = model.artifact_root.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    }
    const present = REMOVED_CONFIG_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(model, k));
    if (present.length) {
      for (const k of present) delete model[k];
      const text = emitConfig(model, { layout: configLayout(), raw });
      out.config = { keys: present, text, diff: lineDiff(raw, text) };
    }
  }

  const wfDir = path.join(root, '.shipline', 'workflows');
  if (existsSync(wfDir)) {
    for (const name of readdirSync(wfDir).filter((n) => n.endsWith('.yml')).sort()) {
      const wfRaw = readFileSync(path.join(wfDir, name), 'utf8');
      if (!wfRaw.includes('{artifact_root}')) continue;
      let model;
      try {
        model = parseYaml(wfRaw);
      } catch (e) {
        throw new Error(`.shipline/workflows/${name} could not be parsed (${e.message}). Fix it first; nothing was changed.`);
      }
      let changed = 0;
      for (const stage of (model && Array.isArray(model.stages) ? model.stages : [])) {
        if (!stage || !Array.isArray(stage.blocks)) continue;
        for (const b of stage.blocks) {
          if (!b || !Array.isArray(b.allow_paths)) continue;
          const kept = b.allow_paths.filter((g) => !String(g).includes('{artifact_root}'));
          if (kept.length !== b.allow_paths.length) {
            changed += b.allow_paths.length - kept.length;
            if (kept.length) b.allow_paths = kept;
            else delete b.allow_paths;
          }
        }
      }
      if (!changed) continue;
      const text = emitWorkflow(model, { header: leadingHeader(wfRaw), raw: wfRaw });
      out.workflows.push({ file: `.shipline/workflows/${name}`, entries: changed, text, diff: lineDiff(wfRaw, text) });
    }
  }
  return out;
}

// What moves into the store from the old in-repo locations.
function planMigration(root, artifactRoot, storePath, hasGit) {
  const mig = { tasks: [], state: [], leftovers: [], problems: [], warnings: [], stateRoot: null };
  const base = path.join(root, artifactRoot);
  if (existsSync(base) && lstatSync(base).isDirectory()) {
    for (const e of readdirSync(base, { withFileTypes: true })) {
      const src = path.join(base, e.name);
      if (e.isDirectory() && existsSync(path.join(src, 'manifest.json'))) {
        mig.tasks.push({ name: e.name, src, rel: posix(path.relative(root, src)), dest: path.join(storePath, 'tasks', e.name) });
      } else {
        mig.leftovers.push(posix(path.relative(root, src)) + (e.isDirectory() ? '/' : ''));
      }
    }
  }

  const stateRoot = path.join(root, '.shipline', '.state');
  if (existsSync(stateRoot) && lstatSync(stateRoot).isDirectory()) {
    mig.stateRoot = stateRoot;
    for (const e of readdirSync(stateRoot, { withFileTypes: true })) {
      const src = path.join(stateRoot, e.name);
      if (e.name === 'ui' && e.isDirectory()) {
        for (const u of readdirSync(src, { withFileTypes: true })) {
          if (u.name === 'tmp') continue; // scratch files, not worth moving
          mig.state.push({ src: path.join(src, u.name), dest: path.join(storePath, 'ui', u.name), dir: u.isDirectory() });
        }
      } else if (/^ui\.log(\.1)?$/.test(e.name)) {
        mig.state.push({ src, dest: path.join(storePath, 'ui', e.name), dir: false });
      } else {
        mig.state.push({ src, dest: path.join(storePath, 'state', e.name), dir: e.isDirectory() });
      }
    }
  }

  // Preflight problems.
  for (const t of mig.tasks) {
    if (existsSync(t.dest)) mig.problems.push(`${t.rel}: a task named "${t.name}" already exists in the store (${t.dest})`);
    if (hasGit) {
      try {
        const st = git(root, ['status', '--porcelain', '--untracked-files=all', '--', t.rel]).trim();
        if (st) mig.problems.push(`${t.rel}: has uncommitted or untracked changes; commit or stash them first`);
      } catch (e) {
        mig.problems.push(`${t.rel}: git status failed (${String(e.stderr || e.message).trim()})`);
      }
    }
  }
  for (const s of mig.state) {
    if (existsSync(s.dest)) mig.problems.push(`${posix(path.relative(root, s.src))}: ${s.dest} already exists in the store`);
  }

  // Warnings: sessions that look alive.
  const now = Date.now();
  for (const s of mig.state) {
    if (s.dir || !s.src.endsWith('.json') || path.dirname(s.src) !== stateRoot) continue;
    try {
      if (now - statSync(s.src).mtimeMs < RECENT_MS) mig.warnings.push(`Claude session ${path.basename(s.src, '.json')} was active in the last 30 minutes; restart it after the upgrade`);
    } catch {
      // Gone already.
    }
  }
  if (existsSync(path.join(stateRoot, 'ui', 'lock.json'))) mig.warnings.push('a Shipline UI chat lock is held (.shipline/.state/ui/lock.json); stop the UI chat first');
  return mig;
}

// ---------- applying ----------

class StepError extends Error {
  constructor(step, cause, extra = '') {
    super(`${step}: ${cause && cause.message ? cause.message : cause}${extra}`);
    this.step = step;
  }
}

function copyVerified(src, dest, isDir) {
  mkdirSync(path.dirname(dest), { recursive: true });
  if (isDir) {
    cpSync(src, dest, { recursive: true, errorOnExist: true, force: false });
    if (!sameHashes(treeHashes(src), treeHashes(dest))) throw new Error(`copy of ${src} does not match the original`);
  } else {
    cpSync(src, dest, { errorOnExist: true, force: false });
    if (sha256(readFileSync(src)) !== sha256(readFileSync(dest))) throw new Error(`copy of ${src} does not match the original`);
  }
}

// Rewrites task_dir in a migrated state file or sessions.json to the task's absolute store path.
function rewriteTaskDirs(file, root, artifactRoot, storePath) {
  const base = path.join(root, artifactRoot);
  const fix = (entry) => {
    if (!entry || typeof entry.task_dir !== 'string' || !entry.task_dir) return false;
    const abs = path.resolve(root, entry.task_dir);
    const rel = path.relative(base, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel) || rel === '') return false;
    const name = rel.split(path.sep)[0];
    entry.task_dir = path.join(storePath, 'tasks', name);
    return true;
  };
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return; // Not JSON we understand: the verified copy is kept as it is.
  }
  const changed = Array.isArray(data) ? data.map(fix).some(Boolean) : fix(data);
  if (changed) writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function apply(root, ctx) {
  const { files, shared, cfgPlan, mig, hasGit, artifactRoot } = ctx;
  let step = 'preparing the store';
  let gitRemoved = [];
  try {
    const storePath = storeDir(root); // creates it and runs the repo.json guard

    step = 'copying tasks and state to the store';
    for (const t of mig.tasks) copyVerified(t.src, t.dest, true);
    for (const s of mig.state) copyVerified(s.src, s.dest, s.dir);
    for (const s of mig.state) {
      if (!s.dir && s.dest.endsWith('.json')) rewriteTaskDirs(s.dest, root, artifactRoot, storePath);
    }

    step = 'writing files';
    for (const f of [...files.add, ...files.replace]) {
      const abs = path.join(root, f.to);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, f.data);
    }
    for (const f of files.remove) rmSync(path.join(root, f.to), { force: true });
    if (shared.claude.text !== undefined && shared.claude.action !== 'skip') writeFileSync(path.join(root, 'CLAUDE.md'), shared.claude.text);
    if (shared.settings.text !== undefined) {
      mkdirSync(path.join(root, '.claude'), { recursive: true });
      writeFileSync(path.join(root, '.claude', 'settings.json'), shared.settings.text);
    }
    if (cfgPlan.config) writeFileSync(path.join(root, '.shipline', 'config.yml'), cfgPlan.config.text);
    for (const w of cfgPlan.workflows) writeFileSync(path.join(root, w.file), w.text);

    step = 'staging the removal of the old task folders (git rm)';
    for (const t of mig.tasks) {
      let tracked = '';
      if (hasGit) {
        try {
          tracked = git(root, ['ls-files', '--', t.rel]).trim();
        } catch {
          tracked = '';
        }
      }
      if (tracked) {
        git(root, ['rm', '-r', '-q', '--', t.rel]);
        gitRemoved.push(t.rel);
      }
      rmSync(t.src, { recursive: true, force: true });
    }

    step = 'removing .shipline/.state/';
    if (mig.stateRoot) rmSync(mig.stateRoot, { recursive: true, force: true });

    step = 'writing .shipline/bin/VERSION';
    const newVersion = { package: PACKAGE_VERSION, interface: INTERFACE, files: sortKeys({ ...files.hashes, ...shared.hashes }) };
    writeFileSync(path.join(root, VERSION_FILE), JSON.stringify(newVersion, null, 2) + '\n');
  } catch (e) {
    const notes = [];
    if (gitRemoved.length) notes.push(`The removal of ${gitRemoved.join(', ')} stays staged; to undo it run: git restore --staged ${gitRemoved.join(' ')}`);
    if (mig.tasks.length) notes.push(`Copies already made in the store were left in place (${path.join(storeDirSafe(root), 'tasks')}); remove them before running upgrade again.`);
    notes.push('.shipline/bin/VERSION was not rewritten, so the repo still reports its old version.');
    throw new StepError(`upgrade failed while ${step}`, e, '\n' + notes.join('\n'));
  }
}

function sortKeys(o) {
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
}

function storeDirSafe(root) {
  try {
    return peekStore(root);
  } catch {
    return '<store>';
  }
}

// ---------- entry point ----------

// Returns a process exit code.
export async function runUpgrade({ target, yes = false, dryRun = false, force = false } = {}) {
  const root = path.resolve(target || process.cwd());
  if (!existsSync(root) || !lstatSync(root).isDirectory()) {
    console.error(`shipline: ${root} is not a directory.`);
    return 1;
  }
  if (!existsSync(path.join(root, '.shipline', 'config.yml'))) {
    console.error('shipline: no .shipline/ found here. Run `npx @forgeyard/shipline init` first.');
    return 1;
  }

  const version = readRepoVersion(root);
  const rel = compareInterface(version, INTERFACE);
  if (rel === 'repo-newer' || (rel === 'same' && version.package && semverGt(version.package, PACKAGE_VERSION))) {
    const v = version.package || `interface ${version.interface}`;
    console.error(`shipline: this repo was set up with Shipline ${v}, which is newer than this CLI (${PACKAGE_VERSION}). Run \`npx @forgeyard/shipline@${version.package || 'latest'} ...\` instead. Nothing was changed.`);
    return 1;
  }

  let files;
  let shared;
  let cfgPlan;
  let storePath;
  const hasGit = isGitRepo(root);
  try {
    storePath = peekStore(root);
    files = planFiles(root, version, force);
    shared = planShared(root, version, force);
    cfgPlan = planConfig(root);
  } catch (e) {
    console.error(`shipline: ${e.message}`);
    return 1;
  }
  const artifactRoot = cfgPlan.artifactRoot || 'docs/shipline';
  const needsMigration = version.interface < INTERFACE;
  const mig = needsMigration
    ? planMigration(root, artifactRoot, storePath, hasGit)
    : { tasks: [], state: [], leftovers: [], problems: [], warnings: [], stateRoot: null };

  const newVersion = { package: PACKAGE_VERSION, interface: INTERFACE, files: sortKeys({ ...files.hashes, ...shared.hashes }) };
  const oldVersion = { package: version.package, interface: version.interface, files: version.files ? sortKeys(version.files) : null };
  const versionChanged = JSON.stringify(newVersion) !== JSON.stringify(oldVersion);

  const sharedActions = [shared.claude, shared.settings].filter((s) => s.action !== 'same' && s.action !== 'skip');
  const skipped = [...files.skip, ...(shared.claude.action === 'skip' ? [{ to: 'CLAUDE.md (Shipline block)', diff: shared.claude.diff }] : []), ...(shared.settings.action === 'skip' ? [{ to: '.claude/settings.json (Shipline hook entries and allow rules)', diff: shared.settings.diff }] : [])];
  const nothingToDo =
    !files.add.length && !files.replace.length && !files.remove.length && !sharedActions.length &&
    !cfgPlan.config && !cfgPlan.workflows.length && !mig.tasks.length && !mig.state.length && !versionChanged;

  if (nothingToDo) {
    console.log('Already up to date.');
    if (skipped.length) console.log(`Skipped (edited by your team; use --force to replace): ${skipped.map((s) => s.to).join(', ')}`);
    return 0;
  }

  // ---- preview ----
  const out = [];
  out.push(`Shipline upgrade for ${root}`);
  out.push(`  repo: ${version.package || 'unknown'} (interface ${version.interface}) -> ${PACKAGE_VERSION} (interface ${INTERFACE})`);
  out.push('', 'Files');
  for (const f of files.add) out.push(`  + add      ${f.to}`);
  for (const f of files.replace) out.push(`  ~ replace  ${f.to}${f.forced ? ' (edited, --force)' : ''}`);
  for (const f of files.remove) out.push(`  - remove   ${f.to}`);
  if (![...files.add, ...files.replace, ...files.remove].length) out.push('  (no file changes)');
  for (const s of skipped) {
    out.push(`  ! skip     ${s.to}: edited by your team${s.removed ? ' (no longer shipped)' : ''}; use --force to replace. Changes it would get:`);
    out.push(...s.diff);
  }
  out.push('', 'Shared files');
  out.push(`  CLAUDE.md block: ${shared.claude.action}`);
  out.push(`  .claude/settings.json (hook entries, allow rules for ~/.shipline): ${shared.settings.action}`);
  out.push('', 'Config and workflows');
  if (cfgPlan.config) {
    out.push(`  ~ .shipline/config.yml: remove ${cfgPlan.config.keys.join(', ')}`);
    out.push(...cfgPlan.config.diff);
  }
  for (const w of cfgPlan.workflows) {
    out.push(`  ~ ${w.file}: remove ${w.entries} {artifact_root} allow_paths entr${w.entries === 1 ? 'y' : 'ies'}`);
    out.push(...w.diff);
  }
  if (!cfgPlan.config && !cfgPlan.workflows.length) out.push('  (no changes)');
  if (needsMigration) {
    out.push('', `Task data -> ${storePath}`);
    if (!mig.tasks.length && !mig.state.length) out.push('  (nothing to move)');
    for (const t of mig.tasks) out.push(`  move task ${t.rel}/ -> tasks/${t.name}/${hasGit ? ' (git rm staged afterwards)' : ''}`);
    if (mig.state.length) out.push(`  move ${mig.state.length} item(s) from .shipline/.state/ (session state, UI data); the folder is then removed`);
    if (mig.leftovers.length) out.push(`  left in place (not task folders): ${mig.leftovers.join(', ')}`);
    if (!hasGit && mig.tasks.length) out.push('  not a git repository: the old task folders are deleted from disk after the copies are verified, with no git rm');
  }
  if (mig.warnings.length) out.push('', 'Warnings', ...mig.warnings.map((w) => `  ! ${w}`));
  if (mig.problems.length) out.push('', 'Cannot upgrade yet. Nothing was changed:', ...mig.problems.map((p) => `  - ${p}`));
  console.log(out.join('\n'));

  if (mig.problems.length) return 1;
  if (dryRun) {
    console.log('\nDry run, nothing written.');
    return 0;
  }

  if (!yes) {
    if (!process.stdin.isTTY) {
      console.error('\nshipline: not a terminal, so there is nobody to confirm. Re-run with --yes to apply, or --dry-run to preview.');
      return 1;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question('\nApply these changes? [y/N] ')).trim().toLowerCase();
    rl.close();
    if (answer !== 'y' && answer !== 'yes') {
      console.log('Cancelled, nothing was changed.');
      return 1;
    }
  }

  try {
    apply(root, { files, shared, cfgPlan, mig, hasGit, artifactRoot });
  } catch (e) {
    console.error(`shipline: ${e.message}`);
    return 1;
  }

  console.log(`\nUpgraded to ${PACKAGE_VERSION} (interface ${INTERFACE}).${mig.tasks.length ? ` Moved ${mig.tasks.length} task(s) to ${storePath}.` : ''}

Next:
  - review and commit the changes${hasGit && mig.tasks.length ? ' (the removal of the old task folders is staged, not committed)' : ''};
  - restart any running Claude Code sessions so they pick up the new hooks.`);
  return 0;
}
