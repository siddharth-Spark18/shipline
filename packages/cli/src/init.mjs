import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { INTERFACE } from './interface.mjs';
import {
  CLAUDE_MD_KEY, HOOK_MARK, PACKAGE_VERSION, SETTINGS_KEY, START, VERSION_FILE,
  canonicalSettingsPart, claudeMdBlock, claudeMdSection, isShiplineHookEntry, ownedTemplateFiles, sha256,
  templateFiles, templateSettings,
} from './hashes.mjs';
import { storeDir } from './store.mjs';

function readIfExists(file) {
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

// Parses and checks .claude/settings.json (text may be null or empty).
export function parseSettings(existingText) {
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
  if (settings.permissions !== undefined && (settings.permissions === null || typeof settings.permissions !== 'object' || Array.isArray(settings.permissions))) {
    throw new Error('.claude/settings.json has a "permissions" value that is not an object; nothing was written.');
  }
  if (settings.permissions && settings.permissions.allow !== undefined && !Array.isArray(settings.permissions.allow)) {
    throw new Error('.claude/settings.json permissions.allow is not an array; nothing was written.');
  }
  for (const event of Object.keys(settings.hooks)) {
    if (!Array.isArray(settings.hooks[event])) {
      throw new Error(`.claude/settings.json hooks.${event} is not an array; nothing was written.`);
    }
  }
  return settings;
}

// Adds Shipline's hook entries and allow rules to the parsed settings. With replace: true (upgrade),
// Shipline's existing hook entries are swapped for the template's in place; without it they are appended.
// Other entries and existing allow rules are left alone, and no rule is added twice.
export function mergeSettingsObject(settings, template, { replace = false } = {}) {
  for (const [event, entries] of Object.entries(template.hooks)) {
    const current = settings.hooks[event] === undefined ? [] : settings.hooks[event];
    if (!Array.isArray(current)) {
      throw new Error(`.claude/settings.json hooks.${event} is not an array; nothing was written.`);
    }
    if (replace && current.some(isShiplineHookEntry)) {
      const next = [];
      let placed = false;
      for (const e of current) {
        if (!isShiplineHookEntry(e)) next.push(e);
        else if (!placed) {
          next.push(...entries);
          placed = true;
        }
      }
      settings.hooks[event] = next;
    } else {
      settings.hooks[event] = [...current, ...entries];
    }
  }
  const rules = (template.permissions && template.permissions.allow) || [];
  if (rules.length) {
    if (!settings.permissions) settings.permissions = {};
    const allow = settings.permissions.allow || [];
    settings.permissions.allow = [...allow, ...rules.filter((r) => !allow.includes(r))];
  }
  return settings;
}

function mergeSettings(existingText, template) {
  return JSON.stringify(mergeSettingsObject(parseSettings(existingText), template), null, 2) + '\n';
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
    console.log('Shipline is already initialized in this repo (found .shipline/, the CLAUDE.md block or the hooks). Nothing to do.\nRun /shipline-setup in Claude Code to customize it, or `npx @forgeyard/shipline upgrade` to update it.');
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
    newSettings = mergeSettings(settingsText, templateSettings());
  } catch (e) {
    console.error(`shipline: init aborted. ${e.message}`);
    return 1;
  }
  const section = claudeMdSection();
  const newClaudeMd = claudeMd === null ? section : claudeMd.replace(/\s*$/, '\n\n') + section;

  if (!dryRun) {
    // The store must be writable before anything is installed (SHIPLINE_HOME, or ~/.shipline).
    try {
      storeDir(root);
    } catch (e) {
      console.error(`shipline: ${e.message}`);
      return 1;
    }
  }

  if (dryRun) {
    console.log('Dry run, nothing written. Would create:');
    for (const f of files) console.log(`  + ${f.to}`);
    console.log(`  + ${VERSION_FILE}`);
    console.log(`  ${settingsText === null ? '+' : '~'} .claude/settings.json (hooks and allow rules merged)`);
    console.log(`  ${claudeMd === null ? '+' : '~'} CLAUDE.md (marked block ${claudeMd === null ? 'created' : 'appended'})`);
    return 0;
  }

  // Write, rolling back on failure so a half-written install never remains.
  const created = [];
  const written = {};
  try {
    for (const f of files) {
      const abs = path.join(root, f.to);
      mkdirSync(path.dirname(abs), { recursive: true });
      const data = readFileSync(f.from);
      writeFileSync(abs, data, { flag: 'wx' });
      written[f.to] = sha256(data);
      created.push(abs);
    }
    mkdirSync(path.dirname(settingsFile), { recursive: true });
    writeFileSync(settingsFile, newSettings);
    writeFileSync(claudeMdFile, newClaudeMd);
    // Last write: if anything above failed, VERSION is never written.
    const versionAbs = path.join(root, VERSION_FILE);
    const owned = new Set(ownedTemplateFiles().map((f) => f.to));
    const fileHashes = Object.fromEntries(Object.entries(written).filter(([to]) => owned.has(to)));
    fileHashes[CLAUDE_MD_KEY] = sha256(claudeMdBlock(newClaudeMd));
    fileHashes[SETTINGS_KEY] = sha256(canonicalSettingsPart(JSON.parse(newSettings)));
    writeFileSync(versionAbs, JSON.stringify({ package: PACKAGE_VERSION, interface: INTERFACE, files: fileHashes }, null, 2) + '\n', { flag: 'wx' });
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
  ${settingsText === null ? 'created' : 'merged hooks and allow rules into'} .claude/settings.json
  ${claudeMd === null ? 'created' : 'appended a marked block to'} CLAUDE.md

Next: open Claude Code in this repo and run /shipline-setup to customize workflows, rules and enforcement.
Or set it up in the browser: \`npx @forgeyard/shipline ui\`.
Then commit .shipline/, .claude/ and CLAUDE.md so teammates get the same flow on clone (Node 18+ required).`);
  return 0;
}
