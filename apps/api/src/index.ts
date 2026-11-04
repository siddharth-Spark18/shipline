import 'dotenv/config';
import app from './app';
import { env } from './lib/env';
import { ensureLocalClient } from './services/oauth.service';

async function main(): Promise<void> {
  await ensureLocalClient();
  app.listen(env.port, () => {
    console.log(`Shipline API listening on :${env.port}`);
  });
}

main().catch((err) => {
  console.error('Failed to start Shipline API:', err);
  process.exit(1);
});
