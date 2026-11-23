// `shipline prune`: removes the task stores of repos that are gone from disk (and old `.migrated-<date>` backups from
// the store key migration), after a preview. Never touches a store whose repo still has Shipline, or one that a
// registered, still existing checkout (a worktree) uses. Node 22+, no dependencies.
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { listProjects, unregisterProjects } from './registry.mjs';
import { peekStore, shiplineHome } from './store.mjs';
import { dirSize, human } from './uninstall.mjs';
import { pidAlive } from './ui/sessions.mjs';

const MIGRATED = /\.migrated-(\d{4}-\d{2}-\d{2})(?:-\d+)?$/;
const BACKUP_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

async function defaultAsk(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim().toLowerCase();
  } finally {
    rl.close();
  }
}

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

const hasShipline = (root) => existsSync(path.join(root, '.shipline', 'config.yml'));

function taskCount(dir) {
  try {
    return readdirSync(path.join(dir, 'tasks'), { withFileTypes: true }).filter((e) => e.isDirectory()).length;
  } catch {
    return 0;
  }
}

// Returns a process exit code. `now` and `ask` are injectable for tests.
export async function runPrune({ dryRun = false, yes = false, ask = defaultAsk, now = Date.now() } = {}) {
  const projectsDir = path.join(shiplineHome(), 'projects');
  let names = [];
  try {
    names = readdirSync(projectsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    // No store folder yet.
  }

  // Stores that a registered checkout, which still exists, resolves to stay (a shared store whose main checkout is gone).
  const inUse = new Map(); // store dir -> a checkout using it
  try {
    for (const p of listProjects()) {
      if (typeof p.root !== 'string' || !hasShipline(p.root)) continue;
      const dir = peekStore(p.root);
      if (dir && !inUse.has(dir)) inUse.set(dir, p.root);
    }
  } catch {
    // An unreadable project list only means fewer stores are known to be in use; roots are still checked below.
  }

  const remove = [];
  const kept = [];
  for (const name of names) {
    const dir = path.join(projectsDir, name);
    const migrated = MIGRATED.exec(name);
    if (migrated) {
      const when = Date.parse(migrated[1]);
      if (Number.isFinite(when) && now - when > BACKUP_MAX_AGE_MS) {
        remove.push({ name, dir, why: `store backup from the key migration (${migrated[1]})`, root: null, tasks: taskCount(dir), size: dirSize(dir) });
      }
      continue;
    }
    const meta = readJson(path.join(dir, 'repo.json'));
    if (!meta || typeof meta.root !== 'string') continue; // not a store
    // Only stores whose repo folder is gone. A repo that still exists keeps its store even without Shipline: uninstall
    // keeps it on purpose so a reinstall gets its tasks back (`uninstall --purge` removes it).
    if (existsSync(meta.root)) continue;
    if (inUse.has(dir)) {
      kept.push(`${name}: its repo folder is gone, but ${inUse.get(dir)} still uses this store`);
      continue;
    }
    const why = `repo folder is gone: ${meta.root}`;
    remove.push({ name, dir, why, root: meta.root, tasks: taskCount(dir), size: dirSize(dir) });
  }

  if (!remove.length) {
    for (const k of kept) console.log(`Kept: ${k}`);
    console.log('Nothing to prune.');
    return 0;
  }

  console.log('Stores to remove:');
  for (const r of remove) console.log(`  ${r.name}\n    ${r.why}; ${r.tasks} task${r.tasks === 1 ? '' : 's'}, ${human(r.size)}`);
  for (const k of kept) console.log(`Kept: ${k}`);

  // A running UI server with a chat open in one of these repos holds its lock.
  for (const r of remove) {
    const lock = readJson(path.join(r.dir, 'ui', 'lock.json'));
    if (lock && lock.hostname === os.hostname() && Number.isInteger(lock.pid) && pidAlive(lock.pid)) {
      console.error(`shipline: the Shipline UI (port ${lock.port}) has a chat active for ${r.root || r.name}. Stop it first. Nothing was removed.`);
      return 1;
    }
  }

  if (dryRun) {
    console.log('\nDry run, nothing removed.');
    return 0;
  }
  if (!yes) {
    if (!process.stdin.isTTY) {
      console.log('\nNot a terminal and no --yes, so this was a dry run. Re-run with --yes to remove these.');
      return 0;
    }
    const a = await ask(`\nRemove ${remove.length} store${remove.length === 1 ? '' : 's'}? [y/N] `);
    if (a !== 'y' && a !== 'yes') {
      console.log('Cancelled, nothing was removed.');
      return 0;
    }
  }

  let failed = 0;
  for (const r of remove) {
    try {
      rmSync(r.dir, { recursive: true, force: true });
    } catch (e) {
      failed++;
      console.error(`shipline: could not remove ${r.dir} (${e.message}).`);
    }
  }
  try {
    unregisterProjects(remove.filter((r) => r.root).map((r) => r.root));
  } catch (e) {
    console.warn(`shipline: could not update the project list (${e.message}).`);
  }
  console.log(`\nRemoved ${remove.length - failed} store${remove.length - failed === 1 ? '' : 's'}.`);
  return failed ? 1 : 0;
}
