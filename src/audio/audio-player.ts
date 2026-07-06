/**
 * Device-local audio playback.
 *
 * Plays THIS device's cached copy of a track, positioned from the leader's control
 * state via currentAudioPosition(). No audio ever crosses the wire.
 *
 * iOS autoplay gate: a `play` arriving over the network is NOT a user gesture, so
 * iOS Safari silently refuses it. We require one tap when joining ("Tap to join")
 * and use that gesture to unlock() the element (+ resume an AudioContext) for the
 * whole session. After unlock, programmatic play()/src-swap on the same element works.
 */
import { AUDIO_URLS } from '../content/audio'
import { audioUrl } from '../content'
import { currentAudioPosition, type AudioState } from '../session/session-model'

const SEEK_TOLERANCE_SEC = 0.75

export class AudioPlayer {
  private el: HTMLAudioElement
  private ctx: AudioContext | null = null
  private currentTrackId: string | null = null
  unlocked = false

  constructor() {
    this.el = new Audio()
    this.el.preload = 'auto'
    this.el.loop = true // clips are short; loop so "playing" stays audible
  }

  /** Call from within a real user gesture (the join tap). */
  async unlock(): Promise<void> {
    if (this.unlocked) return
    try {
      // Resume a Web Audio context too (belt-and-suspenders for iOS).
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (Ctx && !this.ctx) this.ctx = new Ctx()
      if (this.ctx?.state === 'suspended') await this.ctx.resume()

      // Prime the element inside the gesture: play a real (cached) source muted,
      // then pause. This grants the element playback permission for the session.
      if (!this.el.src) this.el.src = Object.values(AUDIO_URLS)[0]
      this.el.muted = true
      await this.el.play()
      this.el.pause()
      this.el.currentTime = 0
      this.el.muted = false
      this.currentTrackId = null // force a real load on the next apply()
      this.unlocked = true
    } catch {
      // Even if priming throws, mark unlocked so we don't block the session; the
      // gesture itself usually suffices on iOS.
      this.unlocked = true
    }
  }

  /** Drive local playback to match an authoritative AudioState. */
  apply(audio: AudioState): void {
    const url = audioUrl(audio.trackId)
    if (!url) {
      this.el.pause()
      this.currentTrackId = null
      return
    }

    const trackChanged = this.currentTrackId !== audio.trackId
    if (trackChanged) {
      this.currentTrackId = audio.trackId
      this.el.src = url
    }

    const drive = () => {
      if (audio.status === 'playing') {
        let target = currentAudioPosition(audio)
        // Clips loop; fold the (unbounded) leader position into the clip length so
        // devices stay roughly in phase across loops.
        if (this.el.loop && isFinite(this.el.duration) && this.el.duration > 0) {
          target = target % this.el.duration
        }
        if (Math.abs(this.el.currentTime - target) > SEEK_TOLERANCE_SEC) {
          try {
            this.el.currentTime = target
          } catch {
            /* not seekable yet */
          }
        }
        void this.el.play().catch(() => {
          /* rejected if not yet unlocked; the join tap fixes this */
        })
      } else {
        this.el.pause()
        try {
          this.el.currentTime = audio.status === 'stopped' ? 0 : audio.positionSec
        } catch {
          /* ignore */
        }
      }
    }

    if (trackChanged) {
      this.el.addEventListener('loadedmetadata', drive, { once: true })
      this.el.load()
    } else {
      drive()
    }
  }

  stop(): void {
    this.el.pause()
  }
}
