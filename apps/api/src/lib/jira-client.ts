import { prisma } from './prisma';
import { encrypt, decrypt } from './crypto';
import { env } from './env';
import { HttpError } from './http-error';

// Shipline is pull-only for Jira: read scopes only, no write endpoints are ever called.
export const JIRA_SCOPES = 'read:jira-work read:me offline_access';

const REFRESH_BUFFER_MS = 2 * 60 * 1000;

export interface JiraSession {
  accessToken: string;
  cloudId: string;
  siteUrl: string;
}

export function jiraConfigured(): boolean {
  return !!(env.jiraClientId && env.jiraClientSecret);
}

export function buildJiraAuthUrl(state: string): string {
  if (!env.jiraClientId) throw new HttpError(503, 'Jira OAuth is not configured');
  const params = new URLSearchParams({
    audience: 'api.atlassian.com',
    client_id: env.jiraClientId,
    scope: JIRA_SCOPES,
    redirect_uri: `${env.backendUrl}/api/jira/callback`,
    state,
    response_type: 'code',
    prompt: 'consent',
  });
  return `https://auth.atlassian.com/authorize?${params}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
}

export async function exchangeJiraCode(code: string): Promise<TokenResponse> {
  const res = await fetch('https://auth.atlassian.com/oauth/token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: env.jiraClientId,
      client_secret: env.jiraClientSecret,
      code,
      redirect_uri: `${env.backendUrl}/api/jira/callback`,
    }),
  });
  if (!res.ok) throw new Error(`Jira token exchange failed: ${res.status}`);
  return (await res.json()) as TokenResponse;
}

export async function listAccessibleSites(
  accessToken: string,
): Promise<Array<{ id: string; url: string; name: string }>> {
  const res = await fetch('https://api.atlassian.com/oauth/token/accessible-resources', {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Jira accessible-resources failed: ${res.status}`);
  return (await res.json()) as Array<{ id: string; url: string; name: string }>;
}

async function refreshJiraToken(refreshToken: string): Promise<TokenResponse | null> {
  const res = await fetch('https://auth.atlassian.com/oauth/token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: env.jiraClientId,
      client_secret: env.jiraClientSecret,
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as Partial<TokenResponse>;
  if (!data.access_token || !data.refresh_token) return null;
  return { access_token: data.access_token, refresh_token: data.refresh_token, expires_in: data.expires_in };
}

export async function saveJiraConnection(
  userId: string,
  tokens: TokenResponse,
  site: { id: string; url: string; name: string },
): Promise<void> {
  const data = {
    connectedByUserId: userId,
    accessToken: encrypt(tokens.access_token),
    refreshToken: encrypt(tokens.refresh_token),
    expiresAt: new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000),
    cloudId: site.id,
    siteUrl: site.url,
    siteName: site.name,
  };
  await prisma.jiraConnection.upsert({
    where: { key: 'default' },
    create: { key: 'default', ...data },
    update: data,
  });
}

export async function getJiraSession(): Promise<JiraSession> {
  const conn = await prisma.jiraConnection.findUnique({ where: { key: 'default' } });
  if (!conn) throw new HttpError(409, 'Jira is not connected', 'JIRA_NOT_CONNECTED');

  let accessToken = decrypt(conn.accessToken);
  if (conn.expiresAt.getTime() - Date.now() < REFRESH_BUFFER_MS) {
    const refreshed = await refreshJiraToken(decrypt(conn.refreshToken));
    if (!refreshed) throw new HttpError(409, 'Jira connection expired; reconnect it', 'JIRA_RECONNECT');
    accessToken = refreshed.access_token;
    await prisma.jiraConnection.update({
      where: { key: 'default' },
      data: {
        accessToken: encrypt(refreshed.access_token),
        refreshToken: encrypt(refreshed.refresh_token),
        expiresAt: new Date(Date.now() + (refreshed.expires_in ?? 3600) * 1000),
      },
    });
  }
  return { accessToken, cloudId: conn.cloudId, siteUrl: conn.siteUrl };
}

export interface JiraIssueDetail {
  key: string;
  summary: string;
  description: string;
  status: string;
  url: string;
}

interface AdfNode {
  type?: string;
  text?: string;
  content?: AdfNode[];
}

// Atlassian Document Format is a nested JSON tree; flatten it to plain text.
function extractAdfText(node: AdfNode | null | undefined): string {
  if (!node) return '';
  if (node.type === 'text' && node.text) return node.text;
  const childText = (node.content ?? []).map(extractAdfText).join('');
  if (node.type === 'paragraph' || node.type === 'heading') return `${childText}\n`;
  return childText;
}

interface JiraIssueApiResponse {
  key: string;
  fields: {
    summary: string;
    description?: AdfNode | null;
    status?: { name: string };
  };
}

const ISSUE_FIELDS = 'summary,description,status';

function toIssueDetail(session: JiraSession, data: JiraIssueApiResponse): JiraIssueDetail {
  return {
    key: data.key,
    summary: data.fields.summary,
    description: extractAdfText(data.fields.description).trim(),
    status: data.fields.status?.name ?? '',
    url: `${session.siteUrl}/browse/${data.key}`,
  };
}

export type JiraIssueLookup =
  | { found: true; issue: JiraIssueDetail; keyChanged: boolean }
  | { found: false };

/** GETs one issue. A 404 means deleted/inaccessible; a different returned `key` means it moved. */
export async function lookupJiraIssue(session: JiraSession, key: string): Promise<JiraIssueLookup> {
  const params = new URLSearchParams({ fields: ISSUE_FIELDS });
  const res = await fetch(
    `https://api.atlassian.com/ex/jira/${session.cloudId}/rest/api/3/issue/${encodeURIComponent(key)}?${params}`,
    { headers: { Authorization: `Bearer ${session.accessToken}`, Accept: 'application/json' } },
  );
  if (res.status === 404) return { found: false };
  if (!res.ok) throw new Error(`Jira issue lookup failed: ${res.status}`);
  const data = (await res.json()) as JiraIssueApiResponse;
  return {
    found: true,
    keyChanged: data.key !== key,
    issue: toIssueDetail(session, data),
  };
}

/**
 * Read-only text search inside one Jira project (the chat's project). A string that looks like an
 * issue key also matches that key directly. Quotes and backslashes are stripped so the text cannot
 * break out of the JQL string.
 */
export async function searchJiraIssues(session: JiraSession, projectKey: string, query: string): Promise<JiraIssueDetail[]> {
  const text = query.replace(/["\\]/g, ' ').trim();
  const project = projectKey.replace(/"/g, '');
  const matchers = text ? [`text ~ "${text}"`] : [];
  if (/^[A-Za-z][A-Za-z0-9]+-\d+$/.test(text)) matchers.push(`key = "${text.toUpperCase()}"`);
  const where = matchers.length > 0 ? ` AND (${matchers.join(' OR ')})` : '';
  const params = new URLSearchParams({
    jql: `project = "${project}"${where} ORDER BY updated DESC`,
    fields: ISSUE_FIELDS,
    maxResults: '10',
  });
  const res = await fetch(`https://api.atlassian.com/ex/jira/${session.cloudId}/rest/api/3/search/jql?${params}`, {
    headers: { Authorization: `Bearer ${session.accessToken}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Jira search failed: ${res.status}`);
  const data = (await res.json()) as { issues?: JiraIssueApiResponse[] };
  return (data.issues ?? []).map((i) => toIssueDetail(session, i));
}
