# Guardrails and workflows for any team (ideation, 2026-11-05)

**Context:** `main` @ 733eff1 (0.9.0). Every adoption-roadmap phase is merged. The question: how can guardrails and workflows get better, so any team can adopt Shipline and find it genuinely helpful?

## What the code does today

- **"Done" means the file exists.** `stage.mjs advance` only checks that the artifact file is there (`templates/shipline/bin/stage.mjs:296`). An empty `plan.md` finishes the Plan stage.
- **Verify runs nothing itself.** The Verify stage is Claude's own account in `verification.md`. The `shipline-workflow` skill says to run test, lint and build "only if configured", and `config.yml` ships with all three empty. No command result is recorded.
- **The CI check reads a summary that anyone can paste.** `ci-check.mjs` checks a JSON block in the PR description. It can't tell whether tests ran or whether the summary came from a real task.
- **Bash blocks are team-written text patterns.** The only default is `\bgit\s+commit\b|\bgh\s+pr\s+create\b`.
  - These slip past: `git -c x commit`, git aliases, `npm run release`, scripts.
  - Nothing guards push, force-push, migrations, `.env` or infra files.
- **Only Jira is supported** (`tracker: jira`, `rules/jira.md`).
- **The stage rules start empty.** All 11 `rules/*.md` files are stubs until `/shipline-setup` fills them.
- **The workflows are heavy.** Feature has 8 stages and 3 `confirm_to_advance` stages. Small, Hotfix and Bugfix exist. The only stage condition is `ui_only`.
- **One config per repo.** There are no per-package commands or rules, only `allow_paths` inside blocks.
- **Task records stay on one machine.** The reviewer sees only the stage table from `pr-summary`.

## The author's answers

- **Directions wanted:** all of them, in four groups:
  - real verification shown to reviewers;
  - harder guardrails;
  - right-sized workflows;
  - fitting any repo (tracker choice, day-one rules and commands, monorepos).
- **First adopters:** all kinds — product teams with reviewers, small or solo projects, client or regulated work, and monorepo or platform teams.
- **Bigger risk to adoption:** too much friction.
- **The friction that's real:** too many confirmations. Too many stages, a badly picked workflow, and block stages stopping legitimate work were *not* chosen.
- **Sequence:** friction first.

## The direction

- **Phase 1: lower friction.**
  - **Fewer confirmations.** Ideas so far:
    - team presets that set how many stages ask the developer;
    - approving the planned set of stages once at the start;
    - confirmations that turn on only for risky changes.
  - **Day-one setup:** `init` detects the test, lint and build commands and drafts the stage rules.
  - **Tracker choice:** Jira, GitHub Issues, Linear or none, using whichever connector is present. This follows the "skip when not connected" pattern from the Jira notice.
- **Phase 2: trust.**
  - Verify runs the configured commands, and `stage.mjs` records the exit codes and output tails.
  - Artifacts must contain their required sections.
  - The PR summary carries the plan scope, the verification checklist and the command results.
  - The CI check matches the summary to the task, for example with a hash.
- **Phase 3: harder rails and monorepos.**
  - Built-in protected actions (commit, push, force-push, PR, deploy, migration) that understand git's argument forms.
  - Protected paths that need a confirmation in any stage.
  - A few always-on rails.
  - Per-path command and rule overrides for monorepos.

## Limits raised

- Section checks can be gamed with empty headings.
- Slow test suites make Verify slower, and commands differ by machine and stack.
- Shell parsing can never be complete. It's defence in depth, not a sandbox, and it overlaps Claude Code's permission rules.
- Approving once, or using fewer confirmations, weakens the per-stage, answer-based confirmations from the Trust work (and so the CI check's "confirmed" column). Phase 1 has to balance this.
- Drafted rules can be wrong. Drafting them needs either a Claude call at `init` or heuristics.
- Monorepo overrides touch the config schema, the Setup UI and the CI check.
- Putting plan contents in PR descriptions makes them long, and may expose things a team wants kept out.
