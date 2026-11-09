import { existsSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { toolOnPath } from './detect-commands.mjs';
import { CI_WORKFLOW, VERSION_FILE } from './hashes.mjs';
import {
  COMMAND_KEYS, applyInstall, checkSelection, clashOf, defaultAgents, defaultSelection, fillSelection, installInfo,
  missingStageAgents, nextSteps, planInstall,
} from './install.mjs';

// Other modules (upgrade, uninstall) still import these from here.
export { mergeSettingsObject, parseSettings, shippedAgents, shippedWorkflows } from './install.mjs';

const trackerSummary = (t) =>
  t === 'github' ? 'GitHub Issues (read with the gh CLI).' : t === 'jira' ? 'Jira (read through the Atlassian MCP).' : 'none, so the ticket stage is skipped.';

function commandsSummary(commands, detected) {
  const rows = COMMAND_KEYS.filter((k) => commands[k]).map((k) => `  ${k}: ${commands[k]}${detected.sources[k] && commands[k] === detected[k] ? ` (from ${detected.sources[k]})` : ''}`);
  return rows.length ? `Commands for the verify stage:\n${rows.join('\n')}` : 'No test, lint or build commands set; add them under commands: in .shipline/config.yml.';
}

// The file list `--dry-run` prints and the review shows: `+` create, `~` overwrite or merge, `=` not installed.
function fileLines(plan) {
  const lines = plan.writes.map((f) => `  ${f.overwrite ? '~' : '+'} ${f.to}`);
  lines.push(`  + ${VERSION_FILE}`);
  lines.push(`  ${plan.settings.before === null ? '+' : '~'} .claude/settings.json (hooks and allow rules merged)`);
  lines.push(`  ${plan.claudeMd.before === null ? '+' : '~'} CLAUDE.md (marked block ${plan.claudeMd.before === null ? 'created' : 'appended'})`);
  for (const p of plan.excluded) lines.push(`  = ${p} (not installed; recorded as excluded)`);
  return lines;
}

// The settings summary and the file list, printed before the final question of an interactive run.
function reviewText(info, selection, plan) {
  const list = (a) => (a.length ? a.join(', ') : 'none');
  const clashes = selection.agents
    .map((a) => [a, clashOf(info, selection, a)])
    .filter(([, c]) => c)
    .map(([a, c]) => `${a}: ${c === 'keep' ? 'keep yours' : c === 'ours' ? "use Shipline's" : 'skip'}`);
  const stageAgents = Object.entries(selection.stageAgents || {}).map(([k, v]) => `${k} -> ${v || 'none'}`);
  const commands = COMMAND_KEYS.map((k) => `${k}: ${selection.commands[k] || 'none'}`).join('; ');
  return [
    'Review',
    `  Workflows:      ${list(selection.workflows)} (${selection.ui ? 'with the UI-only stages' : 'no UI: UI-only stages left out'})`,
    `  Commands:       ${commands}`,
    `  Tracker:        ${selection.tracker}`,
    `  Confirmations:  ${selection.confirmations === 'light' ? 'light (asks only at plan approval)' : 'standard'}`,
    `  Guardrails:     ${selection.guardrails === 'off' ? 'off (every rail off, no protected paths)' : 'on'}`,
    `  Branch pattern: ${selection.branchPattern}`,
    `  Agents:         ${list(selection.agents)}${clashes.length ? ` (name clashes: ${clashes.join('; ')})` : ''}`,
    ...(stageAgents.length ? [`  Stage agents:   ${stageAgents.join('; ')}`] : []),
    `  Skills:         ${list(selection.skills)}`,
    `  CI check:       ${selection.ci ? 'yes (.github/workflows/shipline.yml)' : 'no'}`,
    '',
    'Files:',
    ...fileLines(plan),
  ].join('\n');
}

const insideGit = (root) => {
  try {
    return execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() === 'true';
  } catch {
    return false;
  }
};

// Warnings printed after the summary; they never block. Each detected command's first word is checked against PATH
// (plain program names only: a path like ./gradlew or an assignment is left alone).
function warnings(root, commands, detected) {
  const out = [];
  if (!insideGit(root)) out.push('Not a git repository: scope checks, the PR summary\'s code match and pushes need git. Run `git init` first.');
  for (const key of COMMAND_KEYS) {
    if (!commands[key] || commands[key] !== detected[key]) continue; // only what was detected, not what the user typed
    const first = String(commands[key]).trim().split(/\s+/)[0];
    if (!first || !/^[A-Za-z0-9._+][A-Za-z0-9._+-]*$/.test(first)) continue;
    if (!toolOnPath(first)) out.push(`Detected \`${first}\` for ${key}, but \`${first}\` isn't installed here.`);
  }
  return out;
}

// Returns a process exit code. Preflights everything, then writes. `prompts` (optional) replaces the interactive
// questions in-process: an async function (info) => selection, where info is
// { workflows, agents, repoAgents, repoSkills, detected, trackerDefault, uiDetected, agentUse, missingStageAgents(selection),
//   defaultAgents(workflowIds, ui) }. A terminal run with questions (and no --yes) shows a review and asks
// before writing; `confirm` (optional, an async (reviewText) => boolean) replaces that question. Without --terminal
// or `prompts`, an interactive run on Node 20+ opens the browser wizard; `startUi` replaces that start (for tests),
// and `nodeMajor` the Node version it checks.
export async function runInit({
  target, dryRun = false, yes = false, terminal = false, prompts = null, confirm = null, startUi = null,
  nodeMajor = Number(process.versions.node.split('.')[0]),
}) {
  const root = path.resolve(target);
  if (!existsSync(root) || !lstatSync(root).isDirectory()) {
    console.error(`shipline: ${root} is not a directory.`);
    return 1;
  }

  // What the repo already has, and what Shipline offers.
  const info = installInfo(root);

  // Already initialized? Checked before any prompt, with or without --yes.
  if (info.state !== 'clean') {
    console.log(`Shipline is already initialized in this repo (found .shipline/, the CLAUDE.md block or the hooks). Nothing was written.
  - Change which agents and skills are installed: \`npx @forgeyard/shipline ui\`, then Setup, Agents & skills.
  - Update to this version: \`npx @forgeyard/shipline upgrade\`.
  - Start over: \`npx @forgeyard/shipline uninstall\`, then \`init\` again.`);
    return 0;
  }

  // A dry run needs no answers: without a terminal it previews the defaults that --yes would install.
  const useDefaults = yes || (dryRun && !prompts && !process.stdin.isTTY);
  if (!useDefaults && !prompts && !process.stdin.isTTY) {
    console.error('shipline: init asks questions, and this is not a terminal. Run it in a terminal, or pass --yes to install the defaults.');
    return 1;
  }

  // An interactive run sets up in the browser wizard by default (the UI needs Node 20); --terminal, or an
  // injected `prompts`, asks here instead.
  if (!useDefaults && !dryRun && !terminal) {
    if (nodeMajor < 20) console.log('The setup wizard needs Node 20+; asking here instead.');
    else if (!prompts) {
      const start = startUi || (async () => (await import('./ui/server.mjs')).startServer({ dir: root, port: 0, open: true }));
      await start(root);
      return 0; // the server keeps the process alive until it is stopped
    }
  }

  info.missingStageAgents = (selection) => missingStageAgents(info.workflows, selection);
  info.defaultAgents = (workflowIds, ui) => defaultAgents(info, workflowIds, ui);

  let selection;
  try {
    if (useDefaults) selection = defaultSelection(info);
    else if (prompts) selection = await prompts(info);
    else selection = await (await import('./init-prompts.mjs')).askSelection(info);
    checkSelection(info, selection, { partial: true });
  } catch (e) {
    console.error(`shipline: init cancelled, nothing was written. ${e.message}`);
    return 1;
  }
  selection = fillSelection(info, selection);
  checkSelection(info, selection);

  // Preflight: nothing is written until every check passes.
  const plan = planInstall(root, info, selection);
  const { writes, excluded } = plan;
  if (plan.collisions.length) {
    console.error('shipline: init aborted, nothing was written. These paths already exist:\n' + plan.collisions.map((c) => `  - ${c}`).join('\n'));
    console.error('\nRename or move them, then run init again.');
    return 1;
  }
  if (plan.mergeError) {
    console.error(`shipline: init aborted. ${plan.mergeError}`);
    return 1;
  }
  const settingsText = plan.settings.before;
  const claudeMd = plan.claudeMd.before;

  if (dryRun) {
    console.log('Dry run, nothing written. Would create:');
    for (const line of fileLines(plan)) console.log(line);
    if (!yes && !prompts && !process.stdin.isTTY) console.log('\nNo terminal, so this previews the defaults that --yes installs.');
    return 0;
  }

  // The review: what was chosen and what will be written, then one question. --yes skips it, as it skips every question.
  if (!useDefaults) {
    const text = reviewText(info, selection, plan);
    console.log(`\n${text}\n`);
    let go;
    try {
      go = confirm ? await confirm(text) : await (await import('./init-prompts.mjs')).askConfirmInstall();
    } catch (e) {
      console.error(`shipline: init cancelled, nothing was written. ${e.message}`);
      return 1;
    }
    if (!go) {
      console.error('Cancelled, nothing was written.');
      return 1;
    }
  }

  try {
    applyInstall(root, plan);
  } catch (e) {
    if (e.code === 'store') console.error(`shipline: ${e.message}`);
    else console.error(`shipline: init failed while writing (${e.message}); changes were rolled back.`);
    return 1;
  }

  const kept = info.agents.filter((a) => selection.agents.includes(a) && clashOf(info, selection, a) === 'keep');
  let trimmed = '';
  if (yes) {
    const skippedAgents = info.agents.filter((a) => !selection.agents.includes(a));
    const droppedStages = selection.ui
      ? []
      : info.workflows.flatMap((w) => w.stages.filter((st) => st.condition === 'ui_only').map((st) => `${w.id}.${st.id}`));
    const parts = [];
    if (skippedAgents.length) parts.push(`agents not used by these workflows: ${skippedAgents.join(', ')}`);
    if (droppedStages.length) parts.push(`UI-only stages (no UI detected here): ${droppedStages.join(', ')}`);
    if (parts.length) trimmed = `\n--yes installs only what the chosen workflows use. Left out: ${parts.join('; ')}. Add them later in \`npx @forgeyard/shipline ui\` -> Setup.\n`;
  }
  console.log(`Shipline initialized in ${root}

  created ${writes.filter((f) => f.to !== CI_WORKFLOW).length + 1} files under .shipline/ and .claude/
  ${settingsText === null ? 'created' : 'merged hooks and allow rules into'} .claude/settings.json
  ${claudeMd === null ? 'created' : 'appended a marked block to'} CLAUDE.md
${kept.length ? `\nKept your own agents (used where Shipline's would be): ${kept.join(', ')}. To use Shipline's instead: \`npx @forgeyard/shipline ui\` -> Setup -> Agents & skills, or uninstall and re-run \`init\` interactively.\n` : ''}${selection.ci ? `\nAdded the pull-request check .github/workflows/shipline.yml (paste \`node .shipline/bin/stage.mjs pr-summary\` into PR descriptions).\n` : ''}${trimmed}
${commandsSummary(selection.commands, info.detected)}
Tracker: ${trackerSummary(selection.tracker)} Change it in .shipline/config.yml.

${nextSteps(selection).join('\n')}`);
  const warns = warnings(root, selection.commands, info.detected);
  if (warns.length) console.log(`\nWarnings\n${warns.map((w) => `  ! ${w}`).join('\n')}`);
  return 0;
}
