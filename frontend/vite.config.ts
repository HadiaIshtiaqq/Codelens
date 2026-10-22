import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = process.env.CODELENS_API_URL ?? 'http://127.0.0.1:8000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: api, changeOrigin: true },
      '/health': { target: api, changeOrigin: true },
    },
  },
  build: {
    chunkSizeWarningLimit: 6000, // Monaco is bundled locally (no CDN)
  },
  test: {
    environment: 'node',
  },
});
