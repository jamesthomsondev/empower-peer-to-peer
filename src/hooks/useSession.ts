/**
 * useSession — React binding over the SessionController + local AudioPlayer.
 *
 * Responsibilities:
 *  - own the controller lifecycle (start / join / leave)
 *  - subscribe to controller state and re-render
 *  - unlock audio inside the join/start user gesture (iOS autoplay gate)
 *  - drive local audio from the authoritative (or, when detached, local) state
 *  - provide "explore on your own" local browsing for detached followers
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  startSession,
  joinSessionAs,
  type SessionController,
} from '../transport/session-controller'
import type { ClientState, ViewState, AudioState } from '../session/session-model'
import { MediaController } from '../media/media-controller'

const HOME_VIEW: ViewState = { screen: 'home', artworkId: null }
const STOPPED_AUDIO: AudioState = { trackId: null, status: 'stopped', positionSec: 0, updatedAt: 0 }

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no ambiguous chars
function makeRoomCode(len = 4): string {
  const buf = new Uint32Array(len)
  crypto.getRandomValues(buf)
  return Array.from(buf, (n) => ROOM_ALPHABET[n % ROOM_ALPHABET.length]).join('')
}

export type Phase = 'landing' | 'connecting' | 'session'

export interface SessionApi {
  phase: Phase
  state: ClientState | null
  roomCode: string | null
  error: string | null
  isLeader: boolean
  following: boolean // leader, or a follower still mirroring the leader
  mediaUnlocked: boolean
  mountVideo: (el: HTMLElement | null) => void // ref callback for the video container
  effectiveView: ViewState
  effectiveAudio: AudioState
  start: () => Promise<void>
  join: (code: string) => Promise<void>
  leave: () => Promise<void>
  openArtwork: (id: string) => void
  goHome: () => void
  play: (trackId: string) => void
  pause: () => void
  detach: () => void
  resync: () => void
  // Keep-awake (Screen Wake Lock)
  keepAwake: boolean
  setKeepAwake: (on: boolean) => void
  wakeActive: boolean // a wake lock is currently held
  wakeSupported: boolean
}

export function useSession(): SessionApi {
  const [controller, setController] = useState<SessionController | null>(null)
  const [state, setState] = useState<ClientState | null>(null)
  const [phase, setPhase] = useState<Phase>('landing')
  const [error, setError] = useState<string | null>(null)

  // Local ("detached") browsing state — only meaningful for a detached follower.
  const [localView, setLocalView] = useState<ViewState | null>(null)
  const [localAudio, setLocalAudio] = useState<AudioState | null>(null)

  const playerRef = useRef<MediaController | null>(null)
  if (!playerRef.current) playerRef.current = new MediaController()
  const player = playerRef.current

  // Ref callback for the UI to mount/unmount the shared video element into the view.
  const mountVideo = useCallback(
    (el: HTMLElement | null) => player.mountVideoInto(el),
    [player],
  )

  // Keep-awake: on by default (a sleeping leader is the main cause of connection churn).
  const [keepAwake, setKeepAwake] = useState(true)
  const [wakeActive, setWakeActive] = useState(false)
  const wakeSupported = typeof navigator !== 'undefined' && 'wakeLock' in navigator
  const wakeRef = useRef<WakeLockSentinel | null>(null)

  // Subscribe to controller state.
  useEffect(() => {
    if (!controller) return
    setState(controller.getState())
    return controller.subscribe(() => setState(controller.getState()))
  }, [controller])

  const inSession = phase === 'session'

  // ── Screen Wake Lock ──────────────────────────────────────────────────────
  // Hold a screen wake lock while in a session (and enabled). The lock is auto-
  // released by the browser when the tab is hidden, so we re-acquire it whenever
  // we become visible again. This is the direct fix for "the leader's screen sleeps
  // and the session falls apart".
  useEffect(() => {
    if (!inSession || !keepAwake || !wakeSupported) {
      void wakeRef.current?.release().catch(() => {})
      wakeRef.current = null
      setWakeActive(false)
      return
    }
    let cancelled = false
    const acquire = async () => {
      if (cancelled || wakeRef.current || document.visibilityState !== 'visible') return
      try {
        const sentinel = await navigator.wakeLock.request('screen')
        if (cancelled) {
          void sentinel.release().catch(() => {})
          return
        }
        wakeRef.current = sentinel
        setWakeActive(true)
        sentinel.addEventListener('release', () => {
          if (wakeRef.current === sentinel) wakeRef.current = null
          setWakeActive(false)
        })
      } catch {
        setWakeActive(false) // e.g. denied in background; retried on next visibility
      }
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') void acquire()
    }
    void acquire()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisible)
      void wakeRef.current?.release().catch(() => {})
      wakeRef.current = null
      setWakeActive(false)
    }
  }, [inSession, keepAwake, wakeSupported])

  // ── Resync on wake ────────────────────────────────────────────────────────
  // Coming back from a sleep/background blip, re-pull the current truth so a peer
  // that briefly dropped (or whose leader migrated while it was out) heals cleanly
  // instead of limping on stale state.
  useEffect(() => {
    if (!inSession || !controller) return
    const onVisible = () => {
      if (document.visibilityState === 'visible') controller.recover()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [inSession, controller])

  const isLeader = state?.role === 'leader'
  const following = !state ? true : state.role === 'leader' || state.followMode === 'following'

  const effectiveView: ViewState =
    !following && localView ? localView : state?.snapshot.view ?? HOME_VIEW
  const effectiveAudio: AudioState =
    !following && localAudio ? localAudio : state?.snapshot.audio ?? STOPPED_AUDIO

  // Drive local audio to match whichever state is authoritative for this device.
  useEffect(() => {
    if (!state) return
    player.apply(effectiveAudio)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    state,
    effectiveAudio.trackId,
    effectiveAudio.status,
    effectiveAudio.positionSec,
    effectiveAudio.updatedAt,
  ])

  const enter = useCallback(
    async (create: boolean, code: string) => {
      setError(null)
      setPhase('connecting')
      try {
        // Unlock audio INSIDE the gesture, before any long await (iOS).
        await player.unlock()
        const c = create ? await startSession(code) : await joinSessionAs(code)
        setController(c)
        setPhase('session')
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        setPhase('landing')
      }
    },
    [player],
  )

  const start = useCallback(() => enter(true, makeRoomCode()), [enter])
  const join = useCallback((code: string) => enter(false, code.trim().toUpperCase()), [enter])

  const leave = useCallback(async () => {
    player.stop()
    await controller?.leave()
    setController(null)
    setState(null)
    setLocalView(null)
    setLocalAudio(null)
    setPhase('landing')
  }, [controller, player])

  // ── View actions ──
  const openArtwork = useCallback(
    (id: string) => {
      if (!state) return
      const view: ViewState = { screen: 'artwork', artworkId: id }
      if (state.role === 'leader') controller?.setView(view)
      else if (state.followMode === 'detached') setLocalView(view) // explore alone
    },
    [controller, state],
  )
  const goHome = useCallback(() => {
    if (!state) return
    if (state.role === 'leader') controller?.setView(HOME_VIEW)
    else if (state.followMode === 'detached') setLocalView(HOME_VIEW)
  }, [controller, state])

  // ── Audio actions ──
  const play = useCallback(
    (trackId: string) => {
      if (!state) return
      const audio: AudioState = {
        trackId,
        status: 'playing',
        positionSec: 0,
        updatedAt: Date.now(),
      }
      if (state.role === 'leader') controller?.setAudio(audio)
      else if (state.followMode === 'detached') setLocalAudio(audio) // local only
    },
    [controller, state],
  )
  const pause = useCallback(() => {
    if (!state) return
    const current = effectiveAudio
    const paused: AudioState = {
      ...current,
      status: 'paused',
      // capture where playback actually is right now
      positionSec:
        current.status === 'playing'
          ? current.positionSec + Math.max(0, (Date.now() - current.updatedAt) / 1000)
          : current.positionSec,
      updatedAt: Date.now(),
    }
    if (state.role === 'leader') controller?.setAudio(paused)
    else if (state.followMode === 'detached') setLocalAudio(paused)
  }, [controller, state, effectiveAudio])

  // ── Follow-mode actions ──
  const detach = useCallback(() => {
    if (!state || state.role !== 'follower') return
    // Freeze on the leader's current frame, then explore from there.
    setLocalView(state.snapshot.view)
    setLocalAudio(state.snapshot.audio)
    controller?.detach()
  }, [controller, state])

  const resync = useCallback(() => {
    setLocalView(null)
    setLocalAudio(null)
    controller?.resync()
  }, [controller])

  return {
    phase,
    state,
    roomCode: controller?.roomCode ?? null,
    error,
    isLeader,
    following,
    mediaUnlocked: player.unlocked,
    mountVideo,
    effectiveView,
    effectiveAudio,
    start,
    join,
    leave,
    openArtwork,
    goHome,
    play,
    pause,
    detach,
    resync,
    keepAwake,
    setKeepAwake,
    wakeActive,
    wakeSupported,
  }
}
