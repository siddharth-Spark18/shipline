// Client for Shipline Local, the browser-facing service on 127.0.0.1. The hub talks to the local
// service directly from the browser: it requires a pairing token (entered once from the tray's
// one-time code) sent as the `X-Shipline-Local-Token` header, and only allows this hub's origin.
export const LOCAL_URL: string = (import.meta.env.VITE_LOCAL_URL ?? 'http://127.0.0.1:4777').replace(/\/$/, '');

const TOKEN_KEY = 'shipline_local_token';

export const getLocalToken = (): string => localStorage.getItem(TOKEN_KEY) ?? '';
export const setLocalToken = (token: string): void => localStorage.setItem(TOKEN_KEY, token);
export const clearLocalToken = (): void => localStorage.removeItem(TOKEN_KEY);

export class LocalApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
    public guidance?: string,
  ) {
    super(message);
  }
}

/** The service is not running (or blocked): fetch itself failed. */
export class LocalUnreachableError extends Error {
  constructor() {
    super('Shipline Local is not running');
  }
}

export async function localFetch<T>(
  path: string,
  init: { method?: string; body?: unknown; auth?: boolean } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${LOCAL_URL}/api${path}`, {
      method: init.method ?? 'GET',
      headers: {
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(init.auth === false ? {} : { 'X-Shipline-Local-Token': getLocalToken() }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new LocalUnreachableError();
  }
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { error?: string; code?: string; guidance?: string };
    throw new LocalApiError(b.error ?? `Request failed (${res.status})`, res.status, b.code, b.guidance);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** The token travels as a WebSocket subprotocol: browsers cannot set headers on a WebSocket. */
export function openSessionSocket(ticketId: string): WebSocket {
  const url = new URL(LOCAL_URL);
  const proto = url.protocol === 'https:' ? 'wss' : 'ws';
  return new WebSocket(`${proto}://${url.host}/ws?ticketId=${encodeURIComponent(ticketId)}`, [
    `shipline-token.${getLocalToken()}`,
  ]);
}
