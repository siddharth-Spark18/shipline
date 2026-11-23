// `shipline relink --from <old path>`: a repo moved (or was renamed); gives it back the task store of its old path.
// Moves the old store folder to this repo's key, never deleting task data. Node 22+, no dependencies.
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { registerQuietly, relinkProject } from './registry.mjs';
import { encodePath, mainRoot, sameRoot, shiplineHome, storeCandidates, storeKey, storeScheme } from './store.mjs';

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

// The real path of a folder that may be gone: its deepest existing ancestor's realpath plus the rest.
function realIfPossible(p) {
  const abs = path.resolve(p);
  const rest = [];
  let cur = abs;
  for (;;) {
    try {
      return path.join(realpathSync(cur), ...rest.reverse());
    } catch {
      const up = path.dirname(cur);
      if (up === cur) return abs;
      rest.push(path.basename(cur));
      cur = up;
    }
  }
}

function taskCount(dir) {
  try {
    return readdirSync(path.join(dir, 'tasks'), { withFileTypes: true }).filter((e) => e.isDirectory()).length;
  } catch {
    return 0;
  }
}

// True when the folder holds nothing but repo.json and empty folders (a store that was only just created).
function trivial(dir, top = true) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!trivial(path.join(dir, e.name), false)) return false;
    } else if (!top || e.name !== 'repo.json') return false;
  }
  return true;
}

// Returns a process exit code.
export async function runRelink({ target, from, dryRun = false } = {}) {
  const root = path.resolve(target || process.cwd());
  if (!from) {
    console.error('shipline: relink needs the repo\'s old path: shipline relink --from <old path> (see shipline relink --help)');
    return 2;
  }
  if (!existsSync(path.join(root, '.shipline', 'config.yml'))) {
    console.error(`shipline: no .shipline/ found in ${root}. Run relink in the moved repo (or pass --dir).`);
    return 1;
  }
  const real = realIfPossible(root);
  const old = realIfPossible(from);
  if (sameRoot(old, real)) {
    console.error('shipline: --from is this folder itself; nothing to relink.');
    return 1;
  }
  if (existsSync(old)) {
    console.error(`shipline: ${old} still exists, so the repo did not move from there. Nothing was changed.`);
    return 1;
  }

  // The store the old path had, under either key scheme.
  const projects = path.join(shiplineHome(), 'projects');
  const found = [storeKey(old), encodePath(old)]
    .map((name) => path.join(projects, name))
    .find((dir) => {
      const meta = readJson(path.join(dir, 'repo.json'));
      return meta && typeof meta.root === 'string' && sameRoot(meta.root, old);
    });
  if (!found) {
    console.error(`shipline: no task store belongs to ${old}. Nothing was changed. (\`ls ${projects}\` shows the stores; each repo.json names its repo.)`);
    return 1;
  }

  // Where this repo's store lives: by its installed interface.
  const scheme = storeScheme(real);
  const [fresh, legacy] = storeCandidates(real);
  const dest = (scheme >= 2 ? fresh : legacy).dir;
  const meta = readJson(path.join(found, 'repo.json')) || {};
  const tasks = taskCount(found);

  const destExists = existsSync(dest);
  if (destExists && taskCount(dest) > 0) {
    console.error(`shipline: this repo's store (${dest}) already has ${taskCount(dest)} task${taskCount(dest) === 1 ? '' : 's'}. Nothing was changed. Remove it with \`shipline prune\` once its repo is gone, or merge the two by hand.`);
    return 1;
  }

  console.log(`${dryRun ? 'Would move' : 'Moving'} the task store of ${old}\n  ${found} (${tasks} task${tasks === 1 ? '' : 's'})\n  -> ${dest}`);
  if (dryRun) {
    console.log('\nDry run, nothing changed.');
    return 0;
  }

  try {
    if (destExists) {
      if (trivial(dest)) rmSync(dest, { recursive: true, force: true });
      else renameSync(dest, `${dest}.migrated-${new Date().toISOString().slice(0, 10)}`); // kept, not deleted
    }
    mkdirSync(path.dirname(dest), { recursive: true });
    renameSync(found, dest);
    const next = { ...meta, root: scheme >= 2 ? mainRoot(real) : real };
    if (scheme >= 2) Object.assign(next, { main_root: next.root, key_version: 2 });
    else {
      delete next.main_root;
      delete next.key_version;
    }
    writeFileSync(path.join(dest, 'repo.json'), JSON.stringify(next, null, 2) + '\n');
  } catch (e) {
    console.error(`shipline: relink failed (${e.message}).`);
    return 1;
  }
  try {
    relinkProject(old, real);
  } catch (e) {
    console.warn(`shipline: could not update the project list (${e.message}).`);
    registerQuietly(real);
  }
  console.log(`\nDone. ${real} now has the ${tasks} task${tasks === 1 ? '' : 's'} of the old path. Run \`node .shipline/bin/stage.mjs status --all\` to see them.`);
  return 0;
}
