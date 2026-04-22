import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// COOP/COEP are required for SharedArrayBuffer — which WebContainers need.
// Safari on iPadOS enforces both; Chrome requires COEP=require-corp.
const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  // Helpful but not strictly required; prevents 3rd-party iframes from
  // ever being granted SAB access unintentionally.
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export default defineConfig({
  plugins: [
    react(),
    {
      // Apply the isolation headers to every response from `vite dev` and
      // `vite preview`. Without this, WebContainers refuse to boot locally.
      name: 'cross-origin-isolation',
      configureServer(server) {
        server.middlewares.use((_req, res, next) => {
          for (const [k, v] of Object.entries(crossOriginIsolationHeaders)) {
            res.setHeader(k, v);
          }
          next();
        });
      },
      configurePreviewServer(server) {
        server.middlewares.use((_req, res, next) => {
          for (const [k, v] of Object.entries(crossOriginIsolationHeaders)) {
            res.setHeader(k, v);
          }
          next();
        });
      },
    },
  ],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  // WebContainer's npm install downloads happen inside the service worker;
  // Vite must pre-bundle @webcontainer/api so it isn't re-evaluated each hot-reload.
  optimizeDeps: {
    exclude: ['@webcontainer/api'],
  },
  server: {
    // Bind to all interfaces so Codespaces / Docker / LAN can forward the port.
    // Without this `vite` only listens on 127.0.0.1 and the preview URL 404s.
    host: true,
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
  preview: {
    host: true,
    port: 4173,
    strictPort: false,
  },
});