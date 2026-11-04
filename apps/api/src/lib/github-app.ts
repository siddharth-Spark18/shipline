import jwt from 'jsonwebtoken';
import { Project } from '@prisma/client';
import { env } from './env';
import { prisma } from './prisma';
import { HttpError } from './http-error';

const API = 'https://api.github.com';
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export function githubAppConfigured(): boolean {
  return !!(env.githubAppId && env.githubAppPrivateKey);
}

function appJwt(): string {
  if (!env.githubAppId || !env.githubAppPrivateKey) {
    throw new HttpError(503, 'GitHub App is not configured');
  }
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign({ iat: now - 60, exp: now + 9 * 60, iss: env.githubAppId }, env.githubAppPrivateKey, {
    algorithm: 'RS256',
  });
}

const ghHeaders = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'Content-Type': 'application/json',
});

async function getInstallationToken(installationId: string): Promise<string> {
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt - Date.now() > TOKEN_REFRESH_BUFFER_MS) return cached.token;
  const res = await fetch(`${API}/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: ghHeaders(appJwt()),
  });
  if (!res.ok) throw new Error(`GitHub installation token failed: ${res.status}`);
  const data = (await res.json()) as { token: string; expires_at: string };
  tokenCache.set(installationId, { token: data.token, expiresAt: new Date(data.expires_at).getTime() });
  return data.token;
}

/** Finds (and caches on the project) the GitHub App installation for the project's repo. */
export async function resolveInstallationId(project: Project): Promise<string> {
  if (project.githubInstallationId) return project.githubInstallationId;
  const res = await fetch(`${API}/repos/${project.githubRepo}/installation`, {
    headers: ghHeaders(appJwt()),
  });
  if (!res.ok) throw new HttpError(409, `GitHub App is not installed on ${project.githubRepo}`);
  const data = (await res.json()) as { id: number };
  const id = String(data.id);
  await prisma.project.update({ where: { id: project.id }, data: { githubInstallationId: id } });
  return id;
}

export async function ghRequest<T>(
  project: Project,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; data: T | null }> {
  const installationId = await resolveInstallationId(project);
  const token = await getInstallationToken(installationId);
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? 'GET',
    headers: ghHeaders(token),
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (res.status === 404) return { status: 404, data: null };
  if (!res.ok) throw new Error(`GitHub ${init.method ?? 'GET'} ${path} failed: ${res.status}`);
  const text = await res.text();
  return { status: res.status, data: text ? (JSON.parse(text) as T) : null };
}

export const GATES_CHECK_NAME = 'shipline/gates';

export async function createGatesCheckRun(
  project: Project,
  headSha: string,
  result: { pass: boolean; title: string; summary: string },
): Promise<void> {
  await ghRequest(project, `/repos/${project.githubRepo}/check-runs`, {
    method: 'POST',
    body: {
      name: GATES_CHECK_NAME,
      head_sha: headSha,
      status: 'completed',
      conclusion: result.pass ? 'success' : 'failure',
      output: { title: result.title, summary: result.summary },
    },
  });
}

/** Creates or updates a file on a branch via the Contents API (used for `commitArtifactsToRepo`). */
export async function putRepoFile(
  project: Project,
  path: string,
  content: string,
  message: string,
  branch: string,
): Promise<void> {
  const repo = project.githubRepo;
  const existing = await ghRequest<{ sha: string }>(
    project,
    `/repos/${repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(branch)}`,
  );
  await ghRequest(project, `/repos/${repo}/contents/${encodeURI(path)}`, {
    method: 'PUT',
    body: {
      message,
      content: Buffer.from(content, 'utf8').toString('base64'),
      branch,
      sha: existing.data?.sha,
    },
  });
}

export async function getDefaultBranch(project: Project): Promise<string> {
  const { data } = await ghRequest<{ default_branch: string }>(project, `/repos/${project.githubRepo}`);
  return data?.default_branch ?? 'main';
}

export interface Collaborator {
  login: string;
  permissions: { admin: boolean; maintain?: boolean; push: boolean; triage?: boolean; pull: boolean };
}

export async function listCollaborators(project: Project): Promise<Collaborator[]> {
  const { data } = await ghRequest<Collaborator[]>(
    project,
    `/repos/${project.githubRepo}/collaborators?per_page=100`,
  );
  return data ?? [];
}
