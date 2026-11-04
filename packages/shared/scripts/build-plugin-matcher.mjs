// Bundles src/guardrails.ts (the shared rule matcher) into the plugin as a plain ES module, so the
// guard hook (packages/plugin/scripts/guard-edit.mjs) evaluates rules with the same code as the
// server. Re-run after changing guardrails.ts: `pnpm --filter @shipline/shared build:plugin-matcher`.
import { build } from 'tsup';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
await build({
  entry: { guardrails: path.join(here, '../src/guardrails.ts') },
  format: ['esm'],
  outDir: path.join(here, '../../plugin/scripts/vendor'),
  outExtension: () => ({ js: '.mjs' }),
  dts: false,
  clean: false,
  minify: false,
  banner: { js: '// GENERATED from packages/shared/src/guardrails.ts by packages/shared/scripts/build-plugin-matcher.mjs. Do not edit.' },
});
