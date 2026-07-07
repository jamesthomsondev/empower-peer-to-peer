/**
 * Timed-media assets (audio AND video), imported as ES-module URLs so Vite fingerprints
 * each clip into dist/static/ where the service worker precaches it (see vite.config.ts).
 *
 * Used ONLY for device-LOCAL playback. Media is NEVER sent over the wire — the leader
 * broadcasts only control state (trackId/status/position); each device plays its own copy.
 *
 * The session model has a single timed-media channel (AudioState). We treat it as generic
 * "current media": a trackId may resolve to audio or video, and `kind` tells the device
 * which element to drive. This keeps the provided state machine untouched.
 */
import loom from './audio/track-loom.mp3'
import tide from './audio/track-tide.mp3'
import ember from './audio/track-ember.mp3'
import motion from './video/clip-motion.mp4'

export type MediaKind = 'audio' | 'video'

export const MEDIA: Record<string, { url: string; kind: MediaKind }> = {
  'track-loom': { url: loom, kind: 'audio' },
  'track-tide': { url: tide, kind: 'audio' },
  'track-ember': { url: ember, kind: 'audio' },
  'clip-motion': { url: motion, kind: 'video' },
}

/** Cached URLs to prime the audio/video elements with during the iOS unlock gesture. */
export const PRIMER_AUDIO_URL = loom
export const PRIMER_VIDEO_URL = motion
