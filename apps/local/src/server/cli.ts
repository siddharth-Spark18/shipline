#!/usr/bin/env node
import { startLocalServer, DEFAULT_PORT } from './http';

// `pnpm dev:local`: the headless local service for developers (no tray, no windows).
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const portArg = argv.find((a) => a.startsWith('--port='))?.split('=')[1];
  const port = Number(portArg ?? process.env.SHIPLINE_LOCAL_PORT ?? DEFAULT_PORT);

  const server = await startLocalServer({ port });
  console.log(`Shipline Local is running on http://127.0.0.1:${server.port}`);
  console.log(`Open the Shipline hub (${server.hubUrl}) and enter this pairing code when asked: ${server.pairingCode()}`);

  // The code is one-time: print the next one after each successful pairing.
  let paired = server.pairedBrowsers();
  setInterval(() => {
    if (server.pairedBrowsers() > paired) console.log(`Paired. Next pairing code: ${server.pairingCode()}`);
    paired = server.pairedBrowsers();
  }, 2000).unref();

  const shutdown = (): void => {
    void server.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
