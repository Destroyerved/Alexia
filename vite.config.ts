import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

const BACKEND_URL = process.env.VITE_BACKEND_PROXY || 'http://localhost:8080';

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    // Tailwind CSS v4 — Vite-native plugin
    tailwindcss(),

    // React plugin (fast refresh, JSX transform)
    react(),

    // PWA plugin — enables offline caching and standalone installable app
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Alexia — Autonomous DevSecOps Guardian',
        short_name: 'Alexia',
        description: 'Autonomous DevSecOps Guardian Command Center with 5 AI agents, human-in-the-loop approvals, and audit trail',
        theme_color: '#0B1120',
        background_color: '#0B1120',
        display: 'standalone',
        orientation: 'any',
        icons: [
          {
            src: 'favicon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg}'],
        navigateFallback: 'index.html',
        // Keep API, SSE and FastAPI docs navigations on the network instead of the cached app shell
        navigateFallbackDenylist: [/^\/(api|v1|remote|stream|webhook|docs|redoc|openapi\.json)/],
      },
    }),
  ],

  build: {
    outDir: 'dashboard/static',
    emptyOutDir: true,
  },

  server: {
    proxy: {
      '/api': { target: BACKEND_URL, changeOrigin: true },
      '/health': { target: BACKEND_URL, changeOrigin: true },
      '/stream': { target: BACKEND_URL, changeOrigin: true },
      '/incidents': { target: BACKEND_URL, changeOrigin: true },
      '/approvals': { target: BACKEND_URL, changeOrigin: true },
      '/stats': { target: BACKEND_URL, changeOrigin: true },
      '/audit': { target: BACKEND_URL, changeOrigin: true },
      '/services': { target: BACKEND_URL, changeOrigin: true },
      '/deployments': { target: BACKEND_URL, changeOrigin: true },
      '/snapshots': { target: BACKEND_URL, changeOrigin: true },
      '/reports': { target: BACKEND_URL, changeOrigin: true },
      '/scenarios': { target: BACKEND_URL, changeOrigin: true },
      '/environment': { target: BACKEND_URL, changeOrigin: true },
      '/webhook': { target: BACKEND_URL, changeOrigin: true },
      '/remote': { target: BACKEND_URL, changeOrigin: true },
      '/dashboard': { target: BACKEND_URL, changeOrigin: true },
      '/settings': { target: BACKEND_URL, changeOrigin: true },
    },
  },

  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: [],
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
  },
});
