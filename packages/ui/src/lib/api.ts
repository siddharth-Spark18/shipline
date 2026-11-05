import type {
  AddWorkflowRequest,
  AgentsChange,
  AgentsPreviewResponse,
  ApiErrorEnvelope,
  ChatCommand,
  ChatControls,
  CiChange,
  CiPreviewResponse,
  ChatDetail,
  ChatsResponse,
  Diagnostics,
  FileMode,
  FileResponse,
  ImageData,
  InstallBase,
  InstallInfo,
  InstallPreview,
  InstallSelection,
  PreviewResponse,
  PickedControls,
  PromptAnswer,
  SaveRequest,
  SaveResponse,
  SetControlsResponse,
  SetupData,
  Status,
  TasksData,
  WorkflowAction,
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

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
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
    throw new ApiError(
      res.status,
      e?.code ?? 'http-error',
      e?.message ?? `Request failed (${res.status})`,
      e?.details,
    );
  }
  return (await res.json()) as T;
}

export const api = {
  status: () => request<Status>('GET', '/api/status'),
  setup: () => request<SetupData>('GET', '/api/setup'),
  previewSetup: (req: SaveRequest) => request<PreviewResponse>('POST', '/api/setup/preview', req),
  saveSetup: (req: SaveRequest) => request<SaveResponse>('POST', '/api/setup/save', req),
  workflowAction: (req: WorkflowAction) =>
    request<{ ok: true }>('POST', '/api/setup/workflows', req),
  createWorkflow: (id: string, name: string) =>
    request<{ ok: true }>('POST', '/api/setup/workflows', { action: 'create', id, name }),
  agentsPreview: (req: AgentsChange) =>
    request<AgentsPreviewResponse>('POST', '/api/setup/agents?preview=1', req),
  agentsApply: (req: AgentsChange) => request<unknown>('POST', '/api/setup/agents', req),
  addWorkflowPreview: (req: AddWorkflowRequest) =>
    request<AgentsPreviewResponse & { paths: string[] }>(
      'POST',
      '/api/setup/add-workflow?preview=1',
      req,
    ),
  addWorkflow: (req: AddWorkflowRequest) =>
    request<unknown>('POST', '/api/setup/add-workflow', req),
  installInfo: () => request<InstallInfo>('GET', '/api/install/info'),
  installPreview: (selection: InstallSelection) =>
    request<InstallPreview>('POST', '/api/install/preview', { selection }),
  install: (selection: InstallSelection, base: InstallBase) =>
    request<{ installed: true }>('POST', '/api/install', { selection, base }),
  ciPreview: (req: CiChange) => request<CiPreviewResponse>('POST', '/api/setup/ci?preview=1', req),
  ciApply: (req: CiChange) => request<unknown>('POST', '/api/setup/ci', req),
  tasks: () => request<TasksData>('GET', '/api/tasks'),
  file: (path: string, mode: FileMode) =>
    request<FileResponse>('GET', `/api/file?path=${encodeURIComponent(path)}&mode=${mode}`),
  diagnostics: () => request<Diagnostics>('GET', '/api/diagnostics'),
  chats: () => request<ChatsResponse>('GET', '/api/chats'),
  chat: (id: string) => request<ChatDetail>('GET', `/api/chats/${encodeURIComponent(id)}`),
  createChat: (message: string, images: ImageData[] = []) =>
    request<{ id: string }>('POST', '/api/chats', {
      message,
      ...(images.length > 0 ? { images } : {}),
    }),
  sendMessage: (id: string, text: string, images: ImageData[] = []) =>
    request<{ ok: true }>('POST', `/api/chats/${encodeURIComponent(id)}/message`, {
      text,
      ...(images.length > 0 ? { images } : {}),
    }),
  listCommands: (chatId?: string | null) =>
    request<{ commands: ChatCommand[] }>(
      'GET',
      `/api/chat/commands${chatId ? `?chat=${encodeURIComponent(chatId)}` : ''}`,
    ),
  getControls: (chatId?: string | null) =>
    request<ChatControls>(
      'GET',
      `/api/chat/controls${chatId ? `?chat=${encodeURIComponent(chatId)}` : ''}`,
    ),
  setControls: (body: PickedControls & { chat?: string }) =>
    request<SetControlsResponse>('POST', '/api/chat/controls', body),
  trustRepo: (path: string) =>
    request<{ trusted: true; takesEffect: string }>('POST', '/api/trust', { path }),
  startShell: (id: string, command: string) =>
    request<{ runId: string }>('POST', `/api/chats/${encodeURIComponent(id)}/shell`, { command }),
  stopShell: (id: string, runId: string) =>
    request<{ stopped: true }>(
      'POST',
      `/api/chats/${encodeURIComponent(id)}/shell/${encodeURIComponent(runId)}/stop`,
    ),
  stopChat: (id: string) =>
    request<{ ok: true }>('POST', `/api/chats/${encodeURIComponent(id)}/stop`),
  killChat: (id: string) =>
    request<{ killed: true }>('POST', `/api/chats/${encodeURIComponent(id)}/kill`),
  continueChat: (id: string) =>
    request<{ ok: true }>('POST', `/api/chats/${encodeURIComponent(id)}/continue`),
  answerPrompt: (id: string, answer: PromptAnswer) =>
    request<{ ok: true }>('POST', `/api/prompts/${encodeURIComponent(id)}`, answer),
};
