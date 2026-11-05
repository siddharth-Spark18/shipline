# Guardrails and workflows in AI-assisted development: what it means for Shipline

**Date:** 2026-11-05. This combines four deep research reports in this folder:

1. `ai-dev-guardrails-1-guardrail-types-2026-11-05.md`: the kinds of guardrails, and what agent tools ship.
2. `ai-dev-guardrails-2-workflows-2026-11-05.md`: workflows, staging, human checkpoints.
3. `ai-dev-guardrails-3-verification-review-2026-11-05.md`: verification, review, failure modes.
4. `ai-dev-guardrails-4-governance-adoption-2026-11-05.md`: governance, monorepos, rollout, why people abandon tools.

Claims carry the reports' own source labels (primary, secondary or vendor). The "Implications" sections are this synthesis's inference, not sourced facts.

## What the evidence says

### 1. Freedom inside a hard boundary

- **Isolate first, then let the agent run.** The orgs that publish detail isolate the environment and then give the agent freedom inside it.
  - **Stripe Minions:** full permissions with no prompts, but on devboxes with no production data, no arbitrary network egress, curated tools, capped CI rounds and mandatory human review.
- **Local agents get the same layers from every vendor:**
  - an OS sandbox (filesystem scoped to the workspace, network on an allowlist);
  - deny > ask > allow rules;
  - protected agent and config paths (`.git`, `.claude`, shell rc files, `.npmrc`, `.mcp.json`);
  - a classifier or prompts for the middle band;
  - org-managed policy developers can't weaken.
- **The most consistently blocked actions:**
  - force-push and history rewrites;
  - pushing to main or deploy branches;
  - production deploys and migrations;
  - infra destruction (`terraform destroy`);
  - `curl | bash`;
  - reading or printing credentials;
  - the agent editing its own permissions or config.
- **Command-text matching can be bypassed.** Anthropic's docs pair deny rules with the sandbox's network allowlist for this reason. Hooks don't block on errors by default: only exit 2 or `onFailure: "block"` blocks. Only managed settings with `allowManagedHooksOnly` resist tampering.
- **No vendor protects migrations, infra or CI paths by default.** Teams get that at merge time, through branch protection, CODEOWNERS and required review. (Report 1, inference.)

### 2. Prompts are approved almost reflexively

- Anthropic reports **93% of permission prompts are approved**, and an 84% drop in prompts with the sandbox. Approval fatigue is why it built auto mode.
- **Noise kills adoption.** Google's static-analysis history: tools stuck only with workflow integration, a "not useful" button and false-positive rates tracked continuously. Slow hooks get bypassed (`--no-verify`, anecdotal).

### 3. Workflows: gate the ends, automate the middle

- **No large org publishes a ticket → feasibility → plan → implement → verify → PR ritual.**
- **Interactive spec-first tools** (GitHub Spec Kit, Amazon Kiro) have a human approve each artifact. Anthropic's own guidance is lighter: the default prompt usually works, an optional spec interview, and "give it a check to run".
- **Unattended pipelines** (Stripe, Spotify) put the workflow in the harness:
  - deterministic steps (lint, push) around agent steps;
  - capped retries;
  - an LLM judge that vetoes about 25% of sessions, mostly for **scope creep**;
  - humans define the task and approve the merge.
- **Best supported human checkpoints:** plan approval and merge. Evidence for confirmations in the middle of a run is thin.
- **Setup beats model choice.** In Microsoft .NET's data, agent PR success rose from 38% to 69% mostly from an instructions file, build access and skills. **Small changes succeed more:** 1–50 lines about 76–80%, 101–500 lines 64%.
- **Review capacity is the bottleneck.** PR volume grows faster than reviewers. Faros (vendor) reports 91% longer review times.
- **Multi-agent:** a single writer plus a fresh-context reviewer works. Parallel writers see little adoption.
- **Tickets:** they trigger work, and well-scoped issues with acceptance criteria delegate best. The human assignee stays accountable. GitHub's agent PR can't be approved by the person who requested it.

### 4. Verification: deterministic checks plus an independent human

- **Agents run lint and tests locally, CI runs fully, retries are capped, and a human approves.** Nobody trusts the agent's claim that tests pass.
- **Gamed tests are the most documented failure mode** (ImpossibleBench): agents edit tests, overload equality, or special-case. Countermeasures:
  - read-only tests;
  - hidden tests;
  - strict prompts;
  - an "abort to human" flag.
  
  LLM monitors catch only 42–89%.
- **About half of SWE-bench-passing patches wouldn't be merged** (METR), for quality, breakage elsewhere, or missing functionality. Green tests aren't enough.
- **AI review bots are advisory almost everywhere.** Cloudflare is the exception: it blocks on critical findings, with a break-glass override.
- **Attribution is convention, not a gate:** trailers, session-log links, and the Copilot agent's signed, co-authored commits. There's **no public precedent** for fingerprinting the exact code that was verified. Shipline's Phase 2 is novel there. The nearest analogues are GitHub's "require approval of the most recent push" and merge queues.

### 5. Governance and adoption

- **Layers:**
  1. an org-enforced floor (managed settings, enterprise rulesets);
  2. repo conventions owned by code owners;
  3. personal overrides.
  
  Anthropic separates *advisory* controls (CLAUDE.md, skills) from *enforced* ones (permissions, sandbox, hooks, plugin and MCP allowlists).
- **Monorepos:**
  - `.claude/settings.json` isn't inherited by subfolders;
  - per-directory CLAUDE.md, rules and skills carry the conventions;
  - the documented failure is "conventions drift, files go stale, no one owns the root";
  - the vendor's fix is a platform-owned plugin or internal marketplace, installed through managed settings, plus telemetry on unused skills.
- **Compliance (SOC 2):** the same change-management gate as for human code, plus attribution (agent, model) and logs the agent can't alter. No regulator guidance was found.
- **Measurement:**
  - DORA 2025: AI raises throughput but correlates with worse stability, and about 30% of respondents distrust AI code. It frames AI as an amplifier: small batches, strong version control and good internal platforms matter.
  - Productivity studies conflict: Google's RCT showed +21%, METR's −19%.
- **Rollout:** a named owner (usually the platform or developer-experience team), tooling that works on day one, champions, phased rollout, and reviewing the config every 3–6 months. Bottom-up adoption fragments.

## Implications for Shipline (inference)

**Where the current direction is confirmed:**
- Answer-based confirmations at plan and verify.
- Running deterministic checks in Verify, rather than trusting Claude's account (Phase 2).
- The code fingerprint plus the CI comparison (Phase 2). It's ahead of public practice.
- Day-one setup, detected commands and default rules (Phase 1). Setup beats model choice.
- Friction as the main adoption risk, and fail-open hooks.

**Where the evidence suggests a change:**

1. **Confirmations mid-run are the weakest-supported part of the default workflows.** Feature asks at Open questions, Plan and Verify. The evidence supports plan approval and merge, while the middle should auto-advance on deterministic checks. The author chose to keep confirmations (2026-11-05). This is worth revisiting with the data, for example a light preset that asks only at Plan, Verify-failures and skips.
2. **Phase 3 guardrails should match what's commonly blocked, and use `ask`, not regexes, for paths.**
   - Built-in always-on rails: force-push and pushing to the default branch, deploys and migrations, `curl | bash`, credentials, and the agent editing its own config (`.claude/`, `.shipline/`, settings).
   - Protected paths through the hook's `ask`.
   - Say plainly that it's defence in depth. Recommend Claude Code's sandbox and managed settings for real enforcement.
3. **Two cheap anti-gaming checks for Verify:**
   - flag diffs that touch tests, lint config or CI config (show them in the PR summary, and optionally ask);
   - a scope check of the diff against the plan's "Files to touch" (Spotify's judge vetoes mostly for scope creep).
4. **Review capacity:**
   - keep the PR evidence (Phase 2) compact;
   - add a size signal (lines changed, with an "over 500 lines: consider splitting" note);
   - say who must approve. That's handled by branch protection, which Shipline can document.
5. **Distribution and governance:**
   - offer Shipline as a Claude Code plugin or marketplace entry that org-managed settings can pre-install;
   - mark which controls are advisory (rules and skills) and which are enforced (hooks and CI);
   - optionally emit an audit log the agent can't change.
6. **Monorepos:** per-directory rules, commands and ownership, matching how Claude Code already layers CLAUDE.md. Phase 3b stays a good split.
7. **A feedback path:** a "this block was wrong" signal (Tricorder's "not useful" lesson), which also gives a warn-then-block pilot mode real data.

## Gaps in the evidence

- No first-party guardrail detail from Google, Microsoft, Meta, Shopify, Airbnb or Coinbase internals. Vendor features stand in for them.
- No hotfix-specific agent workflow published anywhere.
- No outcome data comparing spec-first with ad-hoc AI coding.
- No regulator or AICPA guidance on AI-written code.
- No abandonment data for agent hooks specifically.
