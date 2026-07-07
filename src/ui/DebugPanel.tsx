import type { ReactNode } from 'react'
import type { ClientState, ViewState, AudioState } from '../session/session-model'
import { currentAudioPosition } from '../session/session-model'
import { mediaKind } from '../content'

/**
 * The debug panel — this matters more than styling. It's how we read what the mesh
 * is doing: role, current leader, epoch, follow mode, connected peers, view + audio.
 */
export function DebugPanel({
  state,
  effectiveView,
  effectiveAudio,
  following,
}: {
  state: ClientState
  effectiveView: ViewState
  effectiveAudio: AudioState
  following: boolean
}) {
  const { selfId, role, followMode, snapshot, peers } = state
  const peerIds = [...peers.keys()].sort()
  const now = Date.now()

  const row = (label: string, value: ReactNode) => (
    <div className="dbg-row">
      <span className="dbg-key">{label}</span>
      <span className="dbg-val">{value}</span>
    </div>
  )

  return (
    <section className="debug">
      <h2>Debug — mesh state</h2>
      {row('my id', <code>{short(selfId)}</code>)}
      {row('role', <b className={role === 'leader' ? 'tag-leader' : 'tag-follower'}>{role}</b>)}
      {row('follow mode', following ? 'following' : <b className="tag-detached">{followMode}</b>)}
      {row('leader id', <code>{short(snapshot.leaderId) || '—'}</code>)}
      {row('epoch', <b>{snapshot.epoch}</b>)}
      {row(
        `peers (${peerIds.length})`,
        <div className="peers">
          {peerIds.map((id) => {
            const p = peers.get(id)!
            const age = Math.round((now - p.lastSeen) / 1000)
            const isSelf = id === selfId
            const isLeader = id === snapshot.leaderId
            return (
              <span key={id} className="peer" title={id}>
                <code>{short(id)}</code>
                {isSelf && ' (me)'}
                {isLeader && ' 👑'}
                <span className="peer-age"> {age}s</span>
              </span>
            )
          })}
        </div>,
      )}
      {row(
        'view',
        <code>
          {effectiveView.screen}
          {effectiveView.artworkId ? ` · ${effectiveView.artworkId}` : ''}
        </code>,
      )}
      {row(
        'media',
        <code>
          {effectiveAudio.trackId ?? '—'}
          {effectiveAudio.trackId ? ` (${mediaKind(effectiveAudio.trackId) ?? '?'})` : ''} ·{' '}
          {effectiveAudio.status} · {currentAudioPosition(effectiveAudio, now).toFixed(1)}s
        </code>,
      )}
    </section>
  )
}

function short(id: string): string {
  return id ? id.slice(0, 6) : ''
}
