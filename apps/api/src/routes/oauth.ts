import { Router, Request, Response } from 'express';
import express from 'express';
import { prisma } from '../lib/prisma';
import { env } from '../lib/env';
import { handle } from '../lib/async-handler';
import { HttpError } from '../lib/http-error';
import { signState, verifyState } from '../lib/signed-state';
import { userFromSessionCookie } from '../middleware/auth';
import {
  LOCAL_CLIENT_ID,
  OAUTH_SCOPE,
  exchangeCode,
  isRedirectAllowed,
  issueAuthCode,
  refreshTokens,
  registerClient,
} from '../services/oauth.service';

const router: Router = Router();
const form = express.urlencoded({ extended: false });

const oauthError = (res: Response, status: number, error: string, description?: string): void => {
  res.status(status).json({ error, error_description: description });
};

// --- Discovery (RFC 8414 / RFC 9728) ---
export const wellKnownRouter: Router = Router();

wellKnownRouter.get('/oauth-authorization-server', (_req, res) => {
  res.json({
    issuer: env.backendUrl,
    authorization_endpoint: `${env.backendUrl}/oauth/authorize`,
    token_endpoint: `${env.backendUrl}/oauth/token`,
    registration_endpoint: `${env.backendUrl}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [OAUTH_SCOPE],
  });
});

const protectedResource = (_req: Request, res: Response): void => {
  res.json({
    resource: `${env.backendUrl}/mcp`,
    authorization_servers: [env.backendUrl],
    scopes_supported: [OAUTH_SCOPE],
    bearer_methods_supported: ['header'],
  });
};
wellKnownRouter.get('/oauth-protected-resource', protectedResource);
wellKnownRouter.get('/oauth-protected-resource/mcp', protectedResource);

// --- Dynamic client registration (RFC 7591) ---
router.post(
  '/register',
  express.json(),
  handle(async (req, res) => {
    const body = req.body as { client_name?: string; redirect_uris?: string[] };
    try {
      const client = await registerClient(body.client_name ?? '', body.redirect_uris ?? []);
      res.status(201).json({
        client_id: client.id,
        client_name: client.name,
        redirect_uris: client.redirectUris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      });
    } catch (err) {
      if (err instanceof HttpError) {
        oauthError(res, err.status, err.code ?? 'invalid_client_metadata', err.message);
        return;
      }
      throw err;
    }
  }),
);

// --- Authorization ---
interface AuthorizeParams {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  state?: string;
  scope: string;
  resource?: string;
}

function consentPage(client: string, tx: string): string {
  const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Authorize</title>
<style>body{font-family:system-ui;max-width:420px;margin:15vh auto;padding:0 16px}button{padding:8px 16px;margin-right:8px}</style></head>
<body><h2>Authorize ${esc(client)}</h2><p>This app wants to access your Shipline work (tickets, artifacts) on your behalf.</p>
<form method="post" action="/oauth/authorize"><input type="hidden" name="tx" value="${esc(tx)}">
<button name="decision" value="allow">Allow</button><button name="decision" value="deny">Deny</button></form></body></html>`;
}

async function validateAuthorize(q: Record<string, unknown>): Promise<AuthorizeParams> {
  const str = (k: string): string => (typeof q[k] === 'string' ? (q[k] as string) : '');
  const clientId = str('client_id');
  const redirectUri = str('redirect_uri');
  const client = clientId ? await prisma.oAuthClient.findUnique({ where: { id: clientId } }) : null;
  // Errors before the redirect URI is trusted are shown, never redirected.
  if (!client) throw new HttpError(400, 'Unknown client_id');
  if (!isRedirectAllowed(client.redirectUris, redirectUri)) throw new HttpError(400, 'redirect_uri not allowed');
  if (str('response_type') !== 'code') throw new HttpError(400, 'response_type must be "code"');
  if (str('code_challenge_method') !== 'S256' || !str('code_challenge')) {
    throw new HttpError(400, 'PKCE with S256 is required');
  }
  return {
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: str('code_challenge'),
    state: str('state') || undefined,
    scope: str('scope') || OAUTH_SCOPE,
    resource: str('resource') || undefined,
  };
}

function redirectWith(res: Response, redirectUri: string, params: Record<string, string | undefined>): void {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  res.redirect(url.toString());
}

router.get(
  '/authorize',
  handle(async (req, res) => {
    let params: AuthorizeParams;
    try {
      params = await validateAuthorize(req.query);
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).send(err.message);
        return;
      }
      throw err;
    }

    const session = userFromSessionCookie(req);
    if (!session) {
      const back = `/oauth/authorize?${new URLSearchParams(req.query as Record<string, string>)}`;
      res.redirect(`/api/auth/google/start?returnTo=${encodeURIComponent(back)}`);
      return;
    }

    if (params.client_id === LOCAL_CLIENT_ID) {
      const code = await issueAuthCode({
        clientId: params.client_id,
        userId: session.userId,
        redirectUri: params.redirect_uri,
        codeChallenge: params.code_challenge,
        scope: params.scope,
        resource: params.resource,
      });
      redirectWith(res, params.redirect_uri, { code, state: params.state });
      return;
    }

    const client = await prisma.oAuthClient.findUnique({ where: { id: params.client_id } });
    const tx = signState({ ...params, state: params.state ?? '', resource: params.resource ?? '', userId: session.userId });
    res.type('html').send(consentPage(client?.name ?? 'an application', tx));
  }),
);

router.post(
  '/authorize',
  form,
  handle(async (req, res) => {
    const session = userFromSessionCookie(req);
    const payload = typeof req.body?.tx === 'string' ? verifyState(req.body.tx) : null;
    if (!session || !payload || payload.userId !== session.userId) {
      res.status(400).send('Invalid or expired authorization request');
      return;
    }
    const client = await prisma.oAuthClient.findUnique({ where: { id: payload.client_id } });
    if (!client || !isRedirectAllowed(client.redirectUris, payload.redirect_uri)) {
      res.status(400).send('Invalid client');
      return;
    }
    if (req.body.decision !== 'allow') {
      redirectWith(res, payload.redirect_uri, { error: 'access_denied', state: payload.state || undefined });
      return;
    }
    const code = await issueAuthCode({
      clientId: payload.client_id,
      userId: session.userId,
      redirectUri: payload.redirect_uri,
      codeChallenge: payload.code_challenge,
      scope: payload.scope,
      resource: payload.resource || undefined,
    });
    redirectWith(res, payload.redirect_uri, { code, state: payload.state || undefined });
  }),
);

// --- Token ---
router.post(
  '/token',
  form,
  express.json(),
  handle(async (req, res) => {
    const b = req.body as Record<string, string | undefined>;
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (b.grant_type === 'authorization_code') {
        if (!b.client_id || !b.code || !b.redirect_uri || !b.code_verifier) {
          oauthError(res, 400, 'invalid_request');
          return;
        }
        res.json(
          await exchangeCode({
            clientId: b.client_id,
            code: b.code,
            redirectUri: b.redirect_uri,
            codeVerifier: b.code_verifier,
          }),
        );
        return;
      }
      if (b.grant_type === 'refresh_token') {
        if (!b.client_id || !b.refresh_token) {
          oauthError(res, 400, 'invalid_request');
          return;
        }
        res.json(await refreshTokens({ clientId: b.client_id, refreshToken: b.refresh_token }));
        return;
      }
      oauthError(res, 400, 'unsupported_grant_type');
    } catch (err) {
      if (err instanceof HttpError) {
        oauthError(res, err.status, err.code ?? 'invalid_request', err.message);
        return;
      }
      throw err;
    }
  }),
);

export default router;
