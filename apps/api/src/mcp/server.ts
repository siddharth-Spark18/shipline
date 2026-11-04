import { Router, Request } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import {
  ARTIFACT_TYPES,
  HEADER_APP_VERSION,
  HEADER_CLIENT,
  HEADER_PLUGIN_VERSION,
  HEADER_TICKET,
  TRANSITION_KINDS,
} from '@shipline/shared';
import { prisma } from '../lib/prisma';
import { HttpError } from '../lib/http-error';
import { mcpAuth } from '../middleware/auth';
import { proposeTransition, submitArtifact } from '../services/workflow.service';
import { getSessionContext } from '../services/context.service';
import { listChats } from '../services/chat.service';
import { getIssueForChat, linkIssueToChat, searchIssuesForChat } from '../services/jira-ticket.service';
import { decideToolRequest } from '../services/tool-decision.service';
import { proposeTemplateSwitch } from '../services/template-switch.service';

interface McpContext {
  userId: string;
  ticketHeader: string | null;
  pluginVersion: string | null;
  appVersion: string | null;
  client: string;
}

const hdr = (req: Request, name: string): string | null => {
  const v = req.headers[name];
  return typeof v === 'string' && v ? v : null;
};

const text = (value: unknown) => ({
  content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});

async function safely(fn: () => Promise<unknown>) {
  try {
    return text(await fn());
  } catch (err) {
    if (err instanceof HttpError) {
      return { isError: true, content: [{ type: 'text' as const, text: `${err.code ?? 'error'}: ${err.message}` }] };
    }
    console.error('MCP tool error:', err);
    return { isError: true, content: [{ type: 'text' as const, text: 'Internal error' }] };
  }
}

/** Explicit id, then the header Shipline Local sets, then the user's single active chat. */
async function resolveTicketId(ctx: McpContext, explicit?: string): Promise<string> {
  if (explicit) return explicit;
  if (ctx.ticketHeader) return ctx.ticketHeader;
  const mine = await prisma.ticket.findMany({
    where: { ownerId: ctx.userId, status: 'ACTIVE' },
    select: { id: true },
  });
  if (mine.length === 1) return mine[0].id;
  throw new HttpError(
    400,
    mine.length === 0 ? 'You have no active chat.' : 'Several chats are active; pass ticketId.',
    'TICKET_REQUIRED',
  );
}

function buildServer(ctx: McpContext): McpServer {
  const server = new McpServer({ name: 'shipline', version: '0.1.0' });

  server.registerTool(
    'get_my_work',
    { description: 'List your chats (work items) with their key, linked Jira ticket and current stage.', inputSchema: {} },
    async () => safely(() => listChats(ctx.userId)),
  );

  server.registerTool(
    'get_ticket_context',
    {
      description:
        'Get the chat (key, title, linked Jira ticket if any), the workflow template and version it runs on, its stages and statuses, the current stage instructions, the templates it could still switch to, and the artifacts of all DONE stages (research, plan, wireframes, QA report...).',
      inputSchema: { ticketId: z.string().optional() },
    },
    async ({ ticketId }) =>
      safely(async () => getSessionContext(await resolveTicketId(ctx, ticketId), ctx.userId)),
  );

  server.registerTool(
    'submit_artifact',
    {
      description:
        "Attach an artifact version to the ticket's CURRENT stage. It does not change the stage status; call propose_stage_transition afterwards to ask the user to complete the stage.",
      inputSchema: {
        ticketId: z.string().optional(),
        type: z.enum(ARTIFACT_TYPES as unknown as [string, ...string[]]),
        content: z.string().describe('Markdown / HTML source, or a URL for FIGMA_LINK and PR_LINK'),
      },
    },
    async ({ ticketId, type, content }) =>
      safely(async () => {
        const artifact = await submitArtifact(await resolveTicketId(ctx, ticketId), ctx.userId, {
          type: type as (typeof ARTIFACT_TYPES)[number],
          content,
          pluginVersion: ctx.pluginVersion,
          appVersion: ctx.appVersion,
          clientKind: ctx.client,
        });
        return { submitted: true, version: artifact.version };
      }),
  );

  // Jira is optional. Claude asks about a ticket in its first reply, then uses these (read-only,
  // through the project's existing Jira connection; nothing is ever written to Jira).
  server.registerTool(
    'search_jira_issues',
    {
      description:
        "Search the chat's Jira project for issues matching some text (or an issue key). Read-only. Use it in your first reply when the user says there is a Jira ticket but not which one.",
      inputSchema: { ticketId: z.string().optional(), query: z.string().describe('Words from the ticket, or its key') },
    },
    async ({ ticketId, query }) =>
      safely(async () => searchIssuesForChat(await resolveTicketId(ctx, ticketId), ctx.userId, query)),
  );

  server.registerTool(
    'get_jira_issue',
    {
      description: 'Read one Jira issue of the chat\'s Jira project (summary, status, full description). Read-only.',
      inputSchema: { ticketId: z.string().optional(), key: z.string().describe('Jira issue key, e.g. LEARNLOOP-1') },
    },
    async ({ ticketId, key }) => safely(async () => getIssueForChat(await resolveTicketId(ctx, ticketId), ctx.userId, key)),
  );

  server.registerTool(
    'link_jira_issue',
    {
      description:
        "Link a Jira issue to this chat once the user confirms it is the right one. Its details are returned so you can use them as context. The named branch becomes <JIRA-KEY>-<slug> at the first file edit; if the branch already exists it keeps its name and the Jira key must go into the PR title. Read-only towards Jira.",
      inputSchema: { ticketId: z.string().optional(), key: z.string().describe('Jira issue key, e.g. LEARNLOOP-1') },
    },
    async ({ ticketId, key }) => safely(async () => linkIssueToChat(await resolveTicketId(ctx, ticketId), ctx.userId, key)),
  );

  server.registerTool(
    'propose_stage_transition',
    {
      description:
        'Propose a stage change; the user sees Confirm / Not yet in the chat and the server only advances on Confirm. kind "complete": the current stage is finished (its artifact must exist). kind "skip": the current OPTIONAL stage (research, wireframes) is not needed; give the reason. kind "reopen": go back to an earlier stage (targetStageKey); later stages reset to PENDING. Only one proposal is pending at a time; a new one replaces the old. After proposing, stop and wait: you are told the outcome in the conversation.',
      inputSchema: {
        ticketId: z.string().optional(),
        kind: z.enum(TRANSITION_KINDS as unknown as [string, ...string[]]),
        reason: z.string().describe('One or two sentences shown to the user on the confirmation card'),
        targetStageKey: z.string().optional().describe('Required for kind "reopen": the stage key to go back to'),
      },
    },
    async ({ ticketId, kind, reason, targetStageKey }) =>
      safely(async () => {
        const proposal = await proposeTransition(await resolveTicketId(ctx, ticketId), ctx.userId, {
          kind: kind as (typeof TRANSITION_KINDS)[number],
          reason,
          targetStageKey,
          proposedBy: 'claude',
        });
        return {
          proposalId: proposal.id,
          status: 'PENDING',
          message: 'Shown to the user as a Confirm / Not yet card. Wait for their answer before continuing.',
        };
      }),
  );

  server.registerTool(
    'propose_template_switch',
    {
      description:
        'Propose moving this chat to another workflow template (for example "this looks like a hotfix"). Only possible before the first file edit (before the branch exists); the server rejects it afterwards. The user sees Confirm / Not yet in the chat; stages already done carry over when the new template has a stage of the same type. get_ticket_context lists the templates you can switch to. After proposing, stop and wait: you are told the outcome in the conversation.',
      inputSchema: {
        ticketId: z.string().optional(),
        template: z.string().describe('Name (or id) of the template to switch to'),
        reason: z.string().describe('One or two sentences shown to the user on the confirmation card'),
      },
    },
    async ({ ticketId, template, reason }) =>
      safely(async () => {
        const proposal = await proposeTemplateSwitch(await resolveTicketId(ctx, ticketId), ctx.userId, { template, reason });
        return {
          proposalId: proposal.id,
          status: 'PENDING',
          message: 'Shown to the user as a Confirm / Not yet card. Wait for their answer before continuing.',
        };
      }),
  );

  // The `--permission-prompt-tool` target: Claude Code calls this for every tool-use that needs a
  // decision. Policy runs server-side against the chat's current stage and is logged to ToolDecision.
  // An allow for the chat's first edit also carries `shiplineBranch` (see decideToolRequest).
  server.registerTool(
    'approve_tool_use',
    {
      description: 'Permission prompt handler used by Claude Code (--permission-prompt-tool). Not for direct use.',
      inputSchema: {
        tool_name: z.string(),
        input: z.record(z.unknown()),
        tool_use_id: z.string().optional(),
      },
    },
    async ({ tool_name, input, tool_use_id }) => {
      try {
        const ticketId = await resolveTicketId(ctx);
        const decision = await decideToolRequest({
          ticketId,
          userId: ctx.userId,
          tool: tool_name,
          input,
          toolUseId: tool_use_id,
          pluginVersion: ctx.pluginVersion,
          appVersion: ctx.appVersion,
        });
        return text(JSON.stringify(decision));
      } catch (err) {
        // Fail closed: any error is a deny.
        const message = err instanceof HttpError ? err.message : 'Permission check failed';
        return text(JSON.stringify({ behavior: 'deny', message }));
      }
    },
  );

  return server;
}

const router: Router = Router();

router.post('/', mcpAuth, async (req, res) => {
  const server = buildServer({
    userId: req.user!.userId,
    ticketHeader: hdr(req, HEADER_TICKET),
    pluginVersion: hdr(req, HEADER_PLUGIN_VERSION),
    appVersion: hdr(req, HEADER_APP_VERSION),
    client: hdr(req, HEADER_CLIENT) ?? 'mcp',
  });
  // Stateless: one server+transport per request.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('MCP request failed:', err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  }
});

const methodNotAllowed = (_req: Request, res: import('express').Response): void => {
  res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
};
router.get('/', methodNotAllowed);
router.delete('/', methodNotAllowed);

export default router;
