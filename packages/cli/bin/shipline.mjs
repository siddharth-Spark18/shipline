#!/usr/bin/env node
import { runInit } from '../src/init.mjs';
import { runUninstall } from '../src/uninstall.mjs';
import { runUpgrade } from '../src/upgrade.mjs';

const major = Number(process.versions.node.split('.')[0]);
if (major < 18) {
  console.error(`shipline requires Node 18 or newer (found ${process.versions.node}).`);
  process.exit(1);
}

const [cmd, ...rest] = process.argv.slice(2);
const HELP = `shipline - repo-installed Claude Code workflow

Usage:
  npx @forgeyard/shipline init [dir] [--yes] [--dry-run]   Vendor .shipline/, .claude/ files, hooks and a CLAUDE.md section into a repo
  npx @forgeyard/shipline upgrade [dir] [--yes] [--dry-run] [--force]   Update an installed repo and move its tasks to ~/.shipline
  npx @forgeyard/shipline uninstall [dir] [--yes] [--dry-run] [--purge]   Remove everything init installed from a repo
  npx @forgeyard/shipline ui [dir] [--port <n>] [--no-open]   Local web UI for setup and tasks (Node 20+)

init asks which workflows, agents and repo skills to use (in a terminal); --yes installs the defaults and keeps
your own agent files on a name clash. It aborts with nothing written if any other file name collides.
uninstall previews, then asks; it deletes files only (commit the removal yourself) and keeps your task data
unless you answer yes or pass --yes --purge.
upgrade shows a preview first; files your team edited are skipped unless --force.`;

if (cmd === 'ui') {
  if (major < 20) {
    console.error(`shipline ui requires Node 20 or newer (found ${process.versions.node}).`);
    process.exit(1);
  }
  // Loaded only here, so `init` on Node 18 never loads Node-20-only code.
  const { parseUiArgs, startServer } = await import('../src/ui/server.mjs');
  await startServer(parseUiArgs(rest));
} else if (cmd === 'init') {
  process.exitCode = await runInit({
    target: rest.find((a) => !a.startsWith('--')) || process.cwd(),
    dryRun: rest.includes('--dry-run'),
    yes: rest.includes('--yes'),
  });
} else if (cmd === 'uninstall') {
  process.exitCode = await runUninstall({
    target: rest.find((a) => !a.startsWith('--')) || process.cwd(),
    yes: rest.includes('--yes'),
    dryRun: rest.includes('--dry-run'),
    purge: rest.includes('--purge'),
  });
} else if (cmd === 'upgrade') {
  process.exitCode = await runUpgrade({
    target: rest.find((a) => !a.startsWith('--')) || process.cwd(),
    yes: rest.includes('--yes'),
    dryRun: rest.includes('--dry-run'),
    force: rest.includes('--force'),
  });
} else {
  console.log(HELP);
  process.exitCode = !cmd || cmd === '--help' || cmd === 'help' || cmd === '-h' ? 0 : 1;
}
