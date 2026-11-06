# Shipline product retrospective (0.14.0, 2026-11-06)

A step back after Teams Phases 1–4, the setup wizard and chat reliability. It draws on two read-only passes: a first-time-user walkthrough in scratch repos, and a code and claims audit. Claims were checked against the code; one audit claim was corrected (see Tech debt).

## What's good
- **The core loop works.** A Small change task went from start to PR summary with no errors.
- **Guardrails fired correctly:** commit before Verify denied, `cat .env` denied. Refusal messages are specific and say what to do.
- **Install is careful:** it merges `CLAUDE.md` and `settings.json`, keeps the user's own agents, and uninstall restores existing files (it does reformat `settings.json`).
- **Command detection** works for Node and Python.
- **The UI server's security is sound:** 127.0.0.1 only, exact Host check, token exchanged for an HttpOnly SameSite=Strict cookie, Origin checked on POSTs.
- **Hook overhead** is about 25 ms per tool call.

## What's wrong

### Blocks adoption
- **Never published.** `npm view @forgeyard/shipline` returns 404 and there are no git tags. `docs/plans/shipline-v2-repo-init.md` says it's published, which is false.
- **License:** `UNLICENSED`, with no LICENSE file. There's no CHANGELOG either.

### Guardrail gaps (verified against guard.mjs)
- **Case-sensitive matching** (`guard.mjs:83`, `lib.mjs:952,962`): `.CLAUDE/settings.json`, `Claude.md`, `.Shipline/config.yml` and Read of `.ENV` all pass on macOS and Windows.
- **Grep and Glob aren't in the hook matcher** (`templates/settings-hooks.json:24`), so Grep can print `.env`.
- **A store error fails open before any rail runs** (`guard.mjs:166,171,284`), so even the force-push deny is skipped.
- **A broken config with no active task** turns the rails off without any message (`guard.mjs:184-207`).
- **The CI check runs the PR head's own `ci-check.mjs` and `config.yml`** (`templates/github/shipline.yml:20-21`), so a PR can switch it off.
- **Unmatched readers and files:**
  - readers: `tac`, `nl`, `jq`, `od` and `sort` on `.env`;
  - files: `.netrc`, `~/.git-credentials`, `~/.docker/config.json`, `*.p12`, `credentials.json`, `.envrc`;
  - `bash <(curl …)`;
  - `$HOME/.shipline` writes, which `bashReachesProgress` misses.

### CLI and first-run issues
- **`init --dry-run`** refuses without a terminal; only `--dry-run --yes` works.
- **Help and version flags:**
  - `init --help` runs init;
  - `ui --help` reports an unknown option;
  - `--version` prints usage and exits 1 (`bin/shipline.mjs:57`).
- **Argument parsing:** the first non-`--` argument becomes the target folder (`upgrade -y` targets a folder named `-y`), and unknown flags are ignored.
- **Init outside a git repo** succeeds silently; `check` then passes having run nothing.
- **The file count is one short** (`init.mjs:126`), and the guard's deny message is missing a sentence break (`guard.mjs:260`).
- **The uninstall preview** lists excluded agent files that were never installed (`uninstall.mjs:190`).
- **The section check:** fewer than 20 characters is reported as "(empty)" (`lib.mjs:600`).
- **The tracker** defaults to Jira for any repo without a GitHub remote, so every task starts with a ticket stage to skip.
- **Small change gets contradictory instructions:** the UserPromptSubmit hook says to ask the developer, while the skill says to start without asking.
- **The scope line** mentions a plan in workflows that have no plan stage.
- **`status` is noisy:** it prints the full rules, long store paths and `ui=null`.
- **`stage.mjs` can't really be used by a human**, though the README suggests it can: it needs a session id, and confirmations need AskUserQuestion.
- **A detected tool that isn't installed** (for example pytest) only shows up later as exit 127.
- **The "needs Node" echo** shows on any non-zero exit (`settings-hooks.json:8`).
- **`@inquirer/prompts` needs Node 20.17**, while the package's engines field says ≥18.
- **`prepack` needs pnpm.**

### Tech debt
- **Upgrade machinery for versions nobody installed:** hashes from 0.6.0 to 0.13.0, INTERFACE 1 to 7, `MISSING_BEFORE`, legacy `artifact_root`, and rails off for upgraded repos.
- **`RAIL_IDS` is defined 3–4 times**, and the UI keeps its own copy of `needsAnswer`.
- **`lib.mjs` is 1530 lines** and vendored, so every edit needs a hash and an INTERFACE check.
- **Rails differ by install path:** a fresh install gets strict rails, an upgraded repo has them all off.
  - The audit said teammates on the same repo get different rails. That's wrong, because `config.yml` is committed and shared.
- **Windows CI is flaky:** the process-kill tests (`relay.test`, `shell.test`, and earlier `setup.test`) pass on rerun.

### Missing
- **No usage data or error reporting**, so it's unknown how often rails fire or hooks fail open.
- **No docs site, example repo or quickstart.** The README is 363 lines with no first task early on.
- **The store is keyed by the absolute path,** so worktrees don't share tasks and moving a repo strands them.
- **Chat depends on undocumented `claude` stream-json control requests,** with a minimum version but no maximum, and no test against a real `claude`.
- **Nothing has been hand-tested** in an interactive Claude Code session: guardrails, light confirmations or the scope question.

## Direction
- **Audience:** the author's own team, soon. Published publicly on npm as `@forgeyard/shipline`, MIT.
- **One 1.0 release combining:**
  - **A. Ship 1.0:**
    - LICENSE, a publish pipeline, tags and a CHANGELOG;
    - the upgrade history reset to a 1.0 baseline (approved: only the author's repos are affected);
    - CLI fixes;
    - Windows flake fixes.
  - **B. Guardrail hardening:** the gaps listed above.
  - **C. First-run experience:** a quickstart README and possibly an example repo, a tracker default, init warnings, honest messages, a quieter status, consistent Small change instructions.
- **Deferred:**
  - D: hand-testing and a pilot, best done as the last step of 1.0;
  - E: team insights;
  - F: Phase 5 reach and Phase 6 monorepos.
