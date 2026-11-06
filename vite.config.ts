import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

/** Adds the PWA-related <head> tags (icons, theme colour, iOS standalone) without touching index.html. */
const pwaHead = (): Plugin => ({
  name: 'darkroom-pwa-head',
  transformIndexHtml: {
    order: 'post',
    handler: (html, ctx) =>
      ctx.filename.endsWith('harness.html')
        ? html
        : html.replace(
            '</head>',
            [
              '<meta name="theme-color" content="#2b2b2d">',
              '<meta name="apple-mobile-web-app-capable" content="yes">',
              '<meta name="mobile-web-app-capable" content="yes">',
              '<meta name="apple-mobile-web-app-title" content="Darkroom">',
              '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
              '<link rel="apple-touch-icon" href="/pwa/apple-touch-icon.png">',
              '<link rel="icon" type="image/png" sizes="64x64" href="/pwa/favicon-64.png">',
              '</head>',
            ].join('\n    '),
          ),
  },
})

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    pwaHead(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'script-defer',
      // keep the service worker out of `vite dev` so HMR and the snapshot harness stay predictable
      devOptions: { enabled: false },
      includeAssets: ['pwa/*.png', 'pwa/logo.svg', 'samples/*.jpg', 'plugins/**/*'],
      manifest: {
        id: '/',
        name: 'Darkroom — node-based shader image editor',
        short_name: 'Darkroom',
        description:
          'Wire up GPU shader nodes to make photos look like they came from a 2002 digicam, a disposable camera, a VHS tape — or anything else.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        display_override: ['window-controls-overlay', 'standalone'],
        orientation: 'any',
        background_color: '#1d1e21',
        theme_color: '#2b2b2d',
        categories: ['photo', 'graphics', 'productivity'],
        icons: [
          { src: '/pwa/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/pwa/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/pwa/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: '/pwa/logo.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      workbox: {
        // app shell + node library are precached → the editor works fully offline
        globPatterns: ['**/*.{js,css,html,svg,woff2}', 'samples/*.jpg', 'pwa/*.png', 'plugins/**/*.{js,json}'],
        globIgnores: ['**/harness*', 'icons/**'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/harness/],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            // ~3900 FatCow icons: cache the ones actually used, on demand
            urlPattern: ({ url }) => url.pathname.startsWith('/icons/'),
            handler: 'CacheFirst',
            options: { cacheName: 'fatcow-icons', expiration: { maxEntries: 600 } },
          },
        ],
      },
    }),
  ],
  build: { rollupOptions: { input: { main: 'index.html', harness: 'harness.html' } } },
})
