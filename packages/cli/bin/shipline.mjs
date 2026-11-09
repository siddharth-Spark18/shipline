#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { runInit } from '../src/init.mjs';
import { runUninstall } from '../src/uninstall.mjs';
import { runUpgrade } from '../src/upgrade.mjs';

const major = Number(process.versions.node.split('.')[0]);
if (major < 18) {
  console.error(`shipline requires Node 18 or newer (found ${process.versions.node}).`);
  process.exit(1);
}

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const NPX = 'npx @forgeyard/shipline';

const HELP = `shipline - repo-installed Claude Code workflow

Usage:
  ${NPX} <command> [options]

Commands:
  init        Vendor .shipline/, .claude/ files, hooks and a CLAUDE.md section into a repo
  upgrade     Update an installed repo's Shipline files to this version
  uninstall   Remove everything init installed from a repo
  ui          Local web UI for setup and tasks (Node 20+)

Options:
  -h, --help      Show help (also per command: ${NPX} <command> --help)
  -v, --version   Print the version

The target folder is the current directory, or the one given with --dir <path>.`;

const DIR = '  --dir <path>   Target folder (default: the current directory)';
const COMMANDS = {
  init: {
    flags: { '--yes': 'yes', '-y': 'yes', '--dry-run': 'dryRun', '--terminal': 'terminal' },
    help: `Usage: ${NPX} init [--dir <path>] [--yes] [--dry-run] [--terminal]

Vendors .shipline/, .claude/ files, hooks and a CLAUDE.md section into a repo.

Options:
${DIR}
  -y, --yes      Install the defaults without asking (keeps your own agent files on a name clash)
  --dry-run      Show what would be created; without a terminal it shows what --yes would install
  --terminal     Ask the questions here instead of opening the setup wizard in the browser
  -h, --help     Show this help

In a terminal init opens the setup wizard in your browser (Node 20+). With --terminal it asks the same questions
here, shows a review of what it will write, and asks before writing. It aborts with nothing written if any
other file name collides.`,
  },
  upgrade: {
    flags: { '--yes': 'yes', '-y': 'yes', '--dry-run': 'dryRun', '--force': 'force' },
    help: `Usage: ${NPX} upgrade [--dir <path>] [--yes] [--dry-run] [--force]

Updates an installed repo's Shipline files to this version. It shows a preview first; files your team edited are
skipped unless --force.

Options:
${DIR}
  -y, --yes      Apply without asking
  --dry-run      Show the preview and stop
  --force        Replace files your team edited
  -h, --help     Show this help`,
  },
  uninstall: {
    flags: { '--yes': 'yes', '-y': 'yes', '--dry-run': 'dryRun', '--purge': 'purge' },
    help: `Usage: ${NPX} uninstall [--dir <path>] [--yes] [--dry-run] [--purge]

Removes everything init installed from a repo. It previews, then asks; it deletes files only (commit the removal
yourself) and keeps your task data unless you answer yes or pass --yes --purge.

Options:
${DIR}
  -y, --yes      Don't ask
  --dry-run      Show the preview and stop
  --purge        With --yes, also delete the repo's task data in ~/.shipline
  -h, --help     Show this help`,
  },
  ui: {
    flags: {},
    help: `Usage: ${NPX} ui [--dir <path>] [--port <n>] [--no-open]

Local web UI for setup and tasks (Node 20+).

Options:
${DIR}
  --port <n>     Port to listen on (default: a free one)
  --no-open      Don't open the browser
  -h, --help     Show this help`,
  },
};

const usageError = (message) => {
  console.error(`shipline: ${message}`);
  process.exit(2);
};

// Parses init, upgrade and uninstall arguments: only the command's own flags and `--dir <path>`.
function parseArgs(cmd, args) {
  const spec = COMMANDS[cmd].flags;
  const out = { target: process.cwd() };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dir' || a.startsWith('--dir=')) {
      const value = a === '--dir' ? args[++i] : a.slice('--dir='.length);
      if (!value) usageError(`--dir needs a path (see shipline ${cmd} --help)`);
      out.target = value;
    } else if (Object.prototype.hasOwnProperty.call(spec, a)) out[spec[a]] = true;
    else if (a.startsWith('-')) usageError(`unknown option ${a} (see shipline ${cmd} --help)`);
    else usageError(`unexpected argument ${a} (use --dir)`);
  }
  return out;
}

const [cmd, ...rest] = process.argv.slice(2);
const known = cmd !== undefined && Object.prototype.hasOwnProperty.call(COMMANDS, cmd);
const wants = (...flags) => process.argv.slice(2).some((a) => flags.includes(a));

if (wants('-h', '--help') && (known || cmd === undefined || cmd.startsWith('-') || cmd === 'help')) {
  console.log(known ? COMMANDS[cmd].help : HELP);
} else if (wants('-v', '--version') && (known || cmd === undefined || cmd.startsWith('-'))) {
  console.log(VERSION);
} else if (cmd === 'ui') {
  if (major < 20) {
    console.error(`shipline ui requires Node 20 or newer (found ${process.versions.node}).`);
    process.exit(1);
  }
  // Loaded only here, so `init` on Node 18 never loads Node-20-only code.
  const { parseUiArgs, startServer } = await import('../src/ui/server.mjs');
  await startServer(parseUiArgs(rest));
} else if (known) {
  const o = parseArgs(cmd, rest);
  if (cmd === 'init') process.exitCode = await runInit({ target: o.target, dryRun: Boolean(o.dryRun), yes: Boolean(o.yes), terminal: Boolean(o.terminal) });
  else if (cmd === 'upgrade') {
    process.exitCode = await runUpgrade({ target: o.target, yes: Boolean(o.yes), dryRun: Boolean(o.dryRun), force: Boolean(o.force) });
  } else {
    process.exitCode = await runUninstall({ target: o.target, yes: Boolean(o.yes), dryRun: Boolean(o.dryRun), purge: Boolean(o.purge) });
  }
} else if (cmd === undefined || cmd === 'help') {
  console.log(HELP);
} else if (cmd.startsWith('-')) {
  usageError(`unknown option ${cmd} (see shipline --help)`);
} else {
  console.error(`shipline: unknown command ${cmd}\n`);
  console.log(HELP);
  process.exitCode = 2;
}
