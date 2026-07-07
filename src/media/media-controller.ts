/**
 * Device-local timed-media playback for BOTH audio and video.
 *
 * Plays THIS device's cached copy of a track, positioned from the leader's control
 * state via currentAudioPosition(). Media never crosses the wire — only the control
 * state (trackId/status/position) does, and each device plays its own local file.
 *
 * The session model has one timed-media channel (AudioState). We treat it generically:
 * the content manifest says whether a trackId is audio or video, and we drive the
 * matching element (pausing the other). This keeps the provided state machine untouched.
 *
 * iOS autoplay gate: a `play` arriving over the network is not a user gesture, so iOS
 * refuses it. The one-time join tap calls unlock(), which primes BOTH the audio and
 * video elements (play→pause, muted) so they're permitted for the rest of the session.
 * The video element is created ONCE and later MOVED into the artwork view — permission
 * is tied to the element instance, so reusing it keeps video playable after the gesture.
 */
import { PRIMER_AUDIO_URL, PRIMER_VIDEO_URL } from '../content/media'
import { mediaUrl, mediaKind } from '../content'
import { currentAudioPosition, type AudioState } from '../session/session-model'

const SEEK_TOLERANCE_SEC = 0.75

export class MediaController {
  private audioEl: HTMLAudioElement
  private videoEl: HTMLVideoElement
  private ctx: AudioContext | null = null
  private currentTrackId: string | null = null
  private last: AudioState | null = null // remembered so we can re-drive when video mounts
  unlocked = false

  constructor() {
    this.audioEl = new Audio()
    this.audioEl.preload = 'auto'
    this.audioEl.loop = true

    // Persistent video element (created once → survives being moved into the view).
    const v = document.createElement('video')
    v.preload = 'auto'
    v.loop = true
    v.playsInline = true
    v.setAttribute('playsinline', '')
    v.setAttribute('webkit-playsinline', '')
    v.controls = false
    v.style.width = '100%'
    v.style.height = 'auto'
    v.style.background = '#000'
    v.style.display = 'block'
    this.videoEl = v
  }

  /** Move the persistent video element into (or out of) a React-provided container. */
  mountVideoInto(container: HTMLElement | null): void {
    if (container) {
      if (this.videoEl.parentElement !== container) container.appendChild(this.videoEl)
      if (this.last) this.apply(this.last) // artwork just opened → resume correct state
    } else if (this.videoEl.parentElement) {
      this.videoEl.pause()
      this.videoEl.parentElement.removeChild(this.videoEl)
    }
  }

  /** Call from within a real user gesture (the join tap). Unlocks audio + video. */
  async unlock(): Promise<void> {
    if (this.unlocked) return
    try {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (Ctx && !this.ctx) this.ctx = new Ctx()

      // Fire play() on both elements INSIDE the gesture (before any long await).
      if (!this.audioEl.src) this.audioEl.src = PRIMER_AUDIO_URL
      this.audioEl.muted = true
      const ap = this.audioEl.play()
      this.videoEl.src = PRIMER_VIDEO_URL
      this.videoEl.muted = true
      const vp = this.videoEl.play()

      await Promise.allSettled([ap, vp])
      this.audioEl.pause()
      this.audioEl.currentTime = 0
      this.audioEl.muted = false
      this.videoEl.pause()
      this.videoEl.currentTime = 0
      this.videoEl.muted = false
      if (this.ctx?.state === 'suspended') await this.ctx.resume()
      this.currentTrackId = null // force a real load on the next apply()
      this.unlocked = true
    } catch {
      this.unlocked = true // gesture usually suffices even if priming throws
    }
  }

  /** Drive local playback to match an authoritative media state. */
  apply(state: AudioState): void {
    this.last = state
    const kind = mediaKind(state.trackId)
    if (kind === 'video') {
      this.audioEl.pause()
      this.drive(this.videoEl, state)
    } else if (kind === 'audio') {
      this.videoEl.pause()
      this.drive(this.audioEl, state)
    } else {
      this.audioEl.pause()
      this.videoEl.pause()
      this.currentTrackId = null
    }
  }

  private drive(el: HTMLMediaElement, state: AudioState): void {
    const url = mediaUrl(state.trackId)
    if (!url) {
      el.pause()
      return
    }
    const trackChanged = this.currentTrackId !== state.trackId
    if (trackChanged) {
      this.currentTrackId = state.trackId
      el.src = url
      el.load()
    }

    const go = () => {
      if (state.status === 'playing') {
        let target = currentAudioPosition(state)
        if (el.loop && isFinite(el.duration) && el.duration > 0) {
          target = target % el.duration // keep looping clips roughly in phase
        }
        if (Math.abs(el.currentTime - target) > SEEK_TOLERANCE_SEC) {
          try {
            el.currentTime = target
          } catch {
            /* not seekable yet */
          }
        }
        void el.play().catch(() => {
          /* rejected until unlocked; the join tap fixes this */
        })
      } else {
        el.pause()
        try {
          let p = state.status === 'stopped' ? 0 : state.positionSec
          if (el.loop && isFinite(el.duration) && el.duration > 0) p = p % el.duration
          el.currentTime = p
        } catch {
          /* ignore */
        }
      }
    }

    // Seek needs metadata (duration/seekable). If it's ready, go now; otherwise wait
    // for it — this handles both a freshly (re)loaded src and an already-primed element.
    if (el.readyState >= 1 /* HAVE_METADATA */) go()
    else el.addEventListener('loadedmetadata', go, { once: true })
  }

  stop(): void {
    this.audioEl.pause()
    this.videoEl.pause()
  }
}
