#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { runInit } from '../src/init.mjs';
import { runPrune } from '../src/prune.mjs';
import { runRelink } from '../src/relink.mjs';
import { runUninstall } from '../src/uninstall.mjs';
import { runUpgrade, runUpgradeAll } from '../src/upgrade.mjs';

const major = Number(process.versions.node.split('.')[0]);
if (major < 22) {
  console.error(`shipline requires Node 22 or newer (found ${process.versions.node}).`);
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
  ui          Local web UI for setup and tasks (one server for every repo on this machine)
  prune       Remove the task data of repos that no longer exist
  relink      Give a moved repo back the task data of its old path
  help        Show this overview and every command's help (help <command>: just that command's)

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

In a terminal init opens the setup wizard in your browser. With --terminal it asks the same questions
here, shows a review of what it will write, and asks before writing. It aborts with nothing written if any
other file name collides.`,
  },
  upgrade: {
    flags: { '--yes': 'yes', '-y': 'yes', '--dry-run': 'dryRun', '--force': 'force', '--all': 'all' },
    help: `Usage: ${NPX} upgrade [--dir <path> | --all] [--yes] [--dry-run] [--force]

Updates an installed repo's Shipline files to this version. It shows a preview first. For each file your team
edited it asks what to do (keep yours, replace it, or write the new version next to it as <file>.shipline-new, or
show the diff); with --yes it writes the .shipline-new files. Edited scripts in .shipline/bin/ stop the upgrade
unless --force, and so do edits to the CLAUDE.md block and the settings.json hook entries (those are left as they are).
Tip: use npx @forgeyard/shipline@latest so npx doesn't run an older cached copy.

Options:
${DIR}
  --all          Upgrade every repo in the machine-wide project list (not with --dir). Each repo gets its own
                 preview and confirmation (edited files get .shipline-new side files, no per-file questions);
                 a failure in one is reported and the rest still run. Exits 1 if any failed.
  -y, --yes      Apply without asking (edited files get .shipline-new side files)
  --dry-run      Show the preview and stop
  --force        Replace every edited file (including .shipline/bin/ scripts), without asking
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
    help: `Usage: ${NPX} ui [--dir <path>] [--port <n>] [--no-open] [--remote]

Local web UI for setup and tasks. One server serves every repo on this machine: when one is already running,
this opens the folder in it instead of starting another.

Options:
${DIR}
  --port <n>     Port to listen on (default: a free one; ignored when a server is already running)
  --no-open      Don't open the browser
  --remote       Also serve the UI to your paired phone over Tailscale (turns it on in a running server too)
  -h, --help     Show this help`,
  },
};

COMMANDS.prune = {
  flags: { '--yes': 'yes', '-y': 'yes', '--dry-run': 'dryRun' },
  noDir: true,
  help: `Usage: ${NPX} prune [--dry-run] [--yes]

Removes the task data (in ~/.shipline/projects) of repos whose folder is gone or no longer has Shipline, and
store backups older than 30 days that the 2.2 store migration left (*.migrated-<date>). A store that a worktree
you still have uses is kept. Previews first and asks once; without a terminal it only previews unless --yes.

Options:
  -y, --yes      Remove without asking
  --dry-run      Show what would be removed and stop
  -h, --help     Show this help`,
};
COMMANDS.relink = {
  flags: { '--dry-run': 'dryRun' },
  values: { '--from': 'from' },
  help: `Usage: ${NPX} relink --from <old path> [--dir <path>] [--dry-run]

After you move or rename a repo, gives it back the task data of its old path. Run it in the moved repo (or
pass --dir). Refuses when the old folder still exists, or when this repo already has tasks.

Options:
  --from <path>  Where the repo used to be
${DIR}
  --dry-run      Show what would move and stop
  -h, --help     Show this help`,
};

const usageError = (message) => {
  console.error(`shipline: ${message}`);
  process.exit(2);
};

// Parses init, upgrade, uninstall, prune and relink arguments: only the command's own flags and `--dir <path>`.
function parseArgs(cmd, args) {
  const spec = COMMANDS[cmd].flags;
  const out = { target: process.cwd() };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const valueFlag = Object.keys(COMMANDS[cmd].values || {}).find((f) => a === f || a.startsWith(`${f}=`));
    if (valueFlag) {
      const value = a === valueFlag ? args[++i] : a.slice(valueFlag.length + 1);
      if (!value) usageError(`${valueFlag} needs a value (see shipline ${cmd} --help)`);
      out[COMMANDS[cmd].values[valueFlag]] = value;
    } else if (!COMMANDS[cmd].noDir && (a === '--dir' || a.startsWith('--dir='))) {
      const value = a === '--dir' ? args[++i] : a.slice('--dir='.length);
      if (!value) usageError(`--dir needs a path (see shipline ${cmd} --help)`);
      out.target = value;
      out.dirGiven = true;
    } else if (Object.prototype.hasOwnProperty.call(spec, a)) out[spec[a]] = true;
    else if (a.startsWith('-')) usageError(`unknown option ${a} (see shipline ${cmd} --help)`);
    else usageError(`unexpected argument ${a} (use --dir)`);
  }
  return out;
}

const [cmd, ...rest] = process.argv.slice(2);
const known = cmd !== undefined && Object.prototype.hasOwnProperty.call(COMMANDS, cmd);
const wants = (...flags) => process.argv.slice(2).some((a) => flags.includes(a));

// The overview, then every command's help under a heading.
const fullHelp = () => [HELP, ...Object.keys(COMMANDS).map((c) => `\n----- ${NPX} ${c} -----\n${COMMANDS[c].help}`)].join('\n');

if (cmd === 'help') {
  const topic = rest.find((a) => !a.startsWith('-'));
  if (topic === undefined) console.log(fullHelp());
  else if (Object.prototype.hasOwnProperty.call(COMMANDS, topic)) console.log(COMMANDS[topic].help);
  else {
    console.error(`shipline: unknown command ${topic}\n`);
    console.log(HELP);
    process.exitCode = 2;
  }
} else if (wants('-h', '--help') && (known || cmd === undefined || cmd.startsWith('-'))) {
  console.log(known ? COMMANDS[cmd].help : fullHelp());
} else if (wants('-v', '--version') && (known || cmd === undefined || cmd.startsWith('-'))) {
  console.log(VERSION);
} else if (cmd === 'ui') {
  // Loaded only here, so the other commands never load the UI server.
  // A running server takes the folder over (see launchUi); otherwise this process becomes the server.
  const { parseUiArgs } = await import('../src/ui/server.mjs');
  const { launchUi } = await import('../src/ui/server-record.mjs');
  await launchUi(parseUiArgs(rest), VERSION);
} else if (known) {
  const o = parseArgs(cmd, rest);
  if (cmd === 'init') process.exitCode = await runInit({ target: o.target, dryRun: Boolean(o.dryRun), yes: Boolean(o.yes), terminal: Boolean(o.terminal) });
  else if (cmd === 'upgrade' && o.all) {
    if (o.dirGiven) usageError('--all cannot be used with --dir (see shipline upgrade --help)');
    process.exitCode = await runUpgradeAll({ yes: Boolean(o.yes), dryRun: Boolean(o.dryRun), force: Boolean(o.force) });
  } else if (cmd === 'upgrade') {
    process.exitCode = await runUpgrade({ target: o.target, yes: Boolean(o.yes), dryRun: Boolean(o.dryRun), force: Boolean(o.force) });
  } else if (cmd === 'prune') {
    process.exitCode = await runPrune({ yes: Boolean(o.yes), dryRun: Boolean(o.dryRun) });
  } else if (cmd === 'relink') {
    process.exitCode = await runRelink({ target: o.target, from: o.from, dryRun: Boolean(o.dryRun) });
  } else {
    process.exitCode = await runUninstall({ target: o.target, yes: Boolean(o.yes), dryRun: Boolean(o.dryRun), purge: Boolean(o.purge) });
  }
} else if (cmd === undefined) {
  console.log(fullHelp());
} else if (cmd.startsWith('-')) {
  usageError(`unknown option ${cmd} (see shipline --help)`);
} else {
  console.error(`shipline: unknown command ${cmd}\n`);
  console.log(HELP);
  process.exitCode = 2;
}
