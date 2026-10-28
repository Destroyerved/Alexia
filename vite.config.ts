import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

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
      },
    }),
  ],

  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: [],
    include: ['src/__tests__/alexia.test.tsx'],
  },
});
