import { existsSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { CI_WORKFLOW, VERSION_FILE } from './hashes.mjs';
import {
  COMMAND_KEYS, applyInstall, checkSelection, clashOf, defaultAgents, defaultSelection, fillSelection, installInfo,
  missingStageAgents, planInstall,
} from './install.mjs';

// Other modules (upgrade, uninstall) still import these from here.
export { mergeSettingsObject, parseSettings, shippedAgents, shippedWorkflows } from './install.mjs';

function commandsSummary(commands, detected) {
  const rows = COMMAND_KEYS.filter((k) => commands[k]).map((k) => `  ${k}: ${commands[k]}${detected.sources[k] && commands[k] === detected[k] ? ` (from ${detected.sources[k]})` : ''}`);
  return rows.length ? `Commands for the verify stage:\n${rows.join('\n')}` : 'No test, lint or build commands set; add them under commands: in .shipline/config.yml.';
}

// Returns a process exit code. Preflights everything, then writes. `prompts` (optional) replaces the interactive
// questions in-process: an async function (info) => selection, where info is
// { workflows, agents, repoAgents, repoSkills, detected, trackerDefault, uiDetected, agentUse, missingStageAgents(selection),
//   defaultAgents(workflowIds, ui) }. `where` (optional) replaces the browser-or-terminal question, and `startUi`
// the start of the browser UI (both for tests).
export async function runInit({ target, dryRun = false, yes = false, prompts = null, where = null, startUi = null }) {
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

  if (!yes && !prompts && !process.stdin.isTTY) {
    console.error('shipline: init asks questions, and this is not a terminal. Run it in a terminal, or pass --yes to install the defaults.');
    return 1;
  }

  // Interactive runs on Node 20+ may set up in the browser instead (the UI needs Node 20).
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (!yes && !dryRun && nodeMajor >= 20 && (where || !prompts)) {
    let place;
    try {
      place = await (where || (await import('./init-prompts.mjs')).askWhere)();
    } catch (e) {
      console.error(`shipline: init cancelled, nothing was written. ${e.message}`);
      return 1;
    }
    if (place === 'browser') {
      const start = startUi || (async () => (await import('./ui/server.mjs')).startServer({ dir: root, port: 0, open: true }));
      await start(root);
      return 0; // the server keeps the process alive until it is stopped
    }
  }

  info.missingStageAgents = (selection) => missingStageAgents(info.workflows, selection);
  info.defaultAgents = (workflowIds, ui) => defaultAgents(info, workflowIds, ui);

  let selection;
  try {
    if (yes) selection = defaultSelection(info);
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
    for (const f of writes) console.log(`  ${f.overwrite ? '~' : '+'} ${f.to}`);
    console.log(`  + ${VERSION_FILE}`);
    console.log(`  ${settingsText === null ? '+' : '~'} .claude/settings.json (hooks and allow rules merged)`);
    console.log(`  ${claudeMd === null ? '+' : '~'} CLAUDE.md (marked block ${claudeMd === null ? 'created' : 'appended'})`);
    for (const p of excluded) console.log(`  = ${p} (not installed; recorded as excluded)`);
    return 0;
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

  created ${writes.filter((f) => f.to !== CI_WORKFLOW).length} files under .shipline/ and .claude/
  ${settingsText === null ? 'created' : 'merged hooks and allow rules into'} .claude/settings.json
  ${claudeMd === null ? 'created' : 'appended a marked block to'} CLAUDE.md
${kept.length ? `\nKept your own agents (used where Shipline's would be): ${kept.join(', ')}. To use Shipline's instead: \`npx @forgeyard/shipline ui\` -> Setup -> Agents & skills, or uninstall and re-run \`init\` interactively.\n` : ''}${selection.ci ? `\nAdded the pull-request check .github/workflows/shipline.yml (paste \`node .shipline/bin/stage.mjs pr-summary\` into PR descriptions).\n` : ''}${trimmed}
${commandsSummary(selection.commands, info.detected)}
Tracker: ${selection.tracker === 'github' ? 'GitHub Issues (read with the gh CLI)' : 'Jira (read through the Atlassian MCP)'}. Change it in .shipline/config.yml.

Next: tailor the rules to this repo. Run \`/shipline-setup\` in Claude Code, or open \`npx @forgeyard/shipline ui\` and use Setup -> Set up with Claude.
Then commit .shipline/, .claude/ and CLAUDE.md so teammates get the same flow on clone (Node 18+ required).`);
  return 0;
}
