#!/usr/bin/env node
import { runInit } from '../src/init.mjs';

const major = Number(process.versions.node.split('.')[0]);
if (major < 18) {
  console.error(`shipline requires Node 18 or newer (found ${process.versions.node}).`);
  process.exit(1);
}

const [cmd, ...rest] = process.argv.slice(2);
const HELP = `shipline - repo-installed Claude Code workflow

Usage:
  npx shipline init [dir] [--dry-run]   Vendor .shipline/, .claude/ files, hooks and a CLAUDE.md section into a repo
  npx shipline ui [dir] [--port <n>] [--no-open]   Local web UI for setup and tasks (Node 20+)

Nothing is overwritten: init aborts with nothing written if any file name collides.`;

if (cmd === 'ui') {
  if (major < 20) {
    console.error(`shipline ui requires Node 20 or newer (found ${process.versions.node}).`);
    process.exit(1);
  }
  // Loaded only here, so `init` on Node 18 never loads Node-20-only code.
  const { parseUiArgs, startServer } = await import('../src/ui/server.mjs');
  await startServer(parseUiArgs(rest));
} else if (cmd === 'init') {
  process.exitCode = runInit({
    target: rest.find((a) => !a.startsWith('--')) || process.cwd(),
    dryRun: rest.includes('--dry-run'),
  });
} else {
  console.log(HELP);
  process.exitCode = !cmd || cmd === '--help' || cmd === 'help' || cmd === '-h' ? 0 : 1;
}
