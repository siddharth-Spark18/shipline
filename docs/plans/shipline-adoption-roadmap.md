# Shipline adoption roadmap

**Status:** Approved
**Source:** `.claude/research/shipline-adoption-review-2026-11-04.md` (adoption review, 2026-11-04)

**Goal:** turn Shipline into something you can recommend across the organization. That means removing the problems that would make developers stop using it, or never start. Each phase gets its own detailed plan in `docs/plans/` when work on it begins. This document only fixes the order and scope of the phases.

| Phase | Scope | Detailed plan |
| --- | --- | --- |
| 1 | Publish as `@forgeyard/shipline` (rename, fix every reference, tag-triggered publishing). Move all task metadata out of the repo to `~/.shipline/projects/<encoded-path>/`. Add `shipline upgrade`, with hash-tracked updates and the storage migration. | `shipline-phase1-storage-upgrade-publish.md` |
| 2 | Install: interactive `init` that lets a team choose which Shipline agents and skills to add, bring their own, and resolve name collisions instead of aborting. Also `shipline uninstall`, and a Node preflight with a clear message for repos without Node. | later |
| 3 | Daily friction: fewer prompts and stages for small changes, including a way to skip the workflow for trivial edits. Jira working in the `-p` browser chat. | later |
| 4 | Trust: define what "enforced" means, given that stage progress (`--confirmed`, `--force`) is reported by Claude itself. Consider a CI gate check. Run the chat test (item 19 of `.claude/plans/shipline-local-ui.md`) and close the `UNVERIFIED` items. Fix the child process left running after a chat is stopped. | later |
| 5 | Proof and rollout: a README centred on the CLI, removing the hub apps (`apps/*`, `packages/shared`, `packages/plugin`), and Windows support. Usage metrics were dropped by the author. | `shipline-cleanup-rollout.md` |

Order chosen by the author: Phase 1, then install, friction, trust, rollout.

**Notes (2026-11-04):**
- Phase 5 is covered by `shipline-cleanup-rollout.md`, minus metrics (dropped).
- The rest of Phase 2 (Node preflight) and Phase 3 (Jira in the `-p` chat) move into a separate *Chat reliability* plan.
- Phase 4 (Trust) is its own plan.
