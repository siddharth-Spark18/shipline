import { Request, Response, NextFunction } from 'express';
import { verifyToken, TokenPayload } from '../lib/jwt';
import { readCookie, SESSION_COOKIE } from '../lib/cookies';
import { env } from '../lib/env';

/** Accepts a Bearer token: a web session token or an OAuth access token (Shipline Local / MCP). */
export function auth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }
  try {
    req.user = verifyToken(header.slice(7));
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/** Resolves a browser session from the httpOnly cookie — used only by the OAuth authorize page. */
export function userFromSessionCookie(req: Request): TokenPayload | null {
  const raw = readCookie(req, SESSION_COOKIE);
  if (!raw) return null;
  try {
    const payload = verifyToken(raw);
    return payload.typ === 'session' ? payload : null;
  } catch {
    return null;
  }
}

/** MCP-flavoured variant: a 401 carries the resource-metadata pointer MCP clients use to start OAuth. */
export function mcpAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const challenge = `Bearer resource_metadata="${env.backendUrl}/.well-known/oauth-protected-resource/mcp"`;
  if (!header?.startsWith('Bearer ')) {
    res.setHeader('WWW-Authenticate', challenge);
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  try {
    const payload = verifyToken(header.slice(7));
    if (payload.typ !== 'access') throw new Error('not an access token');
    req.user = payload;
    next();
  } catch {
    res.setHeader('WWW-Authenticate', `${challenge}, error="invalid_token"`);
    res.status(401).json({ error: 'invalid_token' });
  }
}
