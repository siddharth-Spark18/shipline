import fs from 'fs';
import path from 'path';
import {
  StageContextDTO,
  TicketSessionContextDTO,
  effectiveEditPolicy,
  sessionLaunchPolicy,
  toClaudeAgentsJson,
} from '@shipline/shared';
import { SESSIONS_DIR, resolvePluginDir } from './paths';

export type Mode = 'chat' | 'terminal';

export interface LaunchInput {
  ctx: TicketSessionContextDTO;
  mode: Mode;
  /** The ticket's git worktree: Claude's working directory. */
  worktreePath: string;
  mcpUrl: string;
  mcpSecret: string;
  resumeSessionId: string | null;
}

export interface LaunchPlan {
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  sessionDir: string;
}

/** Tool name Claude Code uses for the `approve_tool_use` tool on the MCP server named "shipline". */
export const PERMISSION_PROMPT_TOOL = 'mcp__shipline__approve_tool_use';

const INLINE_LIMIT = 20_000;

export const sessionDirFor = (ticketId: string): string => path.join(SESSIONS_DIR, ticketId);

/**
 * Guide-rail state read by the plugin's hooks on every call. One Claude process serves the whole
 * ticket, so the current stage cannot be baked into launch flags: it is rewritten here on each
 * stage change and (by the session's 5s context refresh) whenever a rule, role or policy changes
 * in the hub. It carries the person's roles and the guardrail rules at every level so the guard
 * hook can refuse early. Hard enforcement stays server-side (approve_tool_use decides every call).
 */
export function writeStageState(ticketId: string, ctx: TicketSessionContextDTO): string {
  const dir = sessionDirFor(ticketId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stage: StageContextDTO | null = ctx.currentStage;
  const roleEditPolicy = effectiveEditPolicy(ctx.project.roles, ctx.project.editPolicy);
  const file = path.join(dir, 'stage.json');
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        stage: stage?.key ?? null,
        status: stage?.status ?? 'DONE',
        ticket: ctx.ticket.key,
        codeEdit: stage?.toolPolicy.allowCodeEdit && stage.status === 'IN_PROGRESS' ? roleEditPolicy : 'deny',
        roles: ctx.project.roles,
        worktree: ctx.ticket.worktreePath,
        rules: ctx.guardrails,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  return file;
}

/** Guidance for the stage types the template actually has (a custom template may lack any of them). */
function stageGuidance(ctx: TicketSessionContextDTO): string[] {
  const { ticket } = ctx;
  const has = (type: string): boolean => ctx.stages.some((s) => s.type === type);
  const lines: string[] = [];
  if (ctx.stages.some((s) => s.optional)) {
    lines.push(
      `Suggest skipping optional stages (${ctx.stages.filter((s) => s.optional).map((s) => s.name).join(', ')}) when they are not needed (propose_stage_transition, kind "skip", with the reason). If earlier work must change, propose kind "reopen".`,
    );
  }
  if (has('qa')) {
    lines.push('QA: ask the user each time whether they will test manually (they report results in chat) or the qa-bug-hunter agent should test against the plan.');
  }
  if (has('self_review')) lines.push('Self-review: use the reviewer agent on the branch diff against the plan, then fix findings.');
  if (has('raise_pr')) {
    lines.push(
      `Raise PR: commit and push with git and open the PR with \`gh pr create\` as the user. The PR title or the branch name must contain the ticket key: ${ticket.jiraKey ?? ticket.key}${ticket.jiraKey ? ` (the Shipline key ${ticket.key} also works). If the branch was created before the Jira ticket was linked, it keeps its name: put ${ticket.jiraKey} in the PR title` : ''}. If \`gh\` is missing or not signed in, tell the user to run \`gh auth login\`.`,
    );
  } else {
    lines.push('This template has no Raise PR stage: the chat is done when its last stage completes.');
  }
  if (has('resolve_comments')) lines.push('Resolve PR comments: the user sends you review comments; fix, commit and push.');
  const agents = ctx.stages.filter((s) => s.agentName);
  if (agents.length > 0) {
    lines.push(`Stage agents: ${agents.map((s) => `${s.name} uses the "${s.agentName}" agent`).join('; ')}.`);
  }
  return lines;
}

function buildSystemPrompt(ctx: TicketSessionContextDTO, workspace: string, contextDir: string): { prompt: string; usedDir: boolean } {
  const { ticket } = ctx;
  const lines: string[] = [
    `You are working inside Shipline in chat ${ticket.key}: ${ticket.title}.`,
    ticket.branch
      ? `Working directory: ${workspace} (a git worktree on branch ${ticket.branch}; base branch ${ctx.project.baseBranch}).`
      : `Working directory: ${workspace} (a git worktree, detached at the ${ctx.project.baseBranch} base branch). Shipline creates the named branch ${ticket.suggestedBranch} automatically just before your first file edit; do not create or switch branches yourself (except the fallback below).`,
    '',
    '## Jira (optional)',
    ticket.jiraKey
      ? `Linked Jira ticket: ${ticket.jiraKey}${ticket.url ? ` (${ticket.url})` : ''}. Its details are below.`
      : 'No Jira ticket is linked. In your FIRST reply, ask the user whether there is a Jira ticket for this work. If there is, use search_jira_issues (or get_jira_issue when they give a key), confirm it is the right one, then call link_jira_issue; its details become your context. If there is none, carry on: this chat is tracked as ' +
        ticket.key +
        '. These tools are read-only towards Jira.',
    '',
    '## How Shipline works',
    `Workflow template: ${ctx.template.name} (v${ctx.template.version}). Stages, in order: ${ctx.stages.map((s) => `${s.name}${s.optional ? '*' : ''}`).join(' > ')} (* optional). You stay in ONE conversation for the whole chat.`,
    'Shipline posts messages starting with "[Shipline]" when the stage changes; follow the stage instructions in the latest one.',
    'Produce each stage\'s artifact with submit_artifact, then call propose_stage_transition (kind "complete") and wait: the user confirms or says "Not yet". Never assume it was confirmed.',
    ...stageGuidance(ctx),
    ...(ctx.switchableTemplates.length > 0
      ? [
          `If the work clearly fits another template (${ctx.switchableTemplates.map((t) => t.name).join(', ')}), call propose_template_switch with the reason before the first file edit; the user confirms. After the branch exists it is no longer possible.`,
        ]
      : []),
    `Fallback: if you are about to commit and \`git rev-parse --abbrev-ref HEAD\` prints HEAD (still detached, e.g. in terminal mode), run \`git switch -c ${ticket.suggestedBranch}\` first.`,
    'Stay within the guardrails: if a tool call is denied (by a rule such as "Org rule: ..." or "Project rule: ...", by the stage, or by the user\'s role, for example "Designers can\'t edit code"), do not work around it; tell the user what was denied and why.',
    '',
    ticket.jiraKey ? '## Jira ticket' : '## Chat',
    ticket.description || '(no description)',
  ];
  let usedDir = false;
  for (const a of ctx.doneArtifacts) {
    lines.push('', `## Finished stage artifact: ${a.stageName} v${a.version} (${a.type})`);
    if (a.type === 'MARKDOWN' && a.content.length <= INLINE_LIMIT) {
      lines.push(a.content);
    } else {
      const ext = a.type === 'HTML' ? 'html' : 'md';
      const file = path.join(contextDir, `${a.stageKey}-v${a.version}.${ext}`);
      fs.writeFileSync(file, a.content, { mode: 0o600 });
      usedDir = true;
      lines.push(`Large or non-markdown artifact; read it from ${file}`);
    }
  }
  return { prompt: lines.join('\n'), usedDir };
}

export function buildLaunchPlan(input: LaunchInput): LaunchPlan {
  const { ctx, mode } = input;
  const sessionDir = sessionDirFor(ctx.ticketId);
  const contextDir = path.join(sessionDir, 'context');
  fs.mkdirSync(contextDir, { recursive: true, mode: 0o700 });

  const policy = sessionLaunchPolicy();
  const stateFile = writeStageState(ctx.ticketId, ctx);

  // Guide rails for the plugin's hooks. Hard enforcement is server-side (approve_tool_use + gates check).
  // In chat mode the read and web tools Claude Code would run unasked are set to "ask": that routes
  // them through approve_tool_use, where the server applies read and tool rules. (Terminal mode has
  // no permission prompt tool, so it relies on the guard hook alone for those.)
  const settingsFile = path.join(sessionDir, 'settings.json');
  fs.writeFileSync(
    settingsFile,
    JSON.stringify(
      {
        env: { SHIPLINE_TICKET: ctx.ticket.key, SHIPLINE_STATE_FILE: stateFile },
        ...(mode === 'chat' ? { permissions: { ask: policy.alwaysAsk } } : {}),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );

  const mcpFile = path.join(sessionDir, 'mcp.json');
  fs.writeFileSync(
    mcpFile,
    JSON.stringify(
      {
        mcpServers: {
          shipline: {
            type: 'http',
            url: input.mcpUrl,
            headers: { Authorization: `Bearer ${input.mcpSecret}`, 'X-Shipline-Ticket': ctx.ticketId },
          },
        },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );

  const { prompt, usedDir } = buildSystemPrompt(ctx, input.worktreePath, contextDir);

  const args: string[] = [];
  if (mode === 'chat') {
    args.push(
      '-p',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-prompt-tool',
      PERMISSION_PROMPT_TOOL,
    );
  }
  args.push(
    '--settings',
    settingsFile,
    '--mcp-config',
    mcpFile,
    '--plugin-dir',
    resolvePluginDir(),
    '--permission-mode',
    policy.permissionMode,
    '--allowedTools',
    policy.allowedTools.join(','),
    '--append-system-prompt',
    prompt,
  );
  if (policy.disallowedTools.length > 0) args.push('--disallowedTools', policy.disallowedTools.join(','));
  if (usedDir) args.push('--add-dir', contextDir);
  // Custom agents the pinned template version's stages use, defined by org admins in Admin.
  if (ctx.customAgents.length > 0) args.push('--agents', JSON.stringify(toClaudeAgentsJson(ctx.customAgents)));
  if (input.resumeSessionId) args.push('--resume', input.resumeSessionId);

  // `--bare` ignores the user's subscription login, so it must never reach the CLI.
  if (args.includes('--bare')) throw new Error('Refusing to launch claude with --bare');

  return { args, env: { ...process.env }, cwd: input.worktreePath, sessionDir };
}
