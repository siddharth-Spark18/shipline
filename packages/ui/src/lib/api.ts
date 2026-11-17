import type {
  AccessIssue,
  AddWorkflowRequest,
  AgentsChange,
  AgentsPreviewResponse,
  ApiErrorEnvelope,
  ChatCommand,
  ChatControls,
  CiChange,
  ClaimBody,
  CiPreviewResponse,
  ChatDetail,
  ChatListItem,
  ChatsResponse,
  HealthData,
  Diagnostics,
  FileMode,
  FileResponse,
  ImageData,
  InstallBase,
  InstallInfo,
  InstallPreview,
  InstallSelection,
  PairResponse,
  PreviewResponse,
  PickedControls,
  PromptAnswer,
  RemoteInfo,
  SaveRequest,
  SaveResponse,
  SetControlsResponse,
  SetupData,
  Overview,
  Preferences,
  Project,
  Status,
  TasksData,
  WorkflowAction,
  WorkflowDraftInfo,
} from '@/lib/types';

/** The server's error envelope, raised as an exception. */
export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const ACCESS_CODES: Record<string, AccessIssue> = {
  'not-paired': 'not-paired',
  'remote-off': 'remote-off',
  'wrong-tailscale-user': 'wrong-tailscale-user',
};
let accessIssue: AccessIssue | null = null;
const accessListeners = new Set<() => void>();

/** Called by the API client and the event stream when this device may not use the server any more. */
export function reportAccessIssue(issue: AccessIssue) {
  if (accessIssue === issue) return;
  accessIssue = issue;
  accessListeners.forEach((fn) => fn());
}

/** For useSyncExternalStore: the reason this device is locked out, or null. */
export const accessIssueStore = {
  subscribe(fn: () => void) {
    accessListeners.add(fn);
    return () => accessListeners.delete(fn);
  },
  get: () => accessIssue,
};

/**
 * The repo the app is showing (the project of the chat, new-chat or Setup view). Per-repo calls go to /api/repos/<repoId>/..., and the
 * app is keyed by it, so every query and event in view belongs to this repo.
 */
let currentRepoId: string | null = null;

export function setCurrentRepo(id: string | null) {
  currentRepoId = id;
}

export const getCurrentRepo = () => currentRepoId;

/** '/api/chats' -> '/api/repos/<current repo>/chats'. */
function repoPath(path: string): string {
  if (!currentRepoId) throw new ApiError(0, 'no-repo', 'No project is selected.');
  return `/api/repos/${encodeURIComponent(currentRepoId)}${path.slice('/api'.length)}`;
}

async function request<T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(
      0,
      'network',
      'Could not reach the Shipline UI server. Is `npx @forgeyard/shipline ui` still running?',
    );
  }
  if (!res.ok) {
    let envelope: Partial<ApiErrorEnvelope> | null = null;
    try {
      envelope = (await res.json()) as Partial<ApiErrorEnvelope>;
    } catch {
      envelope = null;
    }
    const e = envelope?.error;
    if (e?.code && e.code in ACCESS_CODES) reportAccessIssue(ACCESS_CODES[e.code]);
    throw new ApiError(
      res.status,
      e?.code ?? 'http-error',
      e?.message ?? `Request failed (${res.status})`,
      e?.details,
    );
  }
  return (await res.json()) as T;
}

/** A call to the current repo's routes. */
function repoRequest<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  return request<T>(method, repoPath(path), body);
}

export const api = {
  projects: () => request<Project[]>('GET', '/api/projects'),
  overview: () => request<Overview>('GET', '/api/overview'),
  /** Every chat of every project (the sidebar's flat list). */
  allChats: () => request<ChatListItem[]>('GET', '/api/chats'),
  /** Which project a chat belongs to (404 unknown-chat). */
  chatRepo: (chatId: string) =>
    request<{ repoId: string }>('GET', `/api/chats/${encodeURIComponent(chatId)}/repo`),
  health: () => request<HealthData>('GET', '/api/health'),
  /** The Health page asks about a project that isn't on screen, so these name the repo. */
  statusOf: (repoId: string) =>
    request<Status>('GET', `/api/repos/${encodeURIComponent(repoId)}/status`),
  diagnosticsOf: (repoId: string) =>
    request<Diagnostics>('GET', `/api/repos/${encodeURIComponent(repoId)}/diagnostics`),
  /** Unregisters the project (or dismisses a "Not set up" one). The folder and its task data stay. */
  removeProject: (id: string) =>
    request<{ ok: true }>('DELETE', `/api/projects/${encodeURIComponent(id)}`),
  preferences: () => request<Preferences>('GET', '/api/preferences'),
  setPreferences: (body: Preferences) => request<Preferences>('POST', '/api/preferences', body),
  remote: () => request<RemoteInfo>('GET', '/api/remote'),
  setRemote: (enabled: boolean) => request<RemoteInfo>('POST', '/api/remote', { enabled }),
  createPairing: () => request<PairResponse>('POST', '/api/remote/pair'),
  claimPairing: (body: ClaimBody) =>
    request<{ id: string; name: string }>('POST', '/api/remote/claim', body),
  revokeDevice: (id: string) =>
    request<{ ok: true }>('POST', `/api/remote/devices/${encodeURIComponent(id)}/revoke`),
  status: () => repoRequest<Status>('GET', '/api/status'),
  setup: () => repoRequest<SetupData>('GET', '/api/setup'),
  previewSetup: (req: SaveRequest) =>
    repoRequest<PreviewResponse>('POST', '/api/setup/preview', req),
  saveSetup: (req: SaveRequest) => repoRequest<SaveResponse>('POST', '/api/setup/save', req),
  markSetupDone: () => repoRequest<{ ok: true }>('POST', '/api/setup/mark-done'),
  /** Workflow drafts left by /shipline-workflow-designer, awaiting review. */
  drafts: () => repoRequest<WorkflowDraftInfo[]>('GET', '/api/setup/drafts'),
  previewDraft: (workflowId: string) =>
    repoRequest<PreviewResponse>(
      'POST',
      `/api/setup/drafts/${encodeURIComponent(workflowId)}/preview`,
    ),
  /** 409 `draft-stale` unless `overwrite` is true and the workflow changed since the draft was made. */
  saveDraft: (workflowId: string, overwrite: boolean) =>
    repoRequest<SaveResponse>('POST', `/api/setup/drafts/${encodeURIComponent(workflowId)}/save`, {
      overwrite,
    }),
  discardDraft: (workflowId: string) =>
    repoRequest<{ ok: true }>(
      'POST',
      `/api/setup/drafts/${encodeURIComponent(workflowId)}/discard`,
    ),
  workflowAction: (req: WorkflowAction) =>
    repoRequest<{ ok: true }>('POST', '/api/setup/workflows', req),
  createWorkflow: (id: string, name: string) =>
    repoRequest<{ ok: true }>('POST', '/api/setup/workflows', { action: 'create', id, name }),
  agentsPreview: (req: AgentsChange) =>
    repoRequest<AgentsPreviewResponse>('POST', '/api/setup/agents?preview=1', req),
  agentsApply: (req: AgentsChange) => repoRequest<unknown>('POST', '/api/setup/agents', req),
  addWorkflowPreview: (req: AddWorkflowRequest) =>
    repoRequest<AgentsPreviewResponse & { paths: string[] }>(
      'POST',
      '/api/setup/add-workflow?preview=1',
      req,
    ),
  addWorkflow: (req: AddWorkflowRequest) =>
    repoRequest<unknown>('POST', '/api/setup/add-workflow', req),
  installInfo: () => repoRequest<InstallInfo>('GET', '/api/install/info'),
  installPreview: (selection: InstallSelection) =>
    repoRequest<InstallPreview>('POST', '/api/install/preview', { selection }),
  install: (selection: InstallSelection, base: InstallBase) =>
    repoRequest<{ installed: true; nextSteps: string[] }>('POST', '/api/install', {
      selection,
      base,
    }),
  ciPreview: (req: CiChange) =>
    repoRequest<CiPreviewResponse>('POST', '/api/setup/ci?preview=1', req),
  ciApply: (req: CiChange) => repoRequest<unknown>('POST', '/api/setup/ci', req),
  tasks: () => repoRequest<TasksData>('GET', '/api/tasks'),
  file: (path: string, mode: FileMode) =>
    repoRequest<FileResponse>('GET', `/api/file?path=${encodeURIComponent(path)}&mode=${mode}`),
  chats: () => repoRequest<ChatsResponse>('GET', '/api/chats'),
  chat: (id: string) => repoRequest<ChatDetail>('GET', `/api/chats/${encodeURIComponent(id)}`),
  createChat: (message: string, images: ImageData[] = []) =>
    repoRequest<{ id: string }>('POST', '/api/chats', {
      message,
      ...(images.length > 0 ? { images } : {}),
    }),
  sendMessage: (id: string, text: string, images: ImageData[] = []) =>
    repoRequest<{ ok: true }>('POST', `/api/chats/${encodeURIComponent(id)}/message`, {
      text,
      ...(images.length > 0 ? { images } : {}),
    }),
  listCommands: (chatId?: string | null) =>
    repoRequest<{ commands: ChatCommand[] }>(
      'GET',
      `/api/chat/commands${chatId ? `?chat=${encodeURIComponent(chatId)}` : ''}`,
    ),
  getControls: (chatId?: string | null) =>
    repoRequest<ChatControls>(
      'GET',
      `/api/chat/controls${chatId ? `?chat=${encodeURIComponent(chatId)}` : ''}`,
    ),
  setControls: (body: PickedControls & { chat?: string }) =>
    repoRequest<SetControlsResponse>('POST', '/api/chat/controls', body),
  trustRepo: (path: string) =>
    repoRequest<{ trusted: true; takesEffect: string }>('POST', '/api/trust', { path }),
  startShell: (id: string, command: string) =>
    repoRequest<{ runId: string }>('POST', `/api/chats/${encodeURIComponent(id)}/shell`, {
      command,
    }),
  stopShell: (id: string, runId: string) =>
    repoRequest<{ stopped: true }>(
      'POST',
      `/api/chats/${encodeURIComponent(id)}/shell/${encodeURIComponent(runId)}/stop`,
    ),
  stopChat: (id: string) =>
    repoRequest<{ ok: true }>('POST', `/api/chats/${encodeURIComponent(id)}/stop`),
  interruptChat: (id: string) =>
    repoRequest<{ ok: true }>('POST', `/api/chats/${encodeURIComponent(id)}/interrupt`),
  killChat: (id: string) =>
    repoRequest<{ killed: true }>('POST', `/api/chats/${encodeURIComponent(id)}/kill`),
  continueChat: (id: string) =>
    repoRequest<{ ok: true }>('POST', `/api/chats/${encodeURIComponent(id)}/continue`),
  answerPrompt: (id: string, answer: PromptAnswer) =>
    repoRequest<{ ok: true }>('POST', `/api/prompts/${encodeURIComponent(id)}`, answer),
};
