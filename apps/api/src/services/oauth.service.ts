import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { randomToken, sha256 } from '../lib/crypto';
import { signAccessToken } from '../lib/jwt';
import { env } from '../lib/env';
import { HttpError } from '../lib/http-error';

/** First-party public client: Shipline Local signs in with the same OAuth flow as MCP clients. */
export const LOCAL_CLIENT_ID = 'shipline-local';
export const OAUTH_SCOPE = 'shipline';

const CODE_TTL_MS = 5 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export async function ensureLocalClient(): Promise<void> {
  await prisma.oAuthClient.upsert({
    where: { id: LOCAL_CLIENT_ID },
    create: { id: LOCAL_CLIENT_ID, name: 'Shipline Local', redirectUris: ['http://127.0.0.1/auth/callback'] },
    update: { name: 'Shipline Local', redirectUris: ['http://127.0.0.1/auth/callback'] },
  });
}

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];

function isLoopback(uri: URL): boolean {
  return uri.protocol === 'http:' && LOOPBACK_HOSTS.includes(uri.hostname);
}

/** RFC 8252: loopback redirects match ignoring the port; everything else must match exactly. */
export function isRedirectAllowed(registered: string[], redirectUri: string): boolean {
  let candidate: URL;
  try {
    candidate = new URL(redirectUri);
  } catch {
    return false;
  }
  return registered.some((r) => {
    if (r === redirectUri) return true;
    try {
      const reg = new URL(r);
      return (
        isLoopback(reg) &&
        isLoopback(candidate) &&
        reg.pathname === candidate.pathname &&
        reg.hostname === candidate.hostname
      );
    } catch {
      return false;
    }
  });
}

/** Dynamic client registration accepts https or loopback redirect URIs, plus any explicitly allowed. */
export function isRegistrableRedirect(uri: string): boolean {
  if (env.mcpExtraRedirectUris.includes(uri)) return true;
  try {
    const u = new URL(uri);
    return u.protocol === 'https:' || isLoopback(u);
  } catch {
    return false;
  }
}

export async function registerClient(name: string, redirectUris: string[]) {
  if (!redirectUris.length || !redirectUris.every(isRegistrableRedirect)) {
    throw new HttpError(400, 'redirect_uris must be https or loopback URLs', 'invalid_redirect_uri');
  }
  const id = `mcp_${randomToken(16)}`;
  return prisma.oAuthClient.create({ data: { id, name: name || 'MCP client', redirectUris } });
}

export async function issueAuthCode(args: {
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource?: string;
}): Promise<string> {
  const code = randomToken(32);
  await prisma.oAuthCode.create({
    data: {
      codeHash: sha256(code),
      clientId: args.clientId,
      userId: args.userId,
      redirectUri: args.redirectUri,
      codeChallenge: args.codeChallenge,
      scope: args.scope,
      resource: args.resource ?? null,
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    },
  });
  return code;
}

export interface TokenSet {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

async function issueTokens(clientId: string, userId: string, scope: string): Promise<TokenSet> {
  const refresh = randomToken(48);
  await prisma.oAuthRefreshToken.create({
    data: { tokenHash: sha256(refresh), clientId, userId, scope, expiresAt: new Date(Date.now() + REFRESH_TTL_MS) },
  });
  return {
    access_token: signAccessToken(userId, clientId, scope),
    token_type: 'Bearer',
    expires_in: env.accessTokenTtlSeconds,
    refresh_token: refresh,
    scope,
  };
}

function pkceMatches(verifier: string, challenge: string): boolean {
  const computed = crypto.createHash('sha256').update(verifier).digest('base64url');
  const a = Buffer.from(computed);
  const b = Buffer.from(challenge);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function exchangeCode(args: {
  clientId: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<TokenSet> {
  const row = await prisma.oAuthCode.findUnique({ where: { codeHash: sha256(args.code) } });
  if (!row || row.usedAt || row.expiresAt < new Date()) {
    throw new HttpError(400, 'invalid_grant', 'invalid_grant');
  }
  // Single-use: mark consumed before anything else so a replay fails even if a later check throws.
  const claimed = await prisma.oAuthCode.updateMany({
    where: { id: row.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (claimed.count === 0) throw new HttpError(400, 'invalid_grant', 'invalid_grant');
  if (row.clientId !== args.clientId || row.redirectUri !== args.redirectUri) {
    throw new HttpError(400, 'invalid_grant', 'invalid_grant');
  }
  if (!pkceMatches(args.codeVerifier, row.codeChallenge)) {
    throw new HttpError(400, 'PKCE verification failed', 'invalid_grant');
  }
  return issueTokens(row.clientId, row.userId, row.scope);
}

export async function refreshTokens(args: { clientId: string; refreshToken: string }): Promise<TokenSet> {
  const row = await prisma.oAuthRefreshToken.findUnique({ where: { tokenHash: sha256(args.refreshToken) } });
  if (!row || row.revokedAt || row.expiresAt < new Date() || row.clientId !== args.clientId) {
    throw new HttpError(400, 'invalid_grant', 'invalid_grant');
  }
  const revoked = await prisma.oAuthRefreshToken.updateMany({
    where: { id: row.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (revoked.count === 0) throw new HttpError(400, 'invalid_grant', 'invalid_grant');
  return issueTokens(row.clientId, row.userId, row.scope);
}
