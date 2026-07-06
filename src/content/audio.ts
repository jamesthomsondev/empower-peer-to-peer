/**
 * Audio assets, imported as ES modules — mirrors the reference's asset convention
 * (`import x from 'assets/...'`), so Vite fingerprints each clip into dist/static/
 * where the service worker precaches it (see vite.config.ts injectManifest glob).
 *
 * These URLs are used ONLY for device-LOCAL playback. Audio is NEVER sent over the
 * wire — the leader broadcasts only control state (trackId/status/position); each
 * device plays its own cached copy.
 */
import loom from './audio/track-loom.mp3'
import tide from './audio/track-tide.mp3'
import ember from './audio/track-ember.mp3'

export const AUDIO_URLS: Record<string, string> = {
  'track-loom': loom,
  'track-tide': tide,
  'track-ember': ember,
}
