import crypto from 'crypto';
import { EventEmitter } from 'events';
import {
  ChatRowDTO,
  PendingToolDecisionDTO,
  SessionMessage,
  SessionRowDTO,
  SessionState,
  StageTransitionDTO,
  StreamEvent,
  TicketSessionContextDTO,
  buildStageChangeMessage,
  meetsMinVersion,
} from '@shipline/shared';
import { ApiError, apiJson } from './api-client';
import { ChatFatal, ChatSession } from './chat-session';
import { claudeHealth } from './claude-cli';
import { getConfig, saveConfig } from './config';
import { Mode, buildLaunchPlan, writeStageState } from './launch';
import { registerMcpSession, unregisterMcpSession } from './mcp-proxy';
import { readPluginVersion } from './paths';
import { RepoError, verifyWorkingCopy } from './repo';
import { TerminalSession } from './terminal-session';
import { loadTranscriptHistory } from './transcript';
import { watchWorktree } from './watcher';
import { Workspace, ensureBranch, ensureWorktree } from './worktree';

export class StartError extends Error {
  constructor(
    public code: string,
    message: string,
    public guidance?: string,
  ) {
    super(message);
  }
}

const HISTORY_LIMIT = 3000;
const POLL_MS = 2000;
/** How often the hooks' state file is re-read from the hub, so role/policy changes apply mid-session. */
const CONTEXT_REFRESH_MS = 5000;
const RECONCILE_MS = 20_000;

export interface ActiveSession {
  ticketId: string;
  /** Last time refreshContext ran (ms epoch). */
  contextRefreshedAt?: number;
  ticketKey: string;
  mode: Mode;
  ctx: TicketSessionContextDTO;
  worktreePath: string;
  /** Null while the worktree is detached; set when the first edit creates the named branch. */
  branch: string | null;
  /** Port of this service, for the MCP proxy URL Claude connects to. */
  port: number;
  emitter: EventEmitter;
  history: SessionMessage[];
  chat?: ChatSession;
  terminal?: TerminalSession;
  mcpSecret: string;
  poller: NodeJS.Timeout;
  stopWatching: () => void;
  seenPrompts: Set<string>;
  openPrompts: Set<string>;
  hasPendingTransition: boolean;
  turnActive: boolean;
  state: SessionState;
  /** Set while falling back from a failed `--resume` to a fresh conversation. */
  restartingFresh: boolean;
  ended: boolean;
}

const active = new Map<string, ActiveSession>();
let reconciler: NodeJS.Timeout | null = null;

export function getSession(ticketId: string): ActiveSession | undefined {
  return active.get(ticketId);
}

export function listSessions(): SessionRowDTO[] {
  return [...active.values()]
    .filter((s) => !s.ended)
    .map((s) => ({
      ticketId: s.ticketId,
      ticketKey: s.ticketKey,
      mode: s.mode,
      state: s.state,
      worktreePath: s.worktreePath,
      branch: s.branch,
    }));
}

/** Pushes a message to the browser; `diff-changed` and `state` are live signals and are not replayed. */
function push(s: ActiveSession, msg: SessionMessage): void {
  if (msg.kind !== 'diff-changed' && msg.kind !== 'state') {
    s.history.push(msg);
    if (s.history.length > HISTORY_LIMIT) s.history.shift();
  }
  s.emitter.emit('message', msg);
}

function recomputeState(s: ActiveSession): void {
  const next: SessionState = s.openPrompts.size > 0 || s.hasPendingTransition ? 'waiting' : s.turnActive ? 'running' : 'idle';
  if (next === s.state) return;
  s.state = next;
  push(s, { kind: 'state', state: next });
}

function resolveMode(ctx: TicketSessionContextDTO, requested?: Mode): Mode {
  // OPEN-QUESTION #3: terminal mode stays available as the fallback; the default comes from the
  // project's sessionMode, overridable per user.
  return requested ?? getConfig().sessionModes[ctx.project.id] ?? ctx.project.sessionMode;
}

async function recordAnnounced(ticketId: string, stageKey: string | null): Promise<void> {
  saveConfig({ announcedStages: { ...getConfig().announcedStages, [ticketId]: stageKey } });
}

/**
 * Starts (or resumes) the chat's one Claude session in its worktree. `firstMessage` is the text the
 * person typed on the new-chat screen: it goes to Claude together with the stage announcement as
 * the first turn, so Claude's first reply (which asks about a Jira ticket) answers it.
 */
export async function startSession(
  ticketId: string,
  port: number,
  requestedMode?: Mode,
  firstMessage?: string,
): Promise<ActiveSession> {
  const existing = active.get(ticketId);
  if (existing && !existing.ended) {
    if (!requestedMode || requestedMode === existing.mode) return existing;
    // Switching chat <-> terminal: end the running process first, then relaunch (--resume keeps the conversation).
    await stopAndWait(existing);
  }

  const ctx = await apiJson<TicketSessionContextDTO>(`/api/tickets/${ticketId}/context`);
  if (!ctx.currentStage) throw new StartError('TICKET_DONE', 'Every stage of this chat is finished.');

  // 1. Claude Code health: installed, logged in (its own login), new enough.
  const health = await claudeHealth(ctx.project.minClaudeCliVersion);
  if (!health.installed) throw new StartError('CLAUDE_MISSING', 'Claude Code is not installed.', health.guidance ?? undefined);
  if (!health.loggedIn) throw new StartError('CLAUDE_LOGGED_OUT', 'Claude Code is not signed in.', health.guidance ?? undefined);
  if (!health.meetsMinVersion) {
    throw new StartError('CLAUDE_TOO_OLD', `Claude Code ${health.version} is below the required ${health.minVersion}.`, health.guidance ?? undefined);
  }

  // 2. The bundled plugin must meet the project's minimum.
  if (!meetsMinVersion(readPluginVersion(), ctx.project.minPluginVersion)) {
    throw new StartError('PLUGIN_TOO_OLD', `Shipline Local's bundled plugin (${readPluginVersion()}) is below the project minimum ${ctx.project.minPluginVersion}. Update Shipline Local.`);
  }

  // 3. Registered repo only, then the chat's own worktree (detached: the branch comes at the first edit).
  let repoPath: string;
  let workspace: Workspace;
  try {
    repoPath = await verifyWorkingCopy(getConfig().projectPaths[ctx.project.id], ctx.project.githubRepo);
    workspace = await ensureWorktree({
      repoPath,
      ticketKey: ctx.ticket.key,
      jiraKey: ctx.ticket.jiraKey,
      baseBranch: ctx.project.baseBranch,
      knownBranch: ctx.ticket.branch,
    });
  } catch (err) {
    if (err instanceof RepoError) throw new StartError(err.code, err.message);
    throw err;
  }
  saveConfig({
    workspaces: {
      ...getConfig().workspaces,
      [ticketId]: {
        projectId: ctx.project.id,
        repoPath,
        worktreePath: workspace.worktreePath,
        branch: workspace.branch,
        baseBranch: ctx.project.baseBranch,
      },
    },
  });
  try {
    await apiJson(`/api/tickets/${ticketId}/workspace`, {
      method: 'PUT',
      body: JSON.stringify({ branch: workspace.branch, worktreePath: workspace.worktreePath }),
    });
  } catch (err) {
    if (err instanceof ApiError) throw new StartError(err.code ?? 'WORKSPACE_FAILED', err.message);
    throw err;
  }
  ctx.ticket.branch = workspace.branch ?? ctx.ticket.branch;
  ctx.ticket.worktreePath = workspace.worktreePath;

  const mode = resolveMode(ctx, requestedMode);
  const mcpSecret = crypto.randomBytes(24).toString('base64url');

  const session: ActiveSession = {
    ticketId,
    ticketKey: ctx.ticket.key,
    mode,
    ctx,
    worktreePath: workspace.worktreePath,
    branch: workspace.branch,
    port,
    emitter: new EventEmitter(),
    // A resumed conversation: show what was said before (the service only keeps history in memory).
    history: ctx.claudeSessionId ? loadTranscriptHistory(workspace.worktreePath, ctx.claudeSessionId, HISTORY_LIMIT) : [],
    mcpSecret,
    seenPrompts: new Set(),
    openPrompts: new Set(),
    hasPendingTransition: false,
    turnActive: false,
    state: 'idle',
    restartingFresh: false,
    stopWatching: () => undefined,
    ended: false,
    poller: setInterval(() => void pollPending(session), POLL_MS),
  };
  registerMcpSession(mcpSecret, ticketId, {
    createBranch: (name) => createNamedBranch(session, name),
    onToolDenied: ({ toolUseId, tool, reason }) => push(session, { kind: 'tool-denied', toolUseId, tool, reason }),
  });
  active.set(ticketId, session);
  startReconciler();

  void watchWorktree(workspace.worktreePath, () => push(session, { kind: 'diff-changed' })).then((stop) => {
    if (session.ended) stop();
    else session.stopWatching = stop;
  });

  if (mode === 'chat') spawnChat(session, ctx.claudeSessionId, firstMessage);
  else spawnTerminal(session, ctx.claudeSessionId, firstMessage);
  return session;
}

/**
 * The hub signalled the chat's first edit (inside `approve_tool_use`): create the named branch in
 * the worktree BEFORE the call is allowed to run, then tell the hub and the browser.
 */
async function createNamedBranch(s: ActiveSession, wanted: string): Promise<string> {
  const branch = await ensureBranch(s.worktreePath, wanted);
  if (s.branch === branch) return branch;
  s.branch = branch;
  s.ctx.ticket.branch = branch;
  const known = getConfig().workspaces[s.ticketId];
  if (known) saveConfig({ workspaces: { ...getConfig().workspaces, [s.ticketId]: { ...known, branch } } });
  push(s, { kind: 'branch', branch });
  writeStageState(s.ticketId, s.ctx);
  try {
    await apiJson(`/api/tickets/${s.ticketId}/workspace`, {
      method: 'PUT',
      body: JSON.stringify({ branch, worktreePath: s.worktreePath }),
    });
  } catch (err) {
    // The branch exists locally; the hub is told again at the next edit's signal.
    console.error('Failed to record the branch with the hub:', err);
  }
  return branch;
}

function finish(s: ActiveSession, code: number | null): void {
  if (s.ended) return;
  s.ended = true;
  clearInterval(s.poller);
  s.stopWatching();
  unregisterMcpSession(s.mcpSecret);
  push(s, { kind: 'exit', code });
}

// OPEN-QUESTION: terminal mode has no `approve_tool_use` (no permission-prompt tool), so the hub cannot
// signal the first edit there. The system prompt tells Claude to `git switch -c <suggested>` before
// committing if the worktree is still detached (see launch.ts); nothing creates the branch earlier.
/**
 * What Claude is told when a session starts (or resumes after the stage moved on without it). With
 * a `firstMessage` the person's text and the announcement are ONE turn, so Claude answers the
 * person (and asks about Jira) instead of replying to the announcement alone.
 */
function announceStage(s: ActiveSession, cause: string, firstMessage?: string): void {
  const text = buildStageChangeMessage({
    ticketKey: s.ticketKey,
    fromStageName: null,
    stage: s.ctx.currentStage,
    cause,
  });
  if (!firstMessage) {
    postMarker(s, text, s.ctx.currentStage?.key ?? null, s.ctx.currentStage?.name ?? null);
    return;
  }
  push(s, { kind: 'user-message', text: firstMessage });
  push(s, { kind: 'stage-change', stageKey: s.ctx.currentStage?.key ?? null, stageName: s.ctx.currentStage?.name ?? null, text });
  void recordAnnounced(s.ticketId, s.ctx.currentStage?.key ?? null);
  deliver(s, `${firstMessage}\n\n${text}`);
  void refreshContext(s);
}

function spawnChat(s: ActiveSession, resumeSessionId: string | null, firstMessage?: string): void {
  const plan = buildLaunchPlan({
    ctx: s.ctx,
    mode: 'chat',
    worktreePath: s.worktreePath,
    mcpUrl: `http://127.0.0.1:${s.port}/mcp-proxy`,
    mcpSecret: s.mcpSecret,
    resumeSessionId,
  });
  const chat = new ChatSession(plan);
  s.chat = chat;
  let recordedId = resumeSessionId;
  chat.on('event', (event: StreamEvent) => {
    if (event.type === 'result') {
      s.turnActive = false;
      recomputeState(s);
    }
    push(s, { kind: 'event', event });
  });
  chat.on('session-id', (id: string) => {
    if (id === recordedId) return;
    recordedId = id;
    apiJson(`/api/tickets/${s.ticketId}/session`, { method: 'PUT', body: JSON.stringify({ claudeSessionId: id }) }).catch((err) =>
      console.error('Failed to record Claude session id:', err),
    );
  });
  chat.on('usage-limit', (message: string) => push(s, { kind: 'usage-limit', message }));
  chat.on('fatal', (fatal: ChatFatal) => {
    // The conversation lives on this machine only; if it is gone (other machine, cleared history),
    // start fresh: the system prompt re-seeds the done-stage artifacts.
    if (resumeSessionId && fatal.kind === 'exit' && /no conversation found/i.test(fatal.message)) {
      s.restartingFresh = true;
      return;
    }
    push(s, { kind: 'fatal', fatal });
  });
  chat.on('exit', ({ code }: { code: number | null }) => {
    if (s.restartingFresh) {
      s.restartingFresh = false;
      spawnChat(s, null, firstMessage);
      return;
    }
    finish(s, code);
  });
  chat.start();

  const announced = getConfig().announcedStages[s.ticketId];
  if (!resumeSessionId) announceStage(s, 'session started', firstMessage);
  else if (announced !== (s.ctx.currentStage?.key ?? null)) announceStage(s, 'session resumed; the stage changed while Claude was not running');
}

function spawnTerminal(s: ActiveSession, resumeSessionId: string | null, firstMessage?: string): void {
  const plan = buildLaunchPlan({
    ctx: s.ctx,
    mode: 'terminal',
    worktreePath: s.worktreePath,
    mcpUrl: `http://127.0.0.1:${s.port}/mcp-proxy`,
    mcpSecret: s.mcpSecret,
    resumeSessionId,
  });
  const term = new TerminalSession(plan);
  s.terminal = term;
  term.on('data', (data: string) => push(s, { kind: 'pty', data }));
  term.on('fatal', (fatal: ChatFatal) => push(s, { kind: 'fatal', fatal }));
  term.on('exit', ({ code }: { code: number | null }) => finish(s, code));
  term.start();
  // Terminal mode has no stream-json init event; the Claude session id is not captured here, so
  // a reopened terminal session continues with the last known conversation (if any).
  if (!resumeSessionId || getConfig().announcedStages[s.ticketId] !== (s.ctx.currentStage?.key ?? null)) {
    // Give the interactive UI a moment to draw its prompt before typing into it.
    setTimeout(() => announceStage(s, 'session started', firstMessage), 2500).unref();
  }
}

/** Re-reads the ticket after a stage change so the hooks' state file and system context stay current. */
async function refreshContext(s: ActiveSession): Promise<void> {
  try {
    const fresh = await apiJson<TicketSessionContextDTO>(`/api/tickets/${s.ticketId}/context`);
    fresh.ticket.branch = s.branch ?? fresh.ticket.branch;
    fresh.ticket.worktreePath = s.worktreePath;
    s.ctx = fresh;
    writeStageState(s.ticketId, fresh);
  } catch {
    // The next stage-change message retries.
  }
}

/** Writes a "[Shipline] ..." message into Claude's conversation and shows it as a marker in the chat. */
function postMarker(
  s: ActiveSession,
  text: string,
  stageKey: string | null,
  stageName: string | null,
  transition?: StageMarker['transition'],
): void {
  push(s, { kind: 'stage-change', stageKey, stageName, text, transition });
  void recordAnnounced(s.ticketId, stageKey);
  deliver(s, text);
  void refreshContext(s);
}

function deliver(s: ActiveSession, text: string): void {
  if (s.chat) {
    s.turnActive = true;
    recomputeState(s);
    s.chat.send(text);
  } else if (s.terminal) {
    // Bracketed paste keeps multi-line text in one prompt; the final CR submits it.
    s.terminal.write(`\x1b[200~${text}\x1b[201~\r`);
  }
}

/** A message from the person (also used for PR comments sent to Claude). */
export function sendUserMessage(ticketId: string, text: string): boolean {
  const s = active.get(ticketId);
  if (!s || s.ended) return false;
  push(s, { kind: 'user-message', text });
  deliver(s, text);
  return true;
}

/** What the browser tells the session about a stage change it just confirmed. */
export interface StageMarker {
  stageKey: string | null;
  stageName: string | null;
  /** Set for a confirmed transition: the browser shows an inline completion card for it. */
  transition?: { kind: 'complete' | 'skip' | 'reopen'; fromStageName: string };
}

/** Stage-change / decision messages posted by the browser after the hub advanced the stage. */
export function sendMarkerMessage(ticketId: string, text: string, marker: StageMarker): boolean {
  const s = active.get(ticketId);
  if (!s || s.ended) return false;
  postMarker(s, text, marker.stageKey ?? null, marker.stageName ?? null, marker.transition);
  return true;
}

async function pollPending(s: ActiveSession): Promise<void> {
  if (s.ended) return;
  // Roles and edit policies can change in the hub at any time; keep the guard hook's state current.
  if (Date.now() - (s.contextRefreshedAt ?? 0) >= CONTEXT_REFRESH_MS) {
    s.contextRefreshedAt = Date.now();
    void refreshContext(s);
  }
  try {
    if (s.mode === 'chat') {
      const pending = await apiJson<PendingToolDecisionDTO[]>(`/api/tickets/${s.ticketId}/tool-decisions/pending`);
      for (const prompt of pending) {
        if (s.seenPrompts.has(prompt.id)) continue;
        s.seenPrompts.add(prompt.id);
        s.openPrompts.add(prompt.id);
        push(s, { kind: 'tool-prompt', prompt });
      }
      // Prompts that timed out on the hub vanish from the pending list.
      for (const id of [...s.openPrompts]) {
        if (!pending.some((p) => p.id === id)) {
          s.openPrompts.delete(id);
          push(s, { kind: 'tool-prompt-resolved', id });
        }
      }
    }
    const transitions = await apiJson<StageTransitionDTO[]>(`/api/tickets/${s.ticketId}/transitions`);
    s.hasPendingTransition = transitions.some((t) => t.decision === 'PENDING');
    recomputeState(s);
  } catch {
    // Transient hub errors: the next tick retries.
  }
}

export async function resolvePrompt(
  ticketId: string,
  id: string,
  allow: boolean,
  answers?: Record<string, string>,
): Promise<void> {
  await apiJson(`/api/tool-decisions/${id}/resolve`, { method: 'POST', body: JSON.stringify({ allow, answers }) });
  const s = active.get(ticketId);
  if (s) {
    s.openPrompts.delete(id);
    push(s, { kind: 'tool-prompt-resolved', id });
    recomputeState(s);
  }
}

async function stopAndWait(s: ActiveSession): Promise<void> {
  stopSession(s.ticketId);
  for (let i = 0; i < 80 && !s.ended; i++) await new Promise((r) => setTimeout(r, 100));
  if (!s.ended) throw new StartError('STOP_TIMEOUT', 'The running session did not stop in time. Try again.');
}

export function stopSession(ticketId: string): void {
  const s = active.get(ticketId);
  if (!s) return;
  s.chat?.stop();
  s.terminal?.stop();
}

/**
 * Stops sessions for chats that are finished or gone (e.g. the merge ended the chat). Chats belong to
 * the person who started them, so there is no reassignment to handle.
 */
async function reconcile(): Promise<void> {
  const running = [...active.values()].filter((s) => !s.ended);
  if (running.length === 0) return;
  try {
    const mine = await apiJson<ChatRowDTO[]>('/api/chats');
    for (const s of running) {
      const row = mine.find((t) => t.ticketId === s.ticketId);
      if (row && row.status === 'ACTIVE') continue;
      push(s, {
        kind: 'fatal',
        fatal: {
          kind: 'finished',
          message: row ? 'This chat is finished; the session was stopped.' : 'This chat no longer exists, so your session was stopped.',
          suggestTerminal: false,
        },
      });
      stopSession(s.ticketId);
    }
  } catch {
    // Hub unreachable: keep sessions running; the next tick retries.
  }
}

function startReconciler(): void {
  reconciler ??= setInterval(() => void reconcile(), RECONCILE_MS);
  reconciler.unref();
}

export function stopAllSessions(): void {
  if (reconciler) clearInterval(reconciler);
  reconciler = null;
  for (const id of active.keys()) stopSession(id);
}
