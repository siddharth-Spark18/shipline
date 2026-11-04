function mustGet(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

// Optional on/off flag: accepts true/false/1/0 (case-insensitive), falling back to `fallback`.
function getBool(key: string, fallback: boolean): boolean {
  const value = process.env[key]?.trim().toLowerCase();
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return fallback;
}

function getList(key: string): string[] {
  return (process.env[key] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const env = {
  port: parseInt(process.env.PORT ?? '3000', 10),
  backendUrl: mustGet('BACKEND_URL').replace(/\/$/, ''),
  clientUrl: mustGet('CLIENT_URL').replace(/\/$/, ''),
  databaseUrl: mustGet('DATABASE_URL'),
  jwtSecret: mustGet('JWT_SECRET'),
  sessionExpiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
  accessTokenTtlSeconds: parseInt(process.env.OAUTH_ACCESS_TOKEN_TTL ?? '3600', 10),
  encryptionKey: mustGet('ENCRYPTION_KEY'),
  googleClientId: mustGet('GOOGLE_CLIENT_ID'),
  googleClientSecret: mustGet('GOOGLE_CLIENT_SECRET'),
  googleAllowedDomain: process.env.GOOGLE_ALLOWED_DOMAIN?.toLowerCase() || null,
  adminEmails: getList('ADMIN_EMAILS').map((e) => e.toLowerCase()),
  githubClientId: process.env.GITHUB_CLIENT_ID ?? null,
  githubClientSecret: process.env.GITHUB_CLIENT_SECRET ?? null,
  githubAppId: process.env.GITHUB_APP_ID ?? null,
  githubAppPrivateKey: process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n') ?? null,
  githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET ?? null,
  jiraClientId: process.env.JIRA_CLIENT_ID ?? null,
  jiraClientSecret: process.env.JIRA_CLIENT_SECRET ?? null,
  mcpExtraRedirectUris: getList('MCP_EXTRA_REDIRECT_URIS'),
  maxArtifactBytes: parseInt(process.env.MAX_ARTIFACT_BYTES ?? '1048576', 10),
  latestPluginVersion: process.env.LATEST_PLUGIN_VERSION ?? '0.2.0',
  apiVersion: '0.1.0',
  httpLogging: getBool('HTTP_LOGGING', true),
};
