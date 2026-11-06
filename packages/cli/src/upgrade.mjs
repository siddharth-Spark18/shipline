// `shipline upgrade`: brings a repo that already has Shipline up to this version: refreshes the files Shipline
// owns that the team has not edited, and the shared CLAUDE.md block and settings entries. Never commits.
// Node 18+, no dependencies.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline/promises';
import { detectEol, toEol } from '../templates/shipline/bin/lib.mjs';
import {
  CI_WORKFLOW, CI_WORKFLOW_TEMPLATE, CLAUDE_MD_KEY, END, PACKAGE_VERSION, SETTINGS_KEY, START, TEMPLATES, VERSION_FILE,
  canonicalSettingsPart, claudeMdBlock, claudeMdSection, isShiplineHookEntry, ownedTemplateFiles, sha256, templateSettings,
} from './hashes.mjs';
import { INTERFACE, compareInterface, isPreOne, preOneMessage, readRepoVersion, semverGt } from './interface.mjs';
import { mergeSettingsObject, parseSettings } from './init.mjs';
import { KNOWN_STUB_RULES } from './known-stub-rules.mjs';

const require = createRequire(import.meta.url);
const KNOWN = require('./known-hashes.json');

const readText = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null);

// ---------- small helpers ----------

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
  const excluded = new Set(version.excluded || []);

  for (const f of owned) {
    if (excluded.has(f.to)) continue; // the team's own (or deliberately absent): never added or replaced
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

  // The optional CI workflow: updated only when the repo has it and it is Shipline's unedited copy; never added.
  const ciAbs = path.join(root, CI_WORKFLOW);
  if (existsSync(ciAbs) && lstatSync(ciAbs).isFile()) {
    const data = readFileSync(CI_WORKFLOW_TEMPLATE);
    const newHash = sha256(data);
    const current = readFileSync(ciAbs);
    const curHash = sha256(current);
    const knownCopy = Boolean(record && record[CI_WORKFLOW]) || Object.prototype.hasOwnProperty.call(KNOWN[CI_WORKFLOW] || {}, curHash);
    if (knownCopy) {
      if (curHash === newHash) {
        plan.same.push(CI_WORKFLOW);
        plan.hashes[CI_WORKFLOW] = newHash;
      } else if (isUnedited(curHash, CI_WORKFLOW, record) || force) {
        plan.replace.push({ to: CI_WORKFLOW, data, forced: !isUnedited(curHash, CI_WORKFLOW, record) });
        plan.hashes[CI_WORKFLOW] = newHash;
      } else {
        plan.skip.push({ to: CI_WORKFLOW, diff: lineDiff(current.toString('utf8'), data.toString('utf8')) });
        if (record && record[CI_WORKFLOW]) plan.hashes[CI_WORKFLOW] = record[CI_WORKFLOW];
      }
    }
  }

  // Shipline files that this version no longer ships: removed only when unedited.
  const candidates = new Set(record ? Object.keys(record) : Object.keys(KNOWN));
  for (const to of candidates) {
    if (ownedPaths.has(to) || excluded.has(to) || to === CLAUDE_MD_KEY || to === SETTINGS_KEY || to === CI_WORKFLOW) continue;
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
    const text = mdText === null ? section : toEol(mdText.replace(/\s*$/, '\n\n') + section, detectEol(mdText));
    shared.claude = { action: 'add', text };
    shared.hashes[CLAUDE_MD_KEY] = newBlockHash;
  } else if (sha256(curBlock) === newBlockHash) {
    shared.claude = { action: 'same' };
    shared.hashes[CLAUDE_MD_KEY] = newBlockHash;
  } else if (isUnedited(sha256(curBlock), CLAUDE_MD_KEY, record) || force) {
    const a = mdText.indexOf(START);
    const b = mdText.indexOf(END, a + START.length) + END.length;
    shared.claude = {
      action: 'replace',
      text: toEol(mdText.slice(0, a) + section.trimEnd() + mdText.slice(b), detectEol(mdText)),
    };
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
    // The read_credentials rail needs the PreToolUse matcher to include Read and Grep.
    const pre = settings && settings.hooks && Array.isArray(settings.hooks.PreToolUse) ? settings.hooks.PreToolUse.filter(isShiplineHookEntry) : [];
    shared.readNotGuarded = !pre.some((e) => e && typeof e.matcher === 'string' && ['Read', 'Grep'].every((t) => e.matcher.split('|').includes(t)));
  }
  return shared;
}

const normalizeLf = (text) => toEol(text, '\n');
const isStubRule = (file, text) => (KNOWN_STUB_RULES[file] || []).includes(sha256(normalizeLf(text)));

// The rules files: an untouched stub (one that matches a shipped version) gets the new default. A file the team
// edited is never overwritten. Missing files are not added.
// -> { write: [{ file, text, note }] }
function planRules(root) {
  const out = { write: [] };
  const dir = path.join(root, '.shipline', 'rules');
  const tplDir = path.join(TEMPLATES, 'shipline', 'rules');
  if (existsSync(tplDir)) {
    for (const f of readdirSync(tplDir).filter((n) => n.endsWith('.md')).sort()) {
      const cur = readText(path.join(dir, f));
      if (cur === null || !isStubRule(f, cur)) continue;
      const next = toEol(readFileSync(path.join(tplDir, f), 'utf8'), detectEol(cur));
      if (next === cur) continue;
      out.write.push({ file: f, text: next, note: 'unedited stub replaced by the new default' });
    }
  }
  return out;
}

// ---------- applying ----------

class StepError extends Error {
  constructor(step, cause, extra = '') {
    super(`${step}: ${cause && cause.message ? cause.message : cause}${extra}`);
    this.step = step;
  }
}

function apply(root, ctx) {
  const { files, shared, rulesPlan } = ctx;
  let step = 'writing files';
  try {
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
    for (const r of rulesPlan.write) writeFileSync(path.join(root, '.shipline', 'rules', r.file), r.text);

    step = 'writing .shipline/bin/VERSION';
    const newVersion = { package: PACKAGE_VERSION, interface: INTERFACE, files: sortKeys({ ...files.hashes, ...shared.hashes }), excluded: ctx.excluded };
    writeFileSync(path.join(root, VERSION_FILE), JSON.stringify(newVersion, null, 2) + '\n');
  } catch (e) {
    throw new StepError(`upgrade failed while ${step}`, e, '\n.shipline/bin/VERSION was not rewritten, so the repo still reports its old version.');
  }
}

function sortKeys(o) {
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
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
  // 1.0 is the first version with an upgrade path. Older repos (including ones with no VERSION file) start over.
  if (isPreOne(version)) {
    console.error(`shipline: ${preOneMessage(version)} Nothing was changed.`);
    return 1;
  }
  const rel = compareInterface(version, INTERFACE);
  if (rel === 'repo-newer' || (rel === 'same' && semverGt(version.package, PACKAGE_VERSION))) {
    const v = version.package || `interface ${version.interface}`;
    console.error(`shipline: this repo was set up with Shipline ${v}, which is newer than this CLI (${PACKAGE_VERSION}). Run \`npx @forgeyard/shipline@${version.package || 'latest'} ...\` instead. Nothing was changed.`);
    return 1;
  }

  let files;
  let shared;
  let rulesPlan;
  try {
    files = planFiles(root, version, force);
    shared = planShared(root, version, force);
    rulesPlan = planRules(root);
  } catch (e) {
    console.error(`shipline: ${e.message}`);
    return 1;
  }

  const excluded = [...(version.excluded || [])];
  const newVersion = { package: PACKAGE_VERSION, interface: INTERFACE, files: sortKeys({ ...files.hashes, ...shared.hashes }), excluded };
  const oldVersion = { package: version.package, interface: version.interface, files: version.files ? sortKeys(version.files) : null, excluded };
  const versionChanged = JSON.stringify(newVersion) !== JSON.stringify(oldVersion);

  const sharedActions = [shared.claude, shared.settings].filter((s) => s.action !== 'same' && s.action !== 'skip');
  const skipped = [...files.skip, ...(shared.claude.action === 'skip' ? [{ to: 'CLAUDE.md (Shipline block)', diff: shared.claude.diff }] : []), ...(shared.settings.action === 'skip' ? [{ to: '.claude/settings.json (Shipline hook entries and allow rules)', diff: shared.settings.diff }] : [])];
  const nothingToDo = !files.add.length && !files.replace.length && !files.remove.length && !sharedActions.length && !rulesPlan.write.length && !versionChanged;

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
  out.push('', 'Rules');
  for (const r of rulesPlan.write) out.push(`  ~ .shipline/rules/${r.file}: ${r.note}`);
  if (!rulesPlan.write.length) out.push('  (no changes)');

  const warnings = [];
  if (shared.readNotGuarded) {
    warnings.push('Your Shipline hook entries in .claude/settings.json were edited, so reading credential files (the Read and Grep tools) is not guarded. Add Read and Grep to the PreToolUse matcher to enable it.');
  }
  if (warnings.length) out.push('', 'Warnings', ...warnings.map((w) => `  ! ${w}`));
  console.log(out.join('\n'));

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
    apply(root, { files, shared, rulesPlan, excluded });
  } catch (e) {
    console.error(`shipline: ${e.message}`);
    return 1;
  }

  console.log(`\nUpgraded to ${PACKAGE_VERSION} (interface ${INTERFACE}).

Next:
  - review and commit the changes;
  - restart any running Claude Code sessions so they pick up the new hooks.`);
  return 0;
}
