# Shipline for teams: roadmap

**Status:** Approved
**Sources:**
- `.claude/research/teams-guardrails-workflows-2026-11-05.md` (ideation, 2026-11-05)
- `.claude/research/ai-dev-guardrails-synthesis-2026-11-05.md` (deep research on how AI-heavy orgs use guardrails and workflows, 2026-11-05; it reshaped Phases 3–6)

**Goal:** make Shipline's guardrails and workflows fit any team, including product teams with reviewers, small or solo projects, client or regulated work, and monorepos, and make them genuinely helpful rather than ceremony.

The author's sequencing was **friction first** for Phases 1–2. After the 2026-11-05 research it's **guardrails, then lighter confirmations, then reach, then monorepos**. Each phase gets its own detailed plan when work on it begins; this document only fixes the order and scope.

| Phase | Scope | Detailed plan |
| --- | --- | --- |
| 1 | **Fit any repo on day one.** `init` and `upgrade` detect test, lint and build commands (Node, Python, Go, Rust, Make). Every stage ships with real default rules instead of empty stubs. A "run `/shipline-setup`" nudge shows until setup has run. Choice of tracker (Jira or GitHub Issues), with the `jira` stage renamed to `ticket`. **Chat-first tasks:** a chat lists every task it worked on; the Tasks page and the sidebar's task grouping are removed; unfinished tasks with no chat show on the new-chat screen. | `shipline-teams-phase1.md` |
| 2 | **Trust.** Verify runs the configured commands, and `stage.mjs` records exit codes and output tails. Artifacts must contain their required sections. The PR summary carries the plan scope, the verification checklist and the command results. The CI check matches the summary to the task. | `shipline-teams-phase2.md` |
| 3 | **Guardrails.** Built-in always-on rails for what AI-heavy orgs commonly block: force-push and pushing to the default branch, deploys and migrations, `curl \| bash`, reading or printing credentials, and the agent editing its own config (`.claude/`, `.shipline/`, settings). Named protected actions that understand git's argument forms (`git -c x commit`, `&&` chains, package scripts), with `{ bash: regex }` still allowed. Protected paths (`migrations/`, `infra/`, `.env*`, CI config) that go through Claude Code's permission prompt (the hook's `ask`) in any stage. **Verify anti-gaming checks:** flag diffs that touch tests, lint config or CI files, and compare the diff with the plan's "Files to touch". Docs say plainly that hooks are defence in depth, and point to Claude Code's sandbox and managed settings for real enforcement. | `shipline-teams-phase3.md` |
| 4 | **Lighter confirmations.** A preset that asks only at Plan approval, failed checks and required skips, following the evidence that human checkpoints belong at plan and merge, with the middle advancing on deterministic checks. Today's confirmations stay available. | `shipline-teams-phase4.md` |
| 5 | **Reach.** Ship Shipline as a Claude Code plugin or marketplace entry that org-managed settings can pre-install. A "this block was wrong" feedback path for tuning and a warn-then-block pilot. Mark which controls are advisory (rules, skills) and which are enforced (hooks, CI). | later |
| 6 | **Monorepos.** Per-directory commands, rules and ownership, layered the way Claude Code layers CLAUDE.md. | later |

**Shipping before Phase 3:** the setup wizard (`shipline-setup-wizard.md`, 0.12.0): install from the browser with nothing written until Install, only the files the choices need (`init --yes` is trimmed too), and Add shipped workflow in Setup. Phase 5's plugin distribution builds on it.

**Decided against for now:**
- **Confirmations (Phase 1 decision, revised by the research):** the current confirmations stay as they are. Phase 4 adds a lighter preset rather than changing the defaults.
- **Out of every phase so far:** Linear, and creating or updating issues in a tracker.
