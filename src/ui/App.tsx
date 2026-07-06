import { useState } from 'react'
import { useSession } from '../hooks/useSession'
import { ARTWORKS, artworkById } from '../content'
import { STRATEGY } from '../transport/config'
import { currentAudioPosition } from '../session/session-model'
import { QRCode } from './QRCode'
import { DebugPanel } from './DebugPanel'

export function App() {
  const s = useSession()

  if (s.phase !== 'session' || !s.state) {
    return <Landing api={s} />
  }

  return <Session api={s} />
}

// ─────────────────────────────── Landing ────────────────────────────────

function Landing({ api }: { api: ReturnType<typeof useSession> }) {
  const params = new URLSearchParams(window.location.search)
  const [code, setCode] = useState(params.get('room')?.toUpperCase() ?? '')
  const connecting = api.phase === 'connecting'

  return (
    <main className="wrap">
      <h1>Empower — Shared Gallery</h1>
      <p className="muted">
        Feasibility spike · peer-to-peer over WebRTC ({STRATEGY}) · audio is device-local
      </p>

      {api.error && <p className="error">⚠ {api.error}</p>}

      <div className="card">
        <h2>Start a session</h2>
        <p className="muted">Become the leader and share the room code.</p>
        <button disabled={connecting} onClick={() => void api.start()}>
          {connecting ? 'Connecting…' : 'Start session (become leader)'}
        </button>
      </div>

      <div className="card">
        <h2>Join a session</h2>
        <p className="muted">Enter the leader's room code.</p>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="e.g. K7QF"
          maxLength={8}
          autoCapitalize="characters"
          autoCorrect="off"
        />
        <button
          disabled={connecting || code.trim().length < 3}
          onClick={() => void api.join(code)}
        >
          {connecting ? 'Connecting…' : 'Join (tap to enter the experience)'}
        </button>
        <p className="hint">
          The one tap unlocks audio for this device (needed on iOS before playback).
        </p>
      </div>
    </main>
  )
}

// ─────────────────────────────── Session ────────────────────────────────

function Session({ api }: { api: ReturnType<typeof useSession> }) {
  const { state } = api
  if (!state) return null
  const view = api.effectiveView
  const audio = api.effectiveAudio
  const canControl = api.isLeader || (state.role === 'follower' && state.followMode === 'detached')
  const artwork = artworkById(view.artworkId)
  const joinUrl = `${window.location.origin}${window.location.pathname}?room=${api.roomCode}`
  // A follower that hasn't received the leader's snapshot yet (matchmaking still
  // discovering peers). It is NOT a leader — it's waiting to sync.
  const connecting = state.role === 'follower' && state.snapshot.epoch < 0

  return (
    <main className="wrap">
      <header className="topbar">
        <div>
          <b>
            {api.isLeader
              ? '👑 Leader'
              : connecting
                ? '… Connecting'
                : api.following
                  ? '🔗 Following'
                  : '🧭 Exploring'}
          </b>
          <span className="muted"> · room </span>
          <code className="roomcode">{api.roomCode}</code>
        </div>
        <button className="ghost" onClick={() => void api.leave()}>
          Leave
        </button>
      </header>

      {connecting && (
        <div className="connecting">
          Connecting to the session… finding the leader over the network. This can take a
          few seconds. (You are a follower — you won't become the leader.)
        </div>
      )}

      <div className="awakebar">
        <label>
          <input
            type="checkbox"
            checked={api.keepAwake}
            disabled={!api.wakeSupported}
            onChange={(e) => api.setKeepAwake(e.target.checked)}
          />{' '}
          Keep screen awake
        </label>
        <span className="muted small">
          {!api.wakeSupported
            ? 'not supported on this browser'
            : api.keepAwake
              ? api.wakeActive
                ? '🟢 active — screen won’t sleep'
                : '🟡 idle (re-arms when visible)'
              : 'off'}
        </span>
        {api.isLeader && (
          <span className="hint small">Recommended for the leader — a sleeping screen drops the session.</span>
        )}
      </div>

      {/* Follower follow/detach controls */}
      {state.role === 'follower' && (
        <div className="followbar">
          {api.following ? (
            <button onClick={api.detach}>Following — tap to explore on your own</button>
          ) : (
            <>
              <span className="muted">Exploring on your own.</span>
              <button onClick={api.resync}>Resync to leader</button>
            </>
          )}
        </div>
      )}

      {/* Share (mostly useful for the leader) */}
      <details className="share" open={api.isLeader}>
        <summary>Share / invite</summary>
        <div className="share-body">
          <QRCode value={joinUrl} />
          <div>
            <p>
              Room code: <code className="roomcode big">{api.roomCode}</code>
            </p>
            <p className="muted small">{joinUrl}</p>
          </div>
        </div>
      </details>

      {/* Content */}
      {view.screen === 'home' ? (
        <section>
          <div className="section-head">
            <h2>Gallery</h2>
            {!canControl && <span className="muted small">mirroring leader — read only</span>}
          </div>
          <ul className="artworks">
            {ARTWORKS.map((a) => (
              <li key={a.id}>
                <button
                  className="artwork-item"
                  disabled={!canControl}
                  onClick={() => api.openArtwork(a.id)}
                >
                  <b>{a.title}</b>
                  <span className="muted small"> {a.blurb.slice(0, 60)}…</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <section className="artwork-detail">
          <button className="ghost" disabled={!canControl} onClick={api.goHome}>
            ← Back to gallery
          </button>
          {artwork ? (
            <>
              <h2>{artwork.title}</h2>
              <p>{artwork.blurb}</p>
              <div className="audio-controls">
                {audio.status === 'playing' && audio.trackId === artwork.trackId ? (
                  <button disabled={!canControl} onClick={api.pause}>
                    ⏸ Pause audio
                  </button>
                ) : (
                  <button disabled={!canControl} onClick={() => api.play(artwork.trackId)}>
                    ▶ Play audio
                  </button>
                )}
                <span className="muted small">
                  {audio.trackId === artwork.trackId
                    ? `${audio.status} · ${currentAudioPosition(audio).toFixed(1)}s`
                    : 'not playing this track'}
                </span>
              </div>
              {!canControl && (
                <p className="hint">
                  You're mirroring the leader. Detach above to control your own playback.
                </p>
              )}
              {!api.audioUnlocked && (
                <p className="error small">Audio not unlocked — rejoin and tap to enable.</p>
              )}
            </>
          ) : (
            <p className="muted">Unknown artwork.</p>
          )}
        </section>
      )}

      <DebugPanel
        state={state}
        effectiveView={view}
        effectiveAudio={audio}
        following={api.following}
      />
    </main>
  )
}
