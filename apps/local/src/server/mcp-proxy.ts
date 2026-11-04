import { Request, Response, Router } from 'express';
import express from 'express';
import { Readable } from 'stream';
import { getConfig } from './config';
import { getAccessToken } from './shipline-auth';
import { versionHeaders } from './api-client';
import { ApproveToolUseResultDTO, HEADER_TICKET } from '@shipline/shared';

/**
 * Claude connects to this loopback proxy instead of the hub directly. The proxy swaps in a
 * fresh Shipline access token (they expire hourly) and stamps app/plugin versions, so the
 * session's config file never holds a real token.
 */
const sessions = new Map<string, { ticketId: string; hooks: McpSessionHooks }>(); // secret -> session

// OPEN-QUESTION: the hub's "create the branch" signal rides inside the `approve_tool_use` answer and the
// proxy acts on it, because that answer is the only hub-to-local channel that is synchronous with the
// tool call (a separate push channel could not guarantee the branch exists before the call runs).
// Denials are also read here so every denied call (role, stage, user or timeout) shows as a denied chip.
/**
 * What the proxy reports back to the session while it relays `approve_tool_use`: the hub signals
 * "create the branch" inside an allow, and denied calls are shown as denied tool chips.
 */
export interface McpSessionHooks {
  /** Runs `git switch -c` in the worktree; resolves with the final branch name. */
  createBranch: (branch: string) => Promise<string>;
  onToolDenied: (info: { toolUseId: string | null; tool: string; reason: string }) => void;
}

export function registerMcpSession(secret: string, ticketId: string, hooks: McpSessionHooks): void {
  sessions.set(secret, { ticketId, hooks });
}

export function unregisterMcpSession(secret: string): void {
  sessions.delete(secret);
}

export const mcpProxyRouter: Router = Router();

mcpProxyRouter.all('/', express.raw({ type: () => true, limit: '10mb' }), async (req: Request, res: Response) => {
  const secret = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
  const session = sessions.get(secret);
  if (!session) {
    res.status(401).json({ error: 'unknown session' });
    return;
  }
  const { ticketId } = session;
  const approval = approvalCall(req.body);

  const forward = async (token: string): Promise<globalThis.Response> => {
    const headers: Record<string, string> = {
      ...versionHeaders(),
      Authorization: `Bearer ${token}`,
      [HEADER_TICKET]: ticketId,
    };
    for (const h of ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version']) {
      const v = req.headers[h];
      if (typeof v === 'string') headers[h] = v;
    }
    return fetch(`${getConfig().apiUrl}/mcp`, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : (req.body as Buffer),
    });
  };

  try {
    let token = await getAccessToken();
    if (!token) {
      res.status(401).json({ error: 'Not signed in to Shipline' });
      return;
    }
    let upstream = await forward(token);
    if (upstream.status === 401) {
      token = await getAccessToken(true);
      if (token) upstream = await forward(token);
    }
    res.status(upstream.status);
    for (const h of ['content-type', 'mcp-session-id', 'www-authenticate']) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    if (approval && upstream.ok) {
      // The permission answer is read (not streamed) so the branch can be created BEFORE Claude
      // sees the allow, and so denials can be shown in the chat.
      const text = await upstream.text();
      const isSse = (upstream.headers.get('content-type') ?? '').includes('text/event-stream');
      res.send(await rewriteApproval(text, isSse, approval, session.hooks));
      return;
    }
    if (!upstream.body) {
      res.end();
      return;
    }
    Readable.fromWeb(upstream.body as import('stream/web').ReadableStream).pipe(res);
  } catch (err) {
    console.error('MCP proxy error:', err);
    if (!res.headersSent) res.status(502).json({ error: 'Shipline hub unreachable' });
  }
});

// --- approve_tool_use interception ---

interface ApprovalCall {
  tool: string;
  toolUseId: string | null;
}

/** The permission-prompt call Claude Code makes for every tool use that needs a decision. */
function approvalCall(body: unknown): ApprovalCall | null {
  if (!Buffer.isBuffer(body)) return null;
  try {
    const msg = JSON.parse(body.toString('utf8')) as {
      method?: string;
      params?: { name?: string; arguments?: { tool_name?: unknown; tool_use_id?: unknown } };
    };
    if (msg.method !== 'tools/call' || msg.params?.name !== 'approve_tool_use') return null;
    const args = msg.params.arguments ?? {};
    return {
      tool: typeof args.tool_name === 'string' ? args.tool_name : 'tool',
      toolUseId: typeof args.tool_use_id === 'string' ? args.tool_use_id : null,
    };
  } catch {
    return null;
  }
}

async function settleDecision(
  decision: ApproveToolUseResultDTO,
  call: ApprovalCall,
  hooks: McpSessionHooks,
): Promise<ApproveToolUseResultDTO> {
  let out = decision;
  if (out.shiplineBranch) {
    const { shiplineBranch, ...rest } = out;
    try {
      await hooks.createBranch(shiplineBranch);
      out = rest;
    } catch (err) {
      // The call must not run on a detached HEAD: deny it with the reason.
      out = { behavior: 'deny', message: `Shipline could not create the branch for this chat (${(err as Error).message}). Nothing was changed.` };
    }
  }
  if (out.behavior === 'deny') {
    hooks.onToolDenied({ toolUseId: call.toolUseId, tool: call.tool, reason: out.message ?? 'Denied.' });
  }
  return out;
}

async function rewriteMessage(msg: unknown, call: ApprovalCall, hooks: McpSessionHooks): Promise<unknown> {
  const block = (msg as { result?: { content?: Array<{ type?: string; text?: string }> } })?.result?.content?.[0];
  if (!block || block.type !== 'text' || typeof block.text !== 'string') return msg;
  let decision: ApproveToolUseResultDTO;
  try {
    decision = JSON.parse(block.text) as ApproveToolUseResultDTO;
  } catch {
    return msg;
  }
  if (decision.behavior !== 'allow' && decision.behavior !== 'deny') return msg;
  block.text = JSON.stringify(await settleDecision(decision, call, hooks));
  return msg;
}

/** Handles both response encodings of the MCP streamable-HTTP transport (JSON and SSE). */
async function rewriteApproval(text: string, isSse: boolean, call: ApprovalCall, hooks: McpSessionHooks): Promise<string> {
  try {
    if (!isSse) return JSON.stringify(await rewriteMessage(JSON.parse(text), call, hooks));
    const events = text.split(/\r?\n\r?\n/);
    const out: string[] = [];
    for (const event of events) {
      const lines = event.split(/\r?\n/);
      const idx = lines.findIndex((l) => l.startsWith('data:'));
      if (idx >= 0) {
        try {
          lines[idx] = `data: ${JSON.stringify(await rewriteMessage(JSON.parse(lines[idx].slice(5).trim()), call, hooks))}`;
        } catch {
          // Not a JSON-RPC message: pass it through unchanged.
        }
      }
      out.push(lines.join('\n'));
    }
    return out.join('\n\n');
  } catch {
    return text;
  }
}
