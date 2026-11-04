import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INTERFACE } from './interface.mjs';

const TEMPLATES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');
const START = '<!-- shipline:start -->';
const END = '<!-- shipline:end -->';
const HOOK_MARK = '.shipline/bin/';
const VERSION_FILE = '.shipline/bin/VERSION';
const PACKAGE_VERSION = JSON.parse(readFileSync(path.join(TEMPLATES, '..', 'package.json'), 'utf8')).version;

function walk(dir, base = dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

// templates/shipline/** -> .shipline/**, templates/claude/** -> .claude/**.
// "gitignore" is stored without the dot because npm drops .gitignore files from packages.
function templateFiles() {
  const files = [];
  for (const [src, dest] of [['shipline', '.shipline'], ['claude', '.claude']]) {
    for (const rel of walk(path.join(TEMPLATES, src))) {
      const mapped = rel.replace(/(^|\/)gitignore$/, '$1.gitignore');
      files.push({ from: path.join(TEMPLATES, src, rel), to: `${dest}/${mapped}` });
    }
  }
  return files;
}

function readIfExists(file) {
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

function mergeSettings(existingText, templateHooks) {
  let settings = {};
  if (existingText !== null && existingText.trim() !== '') {
    try {
      settings = JSON.parse(existingText);
    } catch (e) {
      throw new Error(`.claude/settings.json is not valid JSON (${e.message}). Fix it first; nothing was written.`);
    }
    if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
      throw new Error('.claude/settings.json is not a JSON object; nothing was written.');
    }
  }
  if (settings.hooks === undefined) settings.hooks = {};
  if (settings.hooks === null || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
    throw new Error('.claude/settings.json has a "hooks" value that is not an object; nothing was written.');
  }
  for (const [event, entries] of Object.entries(templateHooks)) {
    if (settings.hooks[event] === undefined) settings.hooks[event] = [];
    if (!Array.isArray(settings.hooks[event])) {
      throw new Error(`.claude/settings.json hooks.${event} is not an array; nothing was written.`);
    }
    settings.hooks[event].push(...entries);
  }
  return JSON.stringify(settings, null, 2) + '\n';
}

function hasShiplineHooks(settingsText) {
  return settingsText !== null && settingsText.includes(HOOK_MARK);
}

// Returns a process exit code. Preflights everything, then writes.
export function runInit({ target, dryRun = false }) {
  const root = path.resolve(target);
  if (!existsSync(root) || !lstatSync(root).isDirectory()) {
    console.error(`shipline: ${root} is not a directory.`);
    return 1;
  }

  const settingsFile = path.join(root, '.claude', 'settings.json');
  const claudeMdFile = path.join(root, 'CLAUDE.md');
  const settingsText = readIfExists(settingsFile);
  const claudeMd = readIfExists(claudeMdFile);

  // Already initialized?
  if (existsSync(path.join(root, '.shipline', 'config.yml')) || (claudeMd && claudeMd.includes(START)) || hasShiplineHooks(settingsText)) {
    console.log('Shipline is already initialized in this repo (found .shipline/, the CLAUDE.md block or the hooks). Nothing to do.\nRun /shipline-setup in Claude Code to customize it.');
    return 0;
  }

  // Preflight: nothing is written until every check passes.
  const files = templateFiles();
  const collisions = [];
  for (const f of [...files, { to: VERSION_FILE }]) {
    const abs = path.join(root, f.to);
    if (existsSync(abs)) {
      collisions.push(f.to);
      continue;
    }
    // A parent that exists as a file would also make the write fail.
    let p = path.dirname(abs);
    while (p.startsWith(root) && p !== root) {
      if (existsSync(p) && !lstatSync(p).isDirectory()) {
        collisions.push(path.relative(root, p));
        break;
      }
      p = path.dirname(p);
    }
  }
  for (const [file, label] of [[settingsFile, '.claude/settings.json'], [claudeMdFile, 'CLAUDE.md']]) {
    if (existsSync(file) && lstatSync(file).isDirectory()) collisions.push(label);
  }
  if (collisions.length) {
    console.error('shipline: init aborted, nothing was written. These paths already exist:\n' + [...new Set(collisions)].map((c) => `  - ${c}`).join('\n'));
    console.error('\nRename or move them (or the colliding agent/skill names), then run init again.');
    return 1;
  }

  let newSettings;
  try {
    newSettings = mergeSettings(settingsText, JSON.parse(readFileSync(path.join(TEMPLATES, 'settings-hooks.json'), 'utf8')).hooks);
  } catch (e) {
    console.error(`shipline: init aborted. ${e.message}`);
    return 1;
  }
  const section = readFileSync(path.join(TEMPLATES, 'claude-md-section.md'), 'utf8').trimEnd() + '\n';
  const newClaudeMd = claudeMd === null ? section : claudeMd.replace(/\s*$/, '\n\n') + section;

  if (dryRun) {
    console.log('Dry run, nothing written. Would create:');
    for (const f of files) console.log(`  + ${f.to}`);
    console.log(`  + ${VERSION_FILE}`);
    console.log(`  ${settingsText === null ? '+' : '~'} .claude/settings.json (hooks merged)`);
    console.log(`  ${claudeMd === null ? '+' : '~'} CLAUDE.md (marked block ${claudeMd === null ? 'created' : 'appended'})`);
    return 0;
  }

  // Write, rolling back on failure so a half-written install never remains.
  const created = [];
  try {
    for (const f of files) {
      const abs = path.join(root, f.to);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, readFileSync(f.from), { flag: 'wx' });
      created.push(abs);
    }
    mkdirSync(path.dirname(settingsFile), { recursive: true });
    writeFileSync(settingsFile, newSettings);
    writeFileSync(claudeMdFile, newClaudeMd);
    // Last write: if anything above failed, VERSION is never written.
    const versionAbs = path.join(root, VERSION_FILE);
    writeFileSync(versionAbs, JSON.stringify({ package: PACKAGE_VERSION, interface: INTERFACE }) + '\n', { flag: 'wx' });
    created.push(versionAbs);
  } catch (e) {
    for (const abs of created) rmSync(abs, { force: true });
    if (settingsText === null) rmSync(settingsFile, { force: true });
    else writeFileSync(settingsFile, settingsText);
    if (claudeMd === null) rmSync(claudeMdFile, { force: true });
    else writeFileSync(claudeMdFile, claudeMd);
    console.error(`shipline: init failed while writing (${e.message}); changes were rolled back.`);
    return 1;
  }

  console.log(`Shipline initialized in ${root}

  created ${files.length} files under .shipline/ and .claude/
  ${settingsText === null ? 'created' : 'merged hooks into'} .claude/settings.json
  ${claudeMd === null ? 'created' : 'appended a marked block to'} CLAUDE.md

Next: open Claude Code in this repo and run /shipline-setup to customize workflows, rules and enforcement.
Or set it up in the browser: \`npx shipline ui\`.
Then commit .shipline/, .claude/ and CLAUDE.md so teammates get the same flow on clone (Node 18+ required).`);
  return 0;
}
