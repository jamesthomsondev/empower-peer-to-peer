import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// Mirrors apsys-eileen-web: Vite 7 + React + vite-plugin-pwa (injectManifest, hand-written SW).
// See NOTES-reference.md for the conventions this follows and where it deviates.
export default defineConfig({
  base: "/",
  plugins: [
    react(),
    VitePWA({
      // Hand-written service worker, same as the reference (not generateSW).
      strategies: "injectManifest",
      srcDir: "src/service-worker",
      filename: "sw.ts",
      registerType: "autoUpdate",
      // We register the SW manually in prod (src/service-worker-registration.ts),
      // mirroring the reference, so disable the plugin's auto-injected registration.
      injectRegister: false,
      injectManifest: {
        // Reference precaches js/css/html + static images/fonts. We ADD audio (mp3)
        // so the bundled gallery audio is available fully offline on first load.
        globPatterns: [
          "**/*.{js,css,html,webmanifest}",
          "static/**/*.{svg,png,jpg,jpeg,gif,webp,ttf,woff2,mp3,mp4,ico}",
        ],
        // clip-motion.mp4 is ~1.1 MB; keep the precache size ceiling above default (2 MiB).
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      },
      // Minimal installable manifest (reference relies on meta tags; we add this so the
      // app installs as a standalone PWA on phones — needed for the two-device offline test).
      manifest: {
        name: "Empower — Shared Gallery (spike)",
        short_name: "Empower P2P",
        description:
          "Leader-driven shared gallery experience over WebRTC (feasibility spike).",
        display: "standalone",
        orientation: "portrait",
        background_color: "#111111",
        theme_color: "#111111",
        start_url: "/",
        icons: [
          {
            src: "icon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any maskable",
          },
        ],
      },
    }),
  ],
  server: {
    port: 3000,
    strictPort: true,
    // Expose on the LAN so a second device can reach the dev server.
    host: true,
    allowedHosts: [
      "localhost",
      "127.0.0.1",
      ".trycloudflare.com",
      "bs-local.com",
    ],
  },
  preview: {
    port: 4173,
    strictPort: true,
    host: true,
    allowedHosts: true
  },
  build: {
    // Mirror the reference: hashed assets under dist/static/.
    assetsDir: "static",
    rollupOptions: {
      output: {
        assetFileNames: "static/[name].[hash][extname]",
        entryFileNames: "static/js/[name].[hash].js",
        chunkFileNames: "static/js/[name].[hash].js",
      },
    },
  },
})
