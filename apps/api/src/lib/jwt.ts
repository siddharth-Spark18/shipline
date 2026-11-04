import jwt from 'jsonwebtoken';
import { env } from './env';

/**
 * `session`: browser session for the web hub (and the cookie used by /oauth/authorize).
 * `access`:  OAuth access token issued to Shipline Local or an MCP client.
 */
export interface TokenPayload {
  userId: string;
  typ: 'session' | 'access';
  clientId?: string;
  scope?: string;
}

export function signSessionToken(userId: string): string {
  const payload: TokenPayload = { userId, typ: 'session' };
  return jwt.sign(payload, env.jwtSecret, { expiresIn: env.sessionExpiresIn } as jwt.SignOptions);
}

export function signAccessToken(userId: string, clientId: string, scope: string): string {
  const payload: TokenPayload = { userId, typ: 'access', clientId, scope };
  return jwt.sign(payload, env.jwtSecret, { expiresIn: env.accessTokenTtlSeconds });
}

export function verifyToken(token: string): TokenPayload {
  return jwt.verify(token, env.jwtSecret) as TokenPayload;
}
