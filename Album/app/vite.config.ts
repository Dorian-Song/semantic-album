import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiPort = process.env.API_PORT ?? '3200';
const apiKey = process.env.ALBUM_API_KEY ?? '';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: true,
    // The browser only ever talks to the local backend; the proxy adds the API key so the page never holds it.
    proxy: { '/api': { target: `http://127.0.0.1:${apiPort}`, headers: apiKey ? { 'X-API-Key': apiKey } : {} } },
  },
});
