// The interactive questions of `shipline init`. Imported only by init's interactive path, so `ui`, `upgrade`
// and `uninstall` never load @inquirer/prompts. Node 18+.

import { DEFAULT_BRANCH_PATTERN } from './install.mjs';
import { branchPatternError } from './setup-schema.mjs';

const NONE = '__none__'; // a select value cannot reliably be null

async function loadPrompts() {
  try {
    return await import('@inquirer/prompts');
  } catch (e) {
    // @inquirer/prompts 8 needs Node 20.17+; init and the hooks otherwise run on Node 18.
    throw new Error(`the interactive questions could not be loaded (${e.message}). They need Node 20.17 or newer; on older Node, run \`init --yes\`.`);
  }
}

export const GUARDRAILS_SUMMARY =
  'On: force-push to main and printing credentials are denied; pushes to main, deploys, migrations, edits to agent config and protected paths (migrations/, infra/, CI files, lockfiles…) ask first.';

// A command answer as stored: trimmed, and `none` (any case) means empty.
export const commandAnswer = (answer) => {
  const v = String(answer).trim();
  return v.toLowerCase() === 'none' ? '' : v;
};

const TOTAL_STEPS = 7;
const stepTitle = (n, title) => console.log(`\nStep ${n} of ${TOTAL_STEPS}: ${title}`);

// The last question, after the review has been printed.
export async function askConfirmInstall() {
  const { confirm } = await loadPrompts();
  return confirm({ message: 'Install these files?', default: true });
}

// info: { workflows, agents, repoAgents, repoSkills, detected, trackerDefault, uiDetected, agentUse,
//   missingStageAgents(selection), defaultAgents(workflowIds, ui) } (see init.mjs).
// Returns { workflows, ui, agents, clashes, stageAgents, skills, commands, tracker, confirmations, guardrails,
//   branchPattern, ci }.
export async function askSelection(info) {
  const { checkbox, confirm, input, select } = await loadPrompts();

  // Step 1. Workflows (at least one), then whether the repo has a UI (decides if the UI-only stages, such as
  // wireframes, are written).
  stepTitle(1, 'Workflows');
  const workflows = await checkbox({
    message: 'Which workflows should Shipline install?',
    choices: info.workflows.map((w) => ({
      name: `${w.name}${w.description ? ` - ${w.description}` : ''}`,
      value: w.id,
      checked: true,
    })),
    validate: (chosen) => chosen.length > 0 || 'Choose at least one workflow.',
  });
  const ui = await confirm({
    message: `Does this repo have a UI? (detected: ${info.uiDetected ? 'yes' : 'no'})`,
    default: info.uiDetected,
  });

  // Step 2. The test, lint and build commands, pre-filled from the repo's files. `none` means empty.
  stepTitle(2, 'Commands');
  const detected = info.detected || { test: '', lint: '', build: '', sources: {} };
  const found = ['test', 'lint', 'build'].filter((k) => detected[k]).map((k) => `${k}: ${detected.sources[k]}`);
  console.log(
    found.length
      ? `The verify stage runs these. Detected (${found.join('; ')}). Enter keeps it; type \`none\` to leave it empty.`
      : 'The verify stage runs these. None detected. Type them in, or press Enter to leave them empty.',
  );
  const commands = {};
  for (const [key, label] of [['test', 'Test'], ['lint', 'Lint'], ['build', 'Build']]) {
    commands[key] = commandAnswer(
      await input({
        message: `${label} command [${detected[key] || 'none'}]:`,
        default: detected[key] || '',
        prefill: 'editable',
      }),
    );
  }

  // Step 3. Where tickets live.
  stepTitle(3, 'Tracker');
  const tracker = await select({
    message: 'Tracker:',
    choices: [
      { name: 'None', value: 'none' },
      { name: 'GitHub Issues', value: 'github' },
      { name: 'Jira', value: 'jira' },
    ],
    default: info.trackerDefault || 'none',
  });

  // Step 4. Process: how often Claude asks, and the branch name pattern.
  stepTitle(4, 'Process');
  const confirmations = await select({
    message: 'Confirmations:',
    choices: [
      { name: 'Standard (asks before Open questions, Plan and Verify)', value: 'standard' },
      { name: 'Light (asks only at plan approval)', value: 'light' },
    ],
    default: 'standard',
  });
  const patternAnswer = String(
    await input({
      message: `Branch pattern ({type} = workflow, {key} = ticket key, {slug} = short task name) [${DEFAULT_BRANCH_PATTERN}]:`,
      validate: (v) => (String(v).trim() === '' ? true : branchPatternError(String(v).trim()) || true),
    }),
  ).trim();
  const branchPattern = patternAnswer || DEFAULT_BRANCH_PATTERN;

  // Step 5. Guardrails: one switch.
  stepTitle(5, 'Guardrails');
  console.log(GUARDRAILS_SUMMARY);
  const guardrailsOn = await confirm({ message: 'Turn guardrails on?', default: true });
  const guardrails = guardrailsOn ? 'on' : 'off';

  // Step 6. Agents and skills. Shipline's agents (none is fine): the ones the chosen workflows' stages use are
  // ticked; standalone agents (no stage names them) come in a section of their own, unticked.
  stepTitle(6, 'Agents and skills');
  const used = info.defaultAgents(workflows, ui);
  const standalone = info.agents.filter((a) => (info.agentUse[a] || []).length === 0);
  const label = (a) => (info.repoAgents.includes(a) ? `${a} (you already have an agent with this name)` : a);
  const stageChosen = await checkbox({
    message: "Which of Shipline's agents should be installed? (ticked: used by the workflows you chose)",
    choices: info.agents.filter((a) => !standalone.includes(a)).map((a) => ({ name: label(a), value: a, checked: used.includes(a) })),
  });
  const standaloneChosen = standalone.length
    ? await checkbox({
        message: 'Optional agents that no stage uses (off by default):',
        choices: standalone.map((a) => ({ name: label(a), value: a, checked: false })),
      })
    : [];
  const agents = info.agents.filter((a) => stageChosen.includes(a) || standaloneChosen.includes(a));

  // One question per name clash.
  const clashes = {};
  for (const name of agents.filter((a) => info.repoAgents.includes(a))) {
    clashes[name] = await select({
      message: `.claude/agents/${name}.md already exists. What should Shipline do?`,
      choices: [
        { name: 'Keep yours (it is used where Shipline would use its own)', value: 'keep' },
        { name: "Use Shipline's (replaces your file)", value: 'ours' },
        { name: 'Skip (install nothing for this agent)', value: 'skip' },
      ],
      default: 'keep',
    });
  }

  // One question per stage whose suggested agent is no longer installed.
  const stageAgents = {};
  const present = agents.filter((a) => clashes[a] !== 'skip');
  const repoOwn = info.repoAgents.filter((a) => !present.includes(a));
  for (const m of info.missingStageAgents({ workflows, agents, clashes, ui })) {
    const picked = await select({
      message: `Stage "${m.stage}" of the ${m.workflow} workflow suggests the "${m.agent}" agent, which is not installed. Use which agent instead?`,
      choices: [
        ...present.map((a) => ({ name: `${a} (Shipline)`, value: a })),
        ...repoOwn.map((a) => ({ name: `${a} (yours)`, value: a })),
        { name: 'None', value: NONE },
      ],
      default: NONE,
    });
    stageAgents[m.key] = picked === NONE ? null : picked;
  }

  // The repo's own skills to point Claude at (only when it has some).
  let skills = [];
  if (info.repoSkills.length) {
    skills = await checkbox({
      message: "Which of this repo's own skills should Claude be pointed to at every stage?",
      choices: info.repoSkills.map((s) => ({ name: s, value: s })),
    });
  }

  // Step 7. The optional pull-request check (default No).
  stepTitle(7, 'CI check');
  const ci = await confirm({ message: 'Add a Shipline CI check for pull requests?', default: false });

  return { workflows, ui, agents, clashes, stageAgents, skills, commands, tracker, confirmations, guardrails, branchPattern, ci };
}
