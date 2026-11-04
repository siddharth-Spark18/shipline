import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

// Dev: `pnpm --filter @shipline/ui dev:ui` with SHIPLINE_UI_URL pointing at a running
// `npx @forgeyard/shipline ui` (for example http://127.0.0.1:4173) and the server started with
// SHIPLINE_UI_DEV_ORIGIN=http://localhost:5173.
const target = process.env.SHIPLINE_UI_URL || 'http://127.0.0.1:4173';
const outDir = process.env.SHIPLINE_UI_OUT || path.resolve(__dirname, '../cli/ui-dist');

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  build: {
    outDir,
    // The output folder is outside the Vite root, so Vite would not empty it otherwise.
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': { target, changeOrigin: true },
      '/?t=': { target, changeOrigin: true },
    },
  },
});
