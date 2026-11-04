import crypto from 'crypto';
import { getConfig, saveConfig } from './config';

// Shipline Local signs in to Shipline with the same OAuth flow as any MCP client (PKCE, loopback
// redirect). Google SSO happens in the user's browser on the Shipline hub.
const CLIENT_ID = 'shipline-local';
const EXPIRY_SKEW_MS = 60_000;

interface PendingLogin {
  verifier: string;
  redirectUri: string;
  createdAt: number;
}

const pending = new Map<string, PendingLogin>();
let refreshing: Promise<string | null> | null = null;

export function startLogin(port: number): string {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('base64url');
  const redirectUri = `http://127.0.0.1:${port}/auth/callback`;
  pending.set(state, { verifier, redirectUri, createdAt: Date.now() });
  for (const [k, v] of pending) if (Date.now() - v.createdAt > 10 * 60_000) pending.delete(k);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    scope: 'shipline',
  });
  return `${getConfig().apiUrl}/oauth/authorize?${params}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

function store(t: TokenResponse): void {
  saveConfig({
    tokens: {
      accessToken: t.access_token,
      refreshToken: t.refresh_token,
      expiresAt: Date.now() + t.expires_in * 1000,
    },
  });
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse | null> {
  const res = await fetch(`${getConfig().apiUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, ...body }),
  });
  if (!res.ok) return null;
  return (await res.json()) as TokenResponse;
}

export async function completeLogin(code: string, state: string): Promise<boolean> {
  const p = pending.get(state);
  if (!p) return false;
  pending.delete(state);
  const tokens = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: p.redirectUri,
    code_verifier: p.verifier,
  });
  if (!tokens) return false;
  store(tokens);
  return true;
}

export function logout(): void {
  saveConfig({ tokens: null });
}

export function isSignedIn(): boolean {
  return !!getConfig().tokens;
}

/** Returns a valid Shipline access token, refreshing it when close to expiry; null if signed out. */
export async function getAccessToken(forceRefresh = false): Promise<string | null> {
  const tokens = getConfig().tokens;
  if (!tokens) return null;
  if (!forceRefresh && tokens.expiresAt - Date.now() > EXPIRY_SKEW_MS) return tokens.accessToken;

  refreshing ??= (async () => {
    try {
      const fresh = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken });
      if (!fresh) {
        logout();
        return null;
      }
      store(fresh);
      return fresh.access_token;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}
