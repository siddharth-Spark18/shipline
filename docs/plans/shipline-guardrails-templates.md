# Shipline: configurable guardrails and workflow templates — Plan

> Historical: describes the v1 hub, which was removed in the cleanup-rollout change (branch `feat/cleanup-rollout`, after `5fb8a72`).

Status: approved 2026-10-29. Builds on `docs/plans/shipline-v1.md` (incl. revision (b), chat-first). This phase brings in what v1 listed as out of scope ("custom workflow-builder UI").

## Problem & Goal

**Problem:**
- Every project gets the same hardcoded Feature/Hotfix flow, though projects need different flows (a backend repo has no Wireframes; a design repo has no Build).
- There is no way to protect sensitive areas (e.g. `.env`, migrations, infra) or block dangerous commands.
- Teams can't add their own steps (e.g. "Security review").
- Role limits are a single allow/ask/deny for code edits.

**Goal:** org admins define workflow templates and baseline guardrails once; project admins choose which templates a project uses and add project and role rules. Every Claude tool call is decided against all applicable rules, server-side.

**Success:**
- An org rule `deny edit **/.env*` blocks Claude in every project, and the denial names the rule.
- A custom "Backend feature" template (no Wireframes, plus a custom "Security review" stage) runs end to end in a Learnloop chat.
- `ask` on `git push --force*` prompts; a Designer role rule denies Bash `npm *`.

## Scope

### In

**Guardrail rules**
- **Three rule kinds:**
  - **Path rules:** a glob, an action (`read` and/or `edit`), and an effect (`allow | ask | deny`). Example: deny edit `prisma/migrations/**`; deny read+edit `**/.env*`.
  - **Bash command rules:** a command pattern in Claude Code's permission-rule style (e.g. `Bash(git push --force:*)`, `Bash(rm -rf:*)`, `Bash(npm install:*)`; `:*` means "this prefix, then anything"; an exact form without `:*` matches only that command) and an effect.
  - **Tool rules:** a tool name (`WebFetch`, `WebSearch`, `NotebookEdit`, an MCP server `mcp__<server>__*` or a single MCP tool) and an effect.
- **Every rule has a short reason**, shown to the user and to Claude on deny or ask.
- **Four levels:**
  1. **Org baseline:** applies to every project.
  2. **Project:** applies to every chat in the project.
  3. **Role (per project):**
     - Rules per role (Developer, Designer, PM, QA).
     - The existing per-role code-edit policy (`Project.editPolicy`) becomes this level's default edit rule and stays editable.
     - A person with several roles gets the most permissive role, as today.
  4. **Stage:** rules stored on a template stage, plus the existing stage tool policy (allow code edit, bash mode, read-only tools).
- **Combination: strictest wins.**
  - All matching rules from every level are collected.
  - Any `deny` gives deny. Otherwise any `ask` gives ask. Otherwise allow.
  - Lower levels can only tighten.
  - The reason names the winning rule and its level, e.g. "Org rule: Never touch env files".
- **Enforcement:**
  - The server decides every call in `approve_tool_use`, through `decideToolUse` extended in `packages/shared/src/policy.ts`. This is the hard enforcement.
  - Read rules also apply to Read, Grep and Glob path arguments. Bash is matched by command.
  - Shipline Local writes the effective rules into the hooks' state file, so the plugin guard hook can refuse early. This is a guide rail only, refreshed every 5s as today.

**Workflow templates**
- **An org-level library of templates.** Built-in Feature and Hotfix are seeded as editable templates.
- **Each project enables a subset and picks a default.**
- **Stage types:**
  - Built-in types keep their special behaviour: Research, Plan, Wireframes, Build, QA, Self-review, Raise PR, Resolve PR comments.
  - A **Custom** type is instructions + guardrails + artifact only.
- **What org admins can edit per template:**
  - name and description
  - add, remove and reorder stages (drag)
  - per stage:
    - name, type
    - instructions (the text Claude gets when the stage starts)
    - agent (a plugin agent or a custom agent)
    - optional or not
    - required for `shipline/gates`
    - artifact types
    - the stage tool policy and stage rules
- **Validation (save is blocked with a clear message):**
  - at most one stage of each built-in type
  - Build before Self-review and QA, and those before Raise PR
  - Resolve PR comments immediately after Raise PR
  - Raise PR requires Build
  - gate-required stages must come before Raise PR
  - at least one stage
  - Raise PR is **not** required. A template without it (e.g. design-only) ends Done when its last stage completes, and no gate applies.
- **Versioning:**
  - Saving a template creates a new immutable version.
  - A chat is pinned to the version it started on (stages, instructions, stage rules, stage agent).
  - New chats get the latest version.
  - Org, project and role guardrails are **not** versioned and always apply live.
- **Archive, not delete:**
  - A template with any chat on any of its versions can only be archived. Archived templates can't be picked for new chats.
  - Never-used templates can be deleted.
- **JSON export/import** per template. Import creates a new template, or a new version of the same-named one, after validation.

**Custom agents**
- Org admins define agents in the UI: name, description, prompt, allowed tools, and an optional model.
- A stage can use a plugin agent (from the bundled plugin's manifest) or a custom agent.
- Shipline Local passes the custom agents to `claude` with the `--agents` JSON flag at session start.
- Agents defined in the repo's own `.claude/` still load as Claude Code normally does, but can't be chosen per stage in this phase.

**Choosing a template for a chat**
- The new-chat screen preselects the project's default; the user can pick any template the project has enabled. This replaces the Feature/Hotfix toggle.
- Claude can propose switching templates early in a chat with `propose_template_switch` (e.g. "this looks like a hotfix"). It uses the same inline Confirm / Not yet card.
  - Switching is allowed only until the first edit (before the branch exists).
  - Done stages carry over when the new template has a stage of the same type; the rest start fresh.

**Who edits**
- **Org admins (`User.isAdmin`):** the template library, custom agents and the org baseline.
- **Project admins:** which templates are enabled, the project default, project rules and role rules.

**UI (shadcn)**
- **Admin module:**
  - **Workflow templates:** list (with active/archived/version/in-use counts) → editor.
    - Stage list with drag reorder.
    - A stage drawer (Sheet) for the stage fields and rules.
    - Inline validation errors.
    - Version history (read-only view of past versions).
    - Export and import JSON.
  - **Custom agents:** list and form.
  - **Org guardrails:** a rules table (kind, pattern, action, effect, reason) with add, edit and delete.
- **Project settings:**
  - **Templates card:** enable checkboxes plus a default select (replaces the read-only TemplatesCard).
  - **Guardrails card:**
    - Project rules table.
    - Per-role tabs, each with that role's rules and its code-edit default (absorbs EditPolicyForm).
    - A read-only "Inherited from org" section.
- **Chat:**
  - Denied/asked tool chips and prompts show the rule's reason and level.
  - The stage popover shows the template name and version.

### Out
- Network/domain rules
- Moving a running chat to a newer template version
- A rule-testing playground or simulator
- Choosing the repo's own `.claude/` agents per stage
- Multi-tenant orgs (`User.isAdmin` stays the org admin)

## Surface Area

- **`packages/shared`:**
  - `guardrails.ts` (new):
    - rule types (`PathRule`, `BashRule`, `ToolRule`, with level, effect and reason)
    - glob matching for paths and commands (picomatch-style)
    - `evaluateRules` (strictest wins, returns the winning rule)
  - `policy.ts`: `decideToolUse` takes the effective rule set, and keeps role and stage policy as inputs.
  - `stages.ts`:
    - stage types replace hardcoded keys as the special-behaviour switch (`STAGE_KEYS` becomes `STAGE_TYPES`)
    - built-in templates become seed data only
    - template validation (`validateTemplate`)
  - DTOs for templates and versions, rules, custom agents, and template export.
- **`apps/api`:**
  - **Prisma:**
    - `WorkflowTemplate`: drops the `key` enum. Gains id, name, description, `archivedAt`, `builtIn`.
    - `WorkflowTemplateVersion`: version number, createdBy, createdAt.
    - `StageDefinition`: belongs to a version. Adds `type`, `agentRef` (plugin agent name or custom agent id) and stage rules Json.
    - `ProjectTemplate`: project, template, `isDefault`.
    - `GuardrailRule`: scope `ORG | PROJECT | ROLE`, projectId?, role?, kind, pattern, action?, effect, reason, createdBy.
    - `CustomAgent`.
    - `Ticket.templateVersionId` replaces `templateId`.
    - Migration: seed Feature and Hotfix as v1. Existing chats point at v1 (or a dev reset).
  - **Routes:**
    - admin CRUD for templates, versions, agents and org rules
    - project templates and project/role rules
    - template export/import
  - **MCP:** add `propose_template_switch`. `get_ticket_context` includes the template name and version.
  - **Services:**
    - `tool-decision.service` gathers org + project + role rules (live) and the stage rules of the pinned version, then calls `decideToolUse`.
    - Gates use the pinned version's `requiredForGate` stages.
    - Transitions and stage state read stages from the pinned version.
- **`apps/local`:**
  - `writeStageState` includes the effective rules.
  - The launch plan adds `--agents` with the custom agents that the pinned version's stages use.
  - The stage-change message names the stage's agent.
- **`packages/plugin`:**
  - The guard hook evaluates path, bash and tool rules from the state file (shared matcher bundled).
  - The plugin agent manifest is exposed so the hub can list the agents.
- **`apps/web`:** the Admin pages (templates, editor, version history, agents, org guardrails), the project settings cards, the new-chat template picker, the switch card in the chat, and rule reasons on chips.

## Behavior & Edge Cases

- **Rule matching:**
  - Paths are matched relative to the worktree root; absolute paths outside the worktree count as outside and are matched by absolute glob.
  - Bash commands use Claude Code's `Bash(prefix:*)` matching, applied per sub-command (split on `&&`, `||`, `;`, `|`), and the strictest result wins.
  - Patterns are validated on save (an invalid glob is rejected).
- **No matching rule:** fall back to today's behaviour (stage tool policy plus role edit default).
- **Ask:** uses the existing permission card, with the rule's reason. The existing timeout (5 min) means deny.
- **A rule changes mid-session:** the server applies it on the next call, and the guard hook within about 5s.
- **Template edited while chats run:** they stay on their version. The popover shows "v3 (latest v4)".
- **Project disables a template that running chats use:** those chats continue; only new chats lose the option.
- **Archived template:** existing chats continue; it can't be picked or switched to.
- **Import:**
  - Unknown stage types or agents are rejected with a message.
  - A custom agent referenced by name must already exist, or the import offers to create it from the bundled definition.
- **Custom agent deleted while a version references it:** blocked; archive the template first or change the stage.
- **Switch proposal after the branch exists:** the server rejects it, and Claude is told why.
- **Concurrent template edits by two admins:** the second save is rejected if the base version changed ("reload to see the newer version").

## Constraints

- Hard enforcement stays server-side in `approve_tool_use`. Hooks are guide rails.
- Never `--bare`, the Agent SDK or setup-token. `--agents` is a standard CLI flag of the unmodified `claude`.
- Every rule change and template version is written to the audit log (who, what, when).
- Rule evaluation must stay fast: it's in the path of every tool call, so the rule set is cached per project and invalidated on change.

## Verification

1. **Protected path:** an org rule "deny read+edit `**/.env*`" blocks Claude's Read and Edit of `.env` in a Learnloop chat. The chip shows "Org rule: …". The hook also refuses early.
2. **Custom template:** create "Backend feature" (Research*, Plan, Build, a custom Security review with its own instructions and a custom agent, QA, Self-review, Raise PR, Resolve). Enable it on Learnloop as default and run a chat end to end. The gate requires Security review.
3. **Bash/role rules:**
   - A project rule "ask `Bash(git push --force:*)`" shows the ask card with the reason.
   - A Designer role rule "deny `Bash(npm:*)`" denies it for a Designer and allows it for a Developer.
4. **Validation:** saving a template with Raise PR before Build is rejected with a message.
5. **Export/import:** export "Backend feature" and import it as a copy.

## Open Questions

1. ~~Bash pattern syntax~~ Decided 2026-10-29: Claude Code permission-rule style, `Bash(prefix:*)`.
2. Should the stage tool policy fields (allow code edit, bash mode) be expressed as stage rules, to have one model, or stay as separate toggles in the stage drawer?
3. Can project admins add stage-level rules for their project (e.g. extra rules for Build in Learnloop only), or are stage rules template-only?
