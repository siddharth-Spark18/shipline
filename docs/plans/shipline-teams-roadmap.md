# Shipline for teams: roadmap

**Status:** Approved
**Source:** `.claude/research/teams-guardrails-workflows-2026-11-05.md` (ideation, 2026-11-05)

**Goal:** make Shipline's guardrails and workflows fit any team, including product teams with reviewers, small or solo projects, client or regulated work, and monorepos, and make them genuinely helpful rather than ceremony.

The author's sequencing is **friction first**. Each phase gets its own detailed plan when work on it begins; this document only fixes the order and scope.

| Phase | Scope | Detailed plan |
| --- | --- | --- |
| 1 | **Fit any repo on day one.** `init` and `upgrade` detect test, lint and build commands (Node, Python, Go, Rust, Make). Every stage ships with real default rules instead of empty stubs. A "run `/shipline-setup`" nudge shows until setup has run. Choice of tracker (Jira or GitHub Issues), with the `jira` stage renamed to `ticket`. **Chat-first tasks:** a chat lists every task it worked on; the Tasks page and the sidebar's task grouping are removed; unfinished tasks with no chat show on the new-chat screen. | `shipline-teams-phase1.md` |
| 2 | **Trust.** Verify runs the configured commands, and `stage.mjs` records exit codes and output tails. Artifacts must contain their required sections. The PR summary carries the plan scope, the verification checklist and the command results. The CI check matches the summary to the task. | later |
| 3 | **Harder rails and monorepos.** Built-in protected actions (commit, push, force-push, PR, deploy, migration) that understand git's argument forms. Protected paths that need a confirmation in any stage. A few always-on rails. Per-path command and rule overrides for monorepos. | later |

**Decided against for now:**
- **Confirmations:** they stay as they are. The author chose not to change confirmation defaults, add presets, approve a task's stages once up front, or ask only on risky changes.
- **Out of every phase so far:** Linear, and creating or updating issues in a tracker.
