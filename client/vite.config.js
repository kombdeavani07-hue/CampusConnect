import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { getWifiHost } from '../scripts/network.mjs';

export default defineConfig(({ command }) => {
  // Builds also work offline; only a running website needs a Wi-Fi address.
  const host = command === 'serve' ? getWifiHost() : undefined;
  return {
    plugins: [react()],
    server: { host, port: 5173, strictPort: true, proxy: { '/api': 'http://127.0.0.1:4000' } },
    preview: { host, port: 5173, strictPort: true, proxy: { '/api': 'http://127.0.0.1:4000' } }
  };
});
