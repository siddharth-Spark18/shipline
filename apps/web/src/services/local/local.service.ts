import { DiffMode, LocalPairResponseDTO } from '@shipline/shared';
import { localFetch } from '@/lib/local-api';
import {
  AssetContent,
  AssetMeta,
  CloneInput,
  DiffFileDetail,
  DiffFileInput,
  DiffSummary,
  LocalHello,
  LocalProject,
  LocalStatus,
  ResolvePromptInput,
  SendMessageInput,
  SessionRow,
  SetModeInput,
  SetPathInput,
  StartSessionInput,
} from './local.types';

export class LocalService {
  static async hello() {
    return localFetch<LocalHello>('/hello', { auth: false });
  }

  static async pair(code: string) {
    const data = await localFetch<LocalPairResponseDTO>('/pair', { method: 'POST', body: { code }, auth: false });
    return data.token;
  }

  static async unpair() {
    await localFetch<void>('/unpair', { method: 'POST' });
  }

  static async getStatus() {
    return localFetch<LocalStatus>('/status');
  }

  static async startLogin() {
    const data = await localFetch<{ url: string }>('/auth/login', { method: 'POST' });
    return data.url;
  }

  static async logout() {
    await localFetch<void>('/auth/logout', { method: 'POST' });
  }

  static async getProjects() {
    return localFetch<LocalProject[]>('/projects');
  }

  static async getSessions() {
    return localFetch<SessionRow[]>('/sessions');
  }

  static async startSession(input: StartSessionInput) {
    return localFetch<{ ticketId: string; mode: 'chat' | 'terminal' }>(`/sessions/${input.ticketId}/start`, {
      method: 'POST',
      body: { mode: input.mode, firstMessage: input.firstMessage },
    });
  }

  static async stopSession(ticketId: string) {
    await localFetch<void>(`/sessions/${ticketId}/stop`, { method: 'POST' });
  }

  static async sendMessage(input: SendMessageInput) {
    await localFetch<void>(`/sessions/${input.ticketId}/message`, {
      method: 'POST',
      body: { text: input.text, marker: input.marker },
    });
  }

  static async resolvePrompt(input: ResolvePromptInput) {
    await localFetch<void>(`/sessions/${input.ticketId}/tool-decisions/${input.id}/resolve`, {
      method: 'POST',
      body: { allow: input.allow, answers: input.answers },
    });
  }

  static async setPath(input: SetPathInput) {
    await localFetch<void>(`/projects/${input.projectId}/path`, { method: 'PUT', body: { path: input.path } });
  }

  static async clone(input: CloneInput) {
    await localFetch<void>(`/projects/${input.projectId}/clone`, {
      method: 'POST',
      body: { path: input.path, githubRepo: input.githubRepo },
    });
  }

  static async setSessionMode(input: SetModeInput) {
    await localFetch<void>(`/projects/${input.projectId}/session-mode`, { method: 'PUT', body: { mode: input.mode } });
  }

  static async getDiff(ticketId: string, mode: DiffMode) {
    return localFetch<DiffSummary>(`/sessions/${ticketId}/diff?mode=${mode}`);
  }

  static async getDiffFile(input: DiffFileInput) {
    const q = new URLSearchParams({ mode: input.mode, path: input.path });
    if (input.oldPath) q.set('oldPath', input.oldPath);
    if (input.full) q.set('full', '1');
    return localFetch<DiffFileDetail>(`/sessions/${input.ticketId}/diff/file?${q}`);
  }

  static async getAssetMeta(ticketId: string, path: string) {
    return localFetch<AssetMeta>(`/sessions/${ticketId}/asset?meta=1&path=${encodeURIComponent(path)}`);
  }

  static async getAsset(ticketId: string, path: string) {
    return localFetch<AssetContent>(`/sessions/${ticketId}/asset?path=${encodeURIComponent(path)}`);
  }
}
