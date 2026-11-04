import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import { env } from './lib/env';
import { requestLogger } from './middleware/request-logger';

import authRoutes from './routes/auth';
import oauthRoutes, { wellKnownRouter } from './routes/oauth';
import projectRoutes from './routes/projects';
import chatRoutes from './routes/chats';
import ticketRoutes from './routes/tickets';
import stageRunRoutes, { toolDecisionRouter } from './routes/stage-runs';
import jiraRoutes from './routes/jira';
import localRoutes from './routes/local';
import adminRoutes from './routes/admin';
import webhookRoutes from './routes/webhook';
import mcpRoutes from './mcp/server';

const app: ReturnType<typeof express> = express();

if (env.httpLogging) app.use(requestLogger);

// MCP clients and Shipline Local call from other origins with Bearer tokens (no cookies needed),
// so these paths are registered before the web-hub-only CORS rule.
app.use('/mcp', cors({ origin: true, exposedHeaders: ['WWW-Authenticate', 'Mcp-Session-Id'] }));
app.use('/.well-known', cors({ origin: true }));
app.use('/oauth', cors({ origin: true }));
app.use(cors({ origin: [env.clientUrl], credentials: true }));

// Raw body is kept for GitHub webhook signature verification.
app.use(
  express.json({
    limit: '5mb',
    verify: (req: express.Request, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use('/.well-known', wellKnownRouter);
app.use('/oauth', oauthRoutes);
app.use('/mcp', mcpRoutes);

app.use('/api/auth', authRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/chats', chatRoutes);
app.use('/api/tickets', ticketRoutes);
app.use('/api/stage-runs', stageRunRoutes);
app.use('/api/tool-decisions', toolDecisionRouter);
app.use('/api/jira', jiraRoutes);
app.use('/api/local', localRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/webhook', webhookRoutes);

app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(`Unhandled error in ${req.method} ${req.path}:`, err?.stack ?? err);
  res.status(500).json({ error: 'Internal server error' });
});

export default app;
