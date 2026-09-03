import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('../web', import.meta.url)),
    emptyOutDir: true,
    target: 'es2020',
  },
  server: {
    // RC_DEV_HOST lets a dev container expose Vite (0.0.0.0); the default stays
    // loopback-only so an unguarded dev server is never reachable on the LAN.
    host: process.env.RC_DEV_HOST ?? '127.0.0.1',
    port: 5173,
    allowedHosts: process.env.RC_DEV_ALLOWED_HOSTS
      ? process.env.RC_DEV_ALLOWED_HOSTS.split(',')
      : undefined,
    proxy: {
      '/api': 'http://127.0.0.1:8080',
      '/ws': {
        target: 'ws://127.0.0.1:8080',
        ws: true,
      },
    },
  },
});
