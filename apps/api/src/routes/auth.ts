import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { OAuth2Client } from 'google-auth-library';
import { prisma } from '../lib/prisma';
import { env } from '../lib/env';
import { signSessionToken, verifyToken } from '../lib/jwt';
import { signState, verifyState } from '../lib/signed-state';
import { setSessionCookie, clearSessionCookie } from '../lib/cookies';
import { handle } from '../lib/async-handler';
import { auth } from '../middleware/auth';

const router: Router = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

const googleClient = new OAuth2Client(env.googleClientId, env.googleClientSecret, `${env.backendUrl}/api/auth/google/callback`);

/** Only ever a same-origin relative path — never an open redirect. */
function sanitizeReturnTo(raw: unknown): string | null {
  return typeof raw === 'string' && raw.startsWith('/') && !raw.startsWith('//') ? raw : null;
}

router.get('/google/start', authLimiter, (req: Request, res: Response) => {
  const returnTo = sanitizeReturnTo(req.query.returnTo) ?? '';
  const params = new URLSearchParams({
    client_id: env.googleClientId,
    redirect_uri: `${env.backendUrl}/api/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state: signState({ returnTo }),
    prompt: 'select_account',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

router.get(
  '/google/callback',
  authLimiter,
  handle(async (req, res) => {
    const code = req.query.code as string | undefined;
    const state = verifyState((req.query.state as string | undefined) ?? '');
    if (!code || !state) {
      res.redirect(`${env.clientUrl}/login?error=invalid_state`);
      return;
    }

    const { tokens } = await googleClient.getToken(code);
    if (!tokens.id_token) {
      res.redirect(`${env.clientUrl}/login?error=no_id_token`);
      return;
    }
    const ticket = await googleClient.verifyIdToken({ idToken: tokens.id_token, audience: env.googleClientId });
    const claims = ticket.getPayload();
    if (!claims?.email || !claims.email_verified || !claims.sub) {
      res.redirect(`${env.clientUrl}/login?error=unverified_email`);
      return;
    }
    const email = claims.email.toLowerCase();
    if (env.googleAllowedDomain && email.split('@')[1] !== env.googleAllowedDomain) {
      res.redirect(`${env.clientUrl}/login?error=domain_not_allowed`);
      return;
    }

    // A project admin may have pre-created the user by email before their first sign-in.
    const existing =
      (await prisma.user.findUnique({ where: { googleId: claims.sub } })) ??
      (await prisma.user.findUnique({ where: { email } }));
    const isAdmin = env.adminEmails.includes(email);
    const user = existing
      ? await prisma.user.update({
          where: { id: existing.id },
          data: { googleId: claims.sub, name: claims.name ?? existing.name, ...(isAdmin ? { isAdmin: true } : {}) },
        })
      : await prisma.user.create({
          data: { email, name: claims.name ?? email, googleId: claims.sub, isAdmin },
        });

    const token = signSessionToken(user.id);
    setSessionCookie(res, token);
    const returnTo = sanitizeReturnTo(state.returnTo);
    if (returnTo) {
      res.redirect(`${env.backendUrl}${returnTo}`);
      return;
    }
    res.redirect(`${env.clientUrl}/auth/callback#token=${token}`);
  }),
);

router.post('/logout', (_req: Request, res: Response) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get(
  '/me',
  auth,
  handle(async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      include: { memberships: true },
    });
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json({
      id: user.id,
      email: user.email,
      name: user.name,
      isAdmin: user.isAdmin,
      githubLogin: user.githubLogin,
      memberships: user.memberships.map((m) => ({ projectId: m.projectId, roles: m.roles, isAdmin: m.isAdmin })),
    });
  }),
);

// --- One-time GitHub account link: captures the GitHub username only. No GitHub token is stored. ---
router.get('/github/connect', authLimiter, (req: Request, res: Response) => {
  if (!env.githubClientId) {
    res.status(503).json({ error: 'GitHub OAuth is not configured' });
    return;
  }
  const header = req.headers.authorization;
  const raw = header?.startsWith('Bearer ') ? header.slice(7) : (req.query.token as string | undefined);
  if (!raw) {
    res.status(401).json({ error: 'Missing token' });
    return;
  }
  try {
    const payload = verifyToken(raw);
    const params = new URLSearchParams({
      client_id: env.githubClientId,
      redirect_uri: `${env.backendUrl}/api/auth/github/callback`,
      scope: 'read:user',
      state: signState({ userId: payload.userId }),
    });
    res.redirect(`https://github.com/login/oauth/authorize?${params}`);
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
});

router.get(
  '/github/callback',
  authLimiter,
  handle(async (req, res) => {
    const back = (q: string): void => res.redirect(`${env.clientUrl}/settings?${q}`);
    const state = verifyState((req.query.state as string | undefined) ?? '');
    const code = req.query.code as string | undefined;
    if (!state || !code || !env.githubClientId || !env.githubClientSecret) {
      back('github=error');
      return;
    }
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: env.githubClientId,
        client_secret: env.githubClientSecret,
        code,
        redirect_uri: `${env.backendUrl}/api/auth/github/callback`,
      }),
    });
    const tokenData = (await tokenRes.json()) as { access_token?: string };
    if (!tokenData.access_token) {
      back('github=error');
      return;
    }
    const userRes = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: 'application/vnd.github+json' },
    });
    if (!userRes.ok) {
      back('github=error');
      return;
    }
    const gh = (await userRes.json()) as { id: number; login: string };

    const taken = await prisma.user.findFirst({ where: { githubId: String(gh.id), NOT: { id: state.userId } } });
    if (taken) {
      back('github=already_linked_to_other');
      return;
    }
    await prisma.user.update({
      where: { id: state.userId },
      data: { githubId: String(gh.id), githubLogin: gh.login },
    });
    back('github=linked');
  }),
);

export default router;
