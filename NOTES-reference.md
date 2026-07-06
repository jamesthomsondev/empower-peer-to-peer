# NOTES — Reference study (`~/Dev/apsys-eileen-web`)

Task 1 of the brief: study how the reference PWA (`apsys-eileen-web`, "Pladia Empower")
bundles/serves local data & assets, and mirror those conventions here. This file records
what the reference does, what this prototype mirrors, and every deliberate deviation.

## TL;DR — the stack we're mirroring

| Concern | Reference | This prototype |
|---|---|---|
| Bundler | Vite `~7.3.1` | Vite `~7.3.1` ✅ mirror |
| Framework | React 18.3.1 | React 18.3.1 ✅ mirror |
| Language | TypeScript `^5.9.3`, `strict` | same ✅ mirror |
| PWA | `vite-plugin-pwa` `~1.2.0`, `strategies: 'injectManifest'`, hand-written `src/service-worker/sw.ts` | same shape ✅ mirror |
| Precache | `precacheAndRoute(self.__WB_MANIFEST)` from a glob | same ✅ (glob extended to include audio) |
| SW registration | prod-only, manual (`Workbox('/sw.js')`) | prod-only, manual ✅ mirror |
| Package manager | Yarn `4.14.1`, `nodeLinker: node-modules`, `~` default range | same ✅ mirror |
| Node | `24.13.0` (`.nvmrc`) | `24.13.0` ✅ mirror |
| Dev server | `vite serve` (`yarn start`), port 3000, `strictPort` | same ✅ mirror |
| Env vars | `import.meta.env.VITE_*` | same ✅ mirror (spike uses almost none) |
| Assets | imported as ES modules, output to `dist/static/` | same ✅ mirror |

## 1. Bundler

- **Vite `7.3.1`**. Config: `vite.config.ts`. Plugin `@vitejs/plugin-react` for React + styled-components display names.
- `base: '/'`. Dev server `localhost:3000`, `strictPort: true`.
- Build output: `build.assetsDir: 'static'`; hashed filenames `static/[name].[hash][extname]`,
  JS under `static/js/`. Vendor `manualChunks` splitting (not relevant at spike scale).
- Extra reference plugins we DON'T need for a spike: TanStack devtools, `vite-plugin-checker`,
  `vite-tsconfig-paths`, `vite-plugin-svgr`, favicon generation, `vite-plugin-html` for dynamic
  meta/env injection, `unplugin-fonts`. Omitted deliberately — none affect the local-data mechanics.

## 2. Static assets / local data — **the important part, and where we deviate**

**How the reference does it:** assets like SVG/PNG/fonts are imported as ES modules
(`import x from 'assets/foo.svg'`) and Vite fingerprints them into `dist/static/`.

BUT the reference's *content* (catalogue objects + media) is **NOT bundled**. It fetches a
**remote manifest** (`src/utils/bundle.ts`, URL from `getEnv().manifest`) which references
gzipped-JSON content bundles + media URLs on a CDN. Media (audio/images) is fetched on-demand
at play time and **runtime-cached** by the service worker (`CacheFirst`), not precached. The
first-run experience therefore needs the network; offline works only for content already visited.

**Why we deviate:** the whole point of this spike is that content + audio are available with
**no network after first open** (acceptance criterion #7), and that audio is device-local so the
wire only carries control messages. A remote manifest + runtime-cache-on-demand model can't
guarantee that. So:

- **Deviation 1 — content is bundled, not remote.** A local `src/content/content.json` manifest
  (2–3 artworks: `id`, `title`, `blurb`, `trackId`) is imported at build time. Audio files live in
  `src/content/audio/*.mp3` and are imported as ES-module URLs (`src/content/audio.ts`), so Vite
  fingerprints them into `dist/static/` exactly like the reference treats its SVG/PNG assets. This
  keeps the reference's "assets as ES modules" convention while guaranteeing the bytes ship in the
  build.
- **Deviation 2 — audio is precached, not runtime-cached.** The reference's `injectManifest`
  glob precaches `js,css,html` + `static/*.{svg,png,jpg,jpeg,gif,webp,ttf}`. We **extend the glob**
  to include `mp3` so the bundled audio is in the precache manifest and available offline on first
  load. (The reference keeps audio out of precache precisely because its audio is remote/large;
  ours is tiny and local, so precaching is correct here.)

Everything else about asset handling mirrors the reference.

## 3. PWA specifics

**Mirrored:**
- `vite-plugin-pwa` with `strategies: 'injectManifest'`, `srcDir: 'src/service-worker'`,
  `filename: 'sw.ts'`, `registerType: 'autoUpdate'`. Hand-written SW (not `generateSW`).
- SW precaches via `precacheAndRoute(self.__WB_MANIFEST)` + an SPA `NavigationRoute` fallback to
  `index.html`. Uses `workbox-core` `clientsClaim()`/`skipWaiting`.
- Runtime caching by destination with `workbox-strategies` + `workbox-expiration`
  (reference: images/audio `CacheFirst`, manifest `NetworkFirst`). We keep a small `CacheFirst`
  audio route as defence-in-depth even though audio is also precached.
- **SW registered in production only**, manually (reference: `new Workbox('/sw.js')` in
  `src/service-worker-registration.ts`, called from `index.tsx` under `import.meta.env.PROD`).
  We mirror this exactly. **Consequence:** offline/PWA behaviour is exercised via a production
  build (`yarn build && yarn preview`), not the dev server — same as the reference.

**Web app manifest:** the reference has **no** `manifest.webmanifest` (`VitePWA({ manifest: false })`);
it relies on `<meta>` tags injected into `index.html`. We mirror the spirit but add a tiny inline
`manifest.webmanifest` so the app is installable on iOS/Android for the two-phone test (needed to
get standalone PWA + reliable offline on mobile). Noted as a minor, test-driven addition.

## 4. Tooling / config

- **Yarn 4.14.1** via Corepack (`packageManager` field). `.yarnrc.yml`: `nodeLinker: node-modules`,
  `defaultSemverRangePrefix: "~"`. (Reference also has a private `@apsys` registry — omitted; we
  pull only public packages.)
- **Node 24.13.0** pinned in `.nvmrc`.
- **Dev command:** `yarn start` → `vite serve`. Also `yarn build`, `yarn preview` (mirrored).
- **tsconfig.json:** `target es2022`, `module esnext`, `moduleResolution bundler`, `jsx react-jsx`,
  `strict`, `resolveJsonModule`, `baseUrl "./src"`, `skipLibCheck`. (Dropped the styled-components
  TS transform plugin — not used here.)
- **Env:** `import.meta.env.VITE_*`. The spike keeps config in plain constants; the one seam is the
  Trystero strategy/relay/TURN config (`src/transport/config.ts`), overridable via `VITE_*`.

## 5. `index.html` / entry

- Reference `index.html`: viewport with `viewport-fit=cover, user-scalable=no`,
  `apple-mobile-web-app-capable`, `<div id="root">`, `<script type="module" src="/src/index.tsx">`.
  App entry `src/index.tsx` mounts React and, **in prod only**, registers the SW. We mirror this
  minimal shape.

## New dependencies vs. the reference

- **`trystero`** — required by the brief (serverless WebRTC matchmaking; no signaling server).
- **`qrcode`** — renders the room-code join URL as a QR **locally** (no network, so offline is
  preserved) to make the two-phone join trivial. Brief allows a QR "if trivial"; this keeps it so.

Workbox sub-packages (`workbox-precaching/-routing/-strategies/-expiration/-core`) match the
reference's `~7.4.x` line and are pulled transitively/explicitly for the hand-written SW.
