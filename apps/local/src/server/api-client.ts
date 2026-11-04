import { HEADER_APP_VERSION, HEADER_CLIENT, HEADER_PLUGIN_VERSION } from '@shipline/shared';
import { getConfig } from './config';
import { getAccessToken } from './shipline-auth';
import { readAppVersion, readPluginVersion } from './paths';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

export function versionHeaders(): Record<string, string> {
  return {
    [HEADER_APP_VERSION]: readAppVersion(),
    [HEADER_PLUGIN_VERSION]: readPluginVersion(),
    [HEADER_CLIENT]: 'shipline-local',
  };
}

export async function authorizedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const attempt = async (token: string): Promise<Response> =>
    fetch(`${getConfig().apiUrl}${path}`, {
      ...init,
      headers: {
        ...(init.body && !(init.headers as Record<string, string> | undefined)?.['Content-Type']
          ? { 'Content-Type': 'application/json' }
          : {}),
        ...(init.headers as Record<string, string> | undefined),
        ...versionHeaders(),
        Authorization: `Bearer ${token}`,
      },
    });

  const token = await getAccessToken();
  if (!token) throw new ApiError(401, 'Not signed in to Shipline', 'SIGNED_OUT');
  let res = await attempt(token);
  if (res.status === 401) {
    const refreshed = await getAccessToken(true);
    if (!refreshed) throw new ApiError(401, 'Not signed in to Shipline', 'SIGNED_OUT');
    res = await attempt(refreshed);
  }
  return res;
}

export async function apiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await authorizedFetch(path, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    throw new ApiError(res.status, body.error ?? `Request failed (${res.status})`, body.code);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
