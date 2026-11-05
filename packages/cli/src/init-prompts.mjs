// The interactive questions of `shipline init`. Imported only by init's interactive path, so `ui`, `upgrade`
// and `uninstall` never load @inquirer/prompts. Node 18+.

const NONE = '__none__'; // a select value cannot reliably be null

// info: { workflows, agents, repoAgents, repoSkills, detected, trackerDefault, missingStageAgents(selection) } (see init.mjs).
// Returns { workflows, agents, clashes, stageAgents, skills, commands, tracker, ci }.
export async function askSelection(info) {
  let prompts;
  try {
    prompts = await import('@inquirer/prompts');
  } catch (e) {
    // @inquirer/prompts 8 needs Node 20.17+; init and the hooks otherwise run on Node 18.
    throw new Error(`the interactive questions could not be loaded (${e.message}). They need Node 20.17 or newer; on older Node, run \`init --yes\`.`);
  }
  const { checkbox, confirm, input, select } = prompts;

  // 1. Workflows (at least one).
  const workflows = await checkbox({
    message: 'Which workflows should Shipline install?',
    choices: info.workflows.map((w) => ({
      name: `${w.name}${w.description ? ` - ${w.description}` : ''}`,
      value: w.id,
      checked: true,
    })),
    validate: (chosen) => chosen.length > 0 || 'Choose at least one workflow.',
  });

  // 2. Shipline's agents (none is fine).
  const agents = await checkbox({
    message: "Which of Shipline's agents should be installed?",
    choices: info.agents.map((a) => ({
      name: info.repoAgents.includes(a) ? `${a} (you already have an agent with this name)` : a,
      value: a,
      checked: true,
    })),
  });

  // 3. One question per name clash.
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

  // 4. One question per stage whose suggested agent is no longer installed.
  const stageAgents = {};
  const present = agents.filter((a) => clashes[a] !== 'skip');
  const repoOwn = info.repoAgents.filter((a) => !present.includes(a));
  for (const m of info.missingStageAgents({ workflows, agents, clashes })) {
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

  // 5. The repo's own skills to point Claude at (only when it has some).
  let skills = [];
  if (info.repoSkills.length) {
    skills = await checkbox({
      message: "Which of this repo's own skills should Claude be pointed to at every stage?",
      choices: info.repoSkills.map((s) => ({ name: s, value: s })),
    });
  }

  // 6. The test, lint and build commands, pre-filled from the repo's files. An empty answer means none.
  const detected = info.detected || { test: '', lint: '', build: '', sources: {} };
  const found = ['test', 'lint', 'build'].filter((k) => detected[k]).map((k) => `${k}: ${detected.sources[k]}`);
  console.log(
    found.length
      ? `Detected commands (${found.join('; ')}). Press Enter to accept or edit them; to leave one empty, delete it and press Backspace once more.`
      : 'No test, lint or build commands detected. Type them in, or press Enter to leave them empty.',
  );
  const commands = {};
  for (const [key, label] of [['test', 'Test'], ['lint', 'Lint'], ['build', 'Build']]) {
    const answer = await input({
      message: `${label} command [${detected[key] || 'none'}]:`,
      default: detected[key] || '',
      prefill: 'editable',
    });
    commands[key] = String(answer).trim();
  }

  // 7. Where tickets live.
  const tracker = await select({
    message: 'Tracker:',
    choices: [
      { name: 'GitHub Issues', value: 'github' },
      { name: 'Jira', value: 'jira' },
    ],
    default: info.trackerDefault || 'jira',
  });

  // 8. The optional pull-request check (default No).
  const ci = await confirm({ message: 'Add a Shipline CI check for pull requests?', default: false });

  return { workflows, agents, clashes, stageAgents, skills, commands, tracker, ci };
}
