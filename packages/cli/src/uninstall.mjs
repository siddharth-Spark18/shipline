// `shipline uninstall`: removes everything `init` installed from a repo. Only deletes files from disk (never
// runs git), so the developer commits the removal. Node 18+, no dependencies.
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  CLAUDE_MD_KEY, SETTINGS_KEY, VERSION_FILE, ownedTemplateFiles, removeClaudeMdBlock, removeShiplineFromSettings,
} from './hashes.mjs';
import { parseSettings } from './init.mjs';
import { encodePath, shiplineHome } from './store.mjs';
import { pidAlive, readLock } from './ui/sessions.mjs';

const readText = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null);
const posix = (p) => p.split(path.sep).join('/');

// Read-only: the repo's store folder (nothing is created), or null when it doesn't exist yet.
function peekStore(root) {
  let real = root;
  try {
    real = realpathSync(root);
  } catch {
    // Keep the given path.
  }
  const dir = path.join(shiplineHome(), 'projects', encodePath(real));
  return existsSync(dir) ? dir : null;
}

function dirSize(dir) {
  let total = 0;
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) total += dirSize(full);
      else if (e.isFile()) total += statSync(full).size;
    }
  } catch {
    // Unreadable entries are not counted.
  }
  return total;
}

function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// True when every file under dir is in `gone` (a Set of absolute paths), so the folder ends up empty.
function emptiedBy(dir, gone) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory() ? !emptiedBy(full, gone) : !gone.has(full)) return false;
  }
  return true;
}

function readVersionFiles(root) {
  const text = readText(path.join(root, VERSION_FILE));
  if (text === null) return null;
  try {
    const v = JSON.parse(text);
    // A VERSION without a `files` map (0.6.0 and earlier) records nothing: treat it like a legacy
    // install, so the template inventory and the shipline-* skill scan are used instead.
    if (v && typeof v === 'object' && v.files && typeof v.files === 'object' && !Array.isArray(v.files)) {
      return {
        files: Object.keys(v.files),
        excluded: Array.isArray(v.excluded) ? v.excluded.filter((p) => typeof p === 'string') : [],
      };
    }
  } catch {
    // Unreadable: treated like a legacy install below.
  }
  return null;
}

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(question)).trim().toLowerCase();
  rl.close();
  return answer === 'y' || answer === 'yes';
}

// Returns a process exit code.
export async function runUninstall({ target, yes = false, dryRun = false, purge = false } = {}) {
  const root = path.resolve(target || process.cwd());
  if (!existsSync(root) || !lstatSync(root).isDirectory()) {
    console.error(`shipline: ${root} is not a directory.`);
    return 1;
  }
  const shipDir = path.join(root, '.shipline');
  if (!existsSync(shipDir)) {
    console.error('shipline: Shipline is not installed here (no .shipline/ found).');
    return 1;
  }

  // A live UI chat holds the repo's lock; a stale one (dead process, other host) only gets a note.
  const store = peekStore(root);
  const notes = [];
  if (store) {
    const lock = readLock(root);
    if (lock && typeof lock === 'object') {
      if (lock.hostname === os.hostname() && Number.isInteger(lock.pid) && pidAlive(lock.pid)) {
        console.error(`shipline: Stop the Shipline UI for this repo first (port ${lock.port}). Nothing was changed.`);
        return 1;
      }
      notes.push('a stale UI lock was found (its process is gone); it is removed with the store data, if you choose to delete that');
    }
  }

  // ---- build the removal list ----
  const version = readVersionFiles(root);
  const excluded = new Set(version ? version.excluded : []);
  const candidates = version ? version.files : ownedTemplateFiles().map((f) => f.to);
  const files = [];
  for (const rel of new Set(candidates)) {
    if (rel === CLAUDE_MD_KEY || rel === SETTINGS_KEY || rel.includes('#')) continue;
    if (excluded.has(rel)) continue;
    if (!/^\.claude\//.test(rel) || rel.split('/').includes('..')) continue; // .shipline/ goes as a whole
    const abs = path.join(root, rel);
    if (existsSync(abs) && lstatSync(abs).isFile()) files.push(rel);
  }
  const skillsDir = path.join(root, '.claude', 'skills');
  if (existsSync(skillsDir)) {
    for (const e of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!e.isDirectory() || !e.name.startsWith('shipline-')) continue;
      const base = path.join(skillsDir, e.name);
      if (version && excluded.has(`.claude/skills/${e.name}`)) continue;
      // A legacy install has no record, so every file under a shipline-* skill folder is Shipline's.
      if (!version) {
        const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((x) => (x.isDirectory() ? walk(path.join(d, x.name)) : [path.join(d, x.name)]));
        for (const f of walk(base)) {
          const rel = posix(path.relative(root, f));
          if (!files.includes(rel) && !excluded.has(rel)) files.push(rel);
        }
      }
    }
  }
  files.sort();
  const gone = new Set(files.map((f) => path.join(root, f)));
  const emptyDirs = [];
  if (existsSync(skillsDir)) {
    for (const e of readdirSync(skillsDir, { withFileTypes: true })) {
      const full = path.join(skillsDir, e.name);
      if (e.isDirectory() && e.name.startsWith('shipline-') && emptiedBy(full, gone)) emptyDirs.push(posix(path.relative(root, full)) + '/');
    }
  }

  // settings.json (hook entries and allow rules)
  const settingsFile = path.join(root, '.claude', 'settings.json');
  const settingsText = readText(settingsFile);
  let settingsEdit = null; // { text } or { remove: true }
  if (settingsText !== null) {
    let settings;
    try {
      settings = parseSettings(settingsText);
    } catch (e) {
      console.error(`shipline: ${e.message.replace('nothing was written', 'nothing was changed')} Fix .claude/settings.json first.`);
      return 1;
    }
    const { removed } = removeShiplineFromSettings(settings);
    if (removed > 0) {
      settingsEdit = Object.keys(settings).length === 0 ? { remove: true, removed } : { text: JSON.stringify(settings, null, 2) + '\n', removed };
    } else notes.push('.claude/settings.json has no Shipline hook entries or allow rules; left as it is');
  }

  // CLAUDE.md block
  const claudeFile = path.join(root, 'CLAUDE.md');
  const claudeText = readText(claudeFile);
  const claudeNext = claudeText === null ? null : removeClaudeMdBlock(claudeText);
  if (claudeText !== null && claudeNext === null) notes.push('CLAUDE.md has no Shipline markers (removed by hand?); left as it is');

  // ---- preview ----
  const out = [`Shipline uninstall for ${root}`];
  if (!version) out.push('  (no .shipline/bin/VERSION: using Shipline\'s template inventory)');
  out.push('', 'Will remove');
  out.push('  - .shipline/ (config, workflows, rules and hooks)');
  for (const f of files) out.push(`  - ${f}`);
  for (const d of emptyDirs) out.push(`  - ${d} (left empty)`);
  if (claudeNext !== null) out.push(`  ~ CLAUDE.md: remove the Shipline block${claudeNext === '' ? ' (the file is then empty and is deleted)' : ''}`);
  if (settingsEdit) out.push(`  ~ .claude/settings.json: remove ${settingsEdit.removed} Shipline hook entr${settingsEdit.removed === 1 ? 'y/rule' : 'ies and rules'}${settingsEdit.remove ? ' (the file is then empty and is deleted)' : ''}`);
  if (excluded.size) {
    out.push('', 'Kept (your own, recorded in VERSION.excluded)');
    for (const p of [...excluded].sort()) out.push(`  = ${p}`);
  }
  if (store) out.push('', `Task data for this repo (asked about separately): ${store} (${human(dirSize(store))})`);
  if (notes.length) out.push('', 'Notes', ...notes.map((n) => `  ! ${n}`));
  console.log(out.join('\n'));

  if (dryRun) {
    console.log('\nDry run, nothing written.');
    return 0;
  }

  let deleteStore = false;
  if (!yes) {
    if (!process.stdin.isTTY) {
      console.error('\nshipline: not a terminal, so there is nobody to confirm. Re-run with --yes to apply, or --dry-run to preview.');
      return 1;
    }
    if (!(await ask('\nRemove these? [y/N] '))) {
      console.log('Cancelled, nothing was changed.');
      return 1;
    }
    if (store) deleteStore = await ask(`Also delete this repo's task data at ${store}? [y/N] `);
  } else deleteStore = Boolean(store) && purge;

  // ---- apply: shared files, then Shipline's files, then .shipline/ last, then the store ----
  try {
    if (settingsEdit) {
      if (settingsEdit.remove) rmSync(settingsFile, { force: true });
      else writeFileSync(settingsFile, settingsEdit.text);
    }
    if (claudeNext !== null) {
      if (claudeNext === '') rmSync(claudeFile, { force: true });
      else writeFileSync(claudeFile, claudeNext);
    }
    for (const f of files) rmSync(path.join(root, f), { force: true });
    for (const f of files) {
      let d = path.dirname(path.join(root, f));
      while (d !== root && d.startsWith(root + path.sep)) {
        try {
          rmdirSync(d); // only succeeds when empty
        } catch {
          break;
        }
        d = path.dirname(d);
      }
    }
    if (settingsEdit && settingsEdit.remove) {
      try {
        rmdirSync(path.join(root, '.claude'));
      } catch {
        // Not empty: other files of the team's.
      }
    }
    rmSync(shipDir, { recursive: true, force: true });
    if (deleteStore) rmSync(store, { recursive: true, force: true });
  } catch (e) {
    console.error(`shipline: uninstall failed (${e.message}). Some files may already be removed; run uninstall again to finish.`);
    return 1;
  }

  console.log(`\nRemoved. Commit the deletion so teammates no longer get Shipline.${store && !deleteStore ? `\nTask data was kept at ${store}.` : ''}
Any Claude Code session already open in this repo will show hook warnings until it is restarted.`);
  return 0;
}
