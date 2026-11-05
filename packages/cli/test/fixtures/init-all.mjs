#!/usr/bin/env node
// `shipline init` with the questions answered, through init's own code (the bin can only do --yes without a
// terminal).
//   node test/fixtures/init-all.mjs <dir>                    everything: every shipped workflow with its UI stages
//       and every agent (the standalone `reviewer` too), commands and tracker as --yes picks them. This is what
//       `init --yes` installed before 0.12.0 trimmed it, and the full install most tests start from.
//   node test/fixtures/init-all.mjs <dir> '<selection json>'  these answers (init fills what they leave out).
import path from 'node:path';
import { runInit } from '../../src/init.mjs';

const target = path.resolve(process.argv[2] || process.cwd());
const answer = process.argv[3] ? JSON.parse(process.argv[3]) : null;
process.exitCode = await runInit({
  target,
  prompts: async (info) => answer || { workflows: info.workflows.map((w) => w.id), ui: true, agents: [...info.agents] },
});
