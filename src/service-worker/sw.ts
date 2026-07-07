/// <reference lib="webworker" />
/**
 * Hand-written service worker (injectManifest strategy), mirroring the reference
 * (apsys-eileen-web src/service-worker/sw.ts). vite-plugin-pwa injects the precache
 * manifest at build; we precache app shell + bundled content/audio, add an SPA
 * navigation fallback, and keep a defensive runtime cache for audio.
 *
 * Offline goal: after first load, artwork content + audio load & play with NO
 * network. Only NEW peers joining needs the network (WebRTC signaling).
 */
import { clientsClaim } from 'workbox-core'
import { precacheAndRoute, createHandlerBoundToURL } from 'workbox-precaching'
import { registerRoute, NavigationRoute } from 'workbox-routing'
import { CacheFirst } from 'workbox-strategies'
import { ExpirationPlugin } from 'workbox-expiration'
import { RangeRequestsPlugin } from 'workbox-range-requests'

declare let self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>
}

self.skipWaiting()
clientsClaim()

// Precache the app shell + everything matched by the injectManifest glob
// (js/css/html/webmanifest + static/*.{svg,png,...,mp3}). This is what makes the
// gallery content and audio available offline on the very first launch.
precacheAndRoute(self.__WB_MANIFEST)

// SPA navigation fallback → index.html (so the app boots offline / on deep links).
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('index.html'), {
    denylist: [/\/[^/?]+\.[^/]+$/], // skip requests that look like files
  }),
)

// Defence-in-depth: audio/video/images are already precached, but if a media file is
// ever fetched at runtime (e.g. a Range request), serve it cache-first so playback
// never depends on the network. RangeRequestsPlugin lets the SW satisfy the partial
// (206) requests browsers use to seek within <audio>/<video>.
registerRoute(
  ({ request }) => request.destination === 'audio' || request.destination === 'video',
  new CacheFirst({
    cacheName: 'media-cache',
    plugins: [
      new RangeRequestsPlugin(),
      new ExpirationPlugin({ maxEntries: 20, maxAgeSeconds: 7 * 24 * 60 * 60 }),
    ],
  }),
)

registerRoute(
  ({ request }) => request.destination === 'image',
  new CacheFirst({
    cacheName: 'image-cache',
    plugins: [new ExpirationPlugin({ maxEntries: 50, maxAgeSeconds: 7 * 24 * 60 * 60 })],
  }),
)
