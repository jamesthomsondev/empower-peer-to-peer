/**
 * SessionController — the transport binding.
 *
 * Glues Trystero (mesh WebRTC) to the authoritative state machine in
 * ../session/session-model.ts. It owns NO session logic of its own: every state
 * change flows through the model's pure reducers, and the controller only
 *   (a) persists the returned `state`, and
 *   (b) flushes the returned `outbox` over the wire.
 *
 * Framework-agnostic: exposes getState()/subscribe() so a React hook (or anything)
 * can render it. See ../hooks/useSessionController.ts.
 */

import type { Room } from 'trystero'
import {
  createSession,
  joinSession,
  receive,
  requestInitialSnapshot,
  leaderHeartbeat,
  isLeaderStale,
  onLeaderLost,
  leaderSetView,
  leaderSetAudio,
  detach,
  resync,
  type ClientState,
  type Message,
  type Outcome,
  type ViewState,
  type AudioState,
  type PeerId,
  type PeerInfo,
} from '../session/session-model'
import { APP_ID, RTC_CONFIG, RELAY_URLS, STRATEGY, loadStrategy } from './config'

const ACTION = 'msg' // single Trystero action carrying the gossip envelope
const HEARTBEAT_MS = 2000
const STALE_TIMEOUT_MS = 6000
// A peer we haven't heard from (directly or via relayed heartbeat) for this long is
// pruned from our peer set, so departed peers age out everywhere and deterministic
// succession keeps computing over a convergent set. Must be > STALE_TIMEOUT_MS.
const PEER_PRUNE_MS = 9000
const MAX_HOPS = 8 // gossip time-to-live safety net (de-dup already prevents loops)
const SEEN_MAX = 2000 // bounded de-dup memory

type Listener = () => void

/**
 * Gossip envelope. Trystero's send only reaches DIRECTLY-connected peers, but on a
 * real venue network the mesh is often only partially connected (some phone pairs
 * can't traverse NAT). We flood every message hop-by-hop and de-duplicate by `gid`,
 * so a message reaches a peer as long as SOME path of connections exists — a follower
 * no longer needs a direct link to the leader, only a path to any connected peer.
 */
interface Gossip {
  gid: string // `${origin}#${seq}` — unique per original message, used for de-dup
  origin: PeerId // the ORIGINAL sender (logical `from`); relays preserve it
  to: PeerId | 'all' // routing target: flood-to-everyone, or deliver-to-one
  ttl: number
  msg: Message
}

export interface SessionController {
  readonly roomCode: string
  readonly selfId: PeerId
  getState(): ClientState
  subscribe(fn: Listener): () => void
  // Leader actions
  setView(view: ViewState): void
  setAudio(audio: AudioState): void
  // Follower actions
  detach(): void
  resync(): void
  // Recovery: re-pull current truth after a suspend/reconnect (e.g. screen woke).
  recover(): void
  // Teardown
  leave(): Promise<void>
}

export async function startSession(roomCode: string): Promise<SessionController> {
  return createController(roomCode, /* asLeader */ true)
}

export async function joinSessionAs(roomCode: string): Promise<SessionController> {
  return createController(roomCode, /* asLeader */ false)
}

async function createController(
  roomCode: string,
  asLeader: boolean,
): Promise<SessionController> {
  const { joinRoom, selfId } = await loadStrategy()

  let state: ClientState = asLeader ? createSession(selfId) : joinSession(selfId)
  const listeners = new Set<Listener>()
  // Guard so leader-loss is acted on only on the FIRST stale reading per leader.
  let staleReportedFor: PeerId | null = null

  // Use the room code as both the room id and the E2E password (all peers share
  // it already). WebRTC data channels are DTLS-encrypted regardless; the password
  // adds app-level end-to-end encryption keyed to the code.
  const room: Room = joinRoom(
    {
      appId: APP_ID,
      password: roomCode,
      rtcConfig: RTC_CONFIG,
      // Only override relays if explicitly configured (VITE_NOSTR_RELAYS). Otherwise
      // Trystero's appId-seeded default selection already guarantees peers share relays.
      ...(STRATEGY === 'nostr' && RELAY_URLS.length ? { relayConfig: { urls: RELAY_URLS } } : {}),
    },
    roomCode,
  )

  const action = room.makeAction(ACTION)

  const notify = () => listeners.forEach((fn) => fn())
  const setState = (next: ClientState) => {
    state = next
    notify()
  }

  // Gossip / relay ----------------------------------------------------------
  // Envelope is JSON-serialisable but doesn't structurally satisfy Trystero's
  // JsonValue type, so send through a locally-loosened signature.
  const rawSend = action.send as (
    data: unknown,
    options?: { target?: PeerId | PeerId[] },
  ) => Promise<void>

  let seq = 0
  const seen = new Set<string>()
  const seenQueue: string[] = []
  const markSeen = (gid: string) => {
    if (seen.has(gid)) return false
    seen.add(gid)
    seenQueue.push(gid)
    if (seenQueue.length > SEEN_MAX) seen.delete(seenQueue.shift()!)
    return true
  }

  /** Fan an envelope out to our directly-connected neighbours (optionally excluding one). */
  const fanout = (env: Gossip, exclude?: PeerId) => {
    const neighbours = Object.keys(room.getPeers()).filter((id) => id !== exclude)
    if (neighbours.length === 0) return
    void rawSend(env, { target: neighbours })
  }

  /** Emit a NEW message we originate. */
  const originate = (msg: Message, to: PeerId | 'all') => {
    const env: Gossip = { gid: `${selfId}#${seq++}`, origin: selfId, to, ttl: MAX_HOPS, msg }
    markSeen(env.gid)
    fanout(env)
  }

  const flush = (outbox: Outcome['outbox']) => {
    for (const { to, msg } of outbox) originate(msg, to)
  }

  const apply = (outcome: Outcome) => {
    setState(outcome.state)
    flush(outcome.outbox)
  }

  // Maintain state.peers to mirror actual mesh membership. Deterministic leader
  // succession depends on every survivor computing over the SAME peer set, so the
  // peer set must reflect who is really connected — not just who has sent a message.
  const addPeer = (id: PeerId) => {
    if (state.peers.has(id)) return
    const peers = new Map<PeerId, PeerInfo>(state.peers)
    peers.set(id, { id, lastSeen: Date.now() })
    setState({ ...state, peers })
  }
  const removePeer = (id: PeerId) => {
    if (!state.peers.has(id)) return
    const peers = new Map<PeerId, PeerInfo>(state.peers)
    peers.delete(id)
    setState({ ...state, peers })
  }

  // ── Incoming messages (gossip receive + relay) ─────────────────────────
  action.onMessage = (data, context) => {
    const env = data as unknown as Gossip
    if (!env || typeof env.gid !== 'string') return
    if (!markSeen(env.gid)) return // already saw this → drop (de-dup breaks loops)

    const forMe = env.to === 'all' || env.to === selfId
    if (forMe) {
      // Logical sender is the ORIGIN (relays preserve it), not the neighbour that
      // forwarded it. Note: with multi-hop relay we can no longer transport-
      // authenticate the origin end-to-end — see the security note in FEASIBILITY.md.
      // Acceptable for a co-located, room-code-gated, encrypted group.
      apply(receive(state, { ...env.msg, from: env.origin }))
    }

    // Relay onward across the mesh, unless it was addressed solely to us. Exclude the
    // neighbour we got it from to cut redundant traffic (others de-dup regardless).
    if (env.to !== selfId && env.ttl > 1) {
      fanout({ ...env, ttl: env.ttl - 1 }, context.peerId)
    }
  }

  // ── Peer lifecycle ─────────────────────────────────────────────────────
  room.onPeerJoin = (peerId) => {
    addPeer(peerId)
    // A joining follower pulls the current snapshot so late joiners land on the
    // leader's CURRENT artwork/audio (not the start). Retry while still blind.
    if (state.role === 'follower' && state.snapshot.epoch < 0) {
      apply(requestInitialSnapshot(state))
    }
  }

  room.onPeerLeave = (peerId) => {
    // A dropped DIRECT link does NOT mean the peer is gone — with the gossip relay it
    // may still be reachable through other peers. In particular, losing our direct link
    // to the LEADER must not trigger an immediate takeover (that caused a follower on a
    // flaky/just-woken connection to seize leadership while the real leader was alive).
    // We DON'T remove the leader here; its liveness is governed purely by whether
    // heartbeats (direct OR relayed) keep arriving, and takeover only happens via the
    // quorum-guarded stale check below. Non-leader peers are dropped for tidiness
    // (they also age out via pruning).
    if (peerId !== state.snapshot.leaderId) removePeer(peerId)
  }

  // How many OTHER peers (not us, not the current leader) have we heard from recently?
  // Used as a takeover quorum: a follower that has lost the leader but has no other live
  // witness is almost certainly the one that dropped — it must NOT promote itself.
  const otherLivePeers = (now: number): number => {
    let n = 0
    for (const p of state.peers.values()) {
      if (p.id === state.selfId || p.id === state.snapshot.leaderId) continue
      if (now - p.lastSeen <= STALE_TIMEOUT_MS) n++
    }
    return n
  }

  // Age out peers we've stopped hearing from (directly or via relayed heartbeats),
  // so departed peers don't linger in everyone's set and skew succession.
  const pruneStalePeers = (now: number) => {
    let changed = false
    const peers = new Map<PeerId, PeerInfo>(state.peers)
    for (const [id, info] of peers) {
      if (id === state.selfId) continue
      if (now - info.lastSeen > PEER_PRUNE_MS) {
        peers.delete(id)
        changed = true
      }
    }
    if (changed) setState({ ...state, peers })
  }

  // ── Timers: heartbeats (all peers, flooded) + follower staleness watch ──
  const timer = setInterval(() => {
    const now = Date.now()
    pruneStalePeers(now)

    if (state.role === 'leader') {
      apply(leaderHeartbeat(state, now)) // flooded across the mesh via originate()
      return
    }

    // Followers also emit a flooded presence heartbeat. This carries no authority
    // (the model records liveness but ignores it for state), but it lets every peer
    // learn about every other peer THROUGH the relay — so peer sets converge even on
    // a partial mesh, keeping deterministic leader succession correct.
    originate({ type: 'heartbeat', from: state.selfId, epoch: state.snapshot.epoch, ts: now }, 'all')

    const s = state.snapshot
    const hasEstablishedLeader =
      s.epoch >= 0 && s.leaderId !== '' && s.leaderId !== state.selfId

    if (!hasEstablishedLeader) {
      // We have NOT synced to a leader yet — we just joined, or the leader is
      // still being discovered over the (public, ~multi-second) matchmaking relay.
      // CRITICAL: do NOT run leader-loss/succession here. isLeaderStale() reports
      // "stale" for an unknown leader, which would make a blind follower promote
      // ITSELF and cause split-brain (two peers both claiming leadership). Instead
      // keep pulling the current snapshot until the real leader answers.
      apply(requestInitialSnapshot(state, now))
      return
    }

    if (isLeaderStale(state, STALE_TIMEOUT_MS, now)) {
      if (otherLivePeers(now) >= 1) {
        // Corroborated: the leader is silent AND we can still see other peers. Treat it
        // as a genuine leader loss and run deterministic succession (once per leader).
        if (staleReportedFor !== s.leaderId) {
          staleReportedFor = s.leaderId
          apply(onLeaderLost(state, now))
        }
      } else {
        // ISOLATED: leader silent and NO other witness. This is almost always OUR
        // connection dropping (e.g. phone just woke), not the leader dying — so do NOT
        // seize leadership (that's the "follower hijacks a live leader" bug). Keep
        // pulling the snapshot; when connectivity returns we re-sync to the real leader.
        apply(requestInitialSnapshot(state, now))
      }
    } else {
      staleReportedFor = null // leader is alive (heard directly or via relay) → re-arm
    }
  }, HEARTBEAT_MS) as unknown as number

  return {
    roomCode,
    selfId,
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    setView(view) {
      apply(leaderSetView(state, view))
    },
    setAudio(audio) {
      apply(leaderSetAudio(state, audio))
    },
    detach() {
      apply(detach(state))
    },
    resync() {
      apply(resync(state))
    },
    recover() {
      // After a suspend (screen slept / tab backgrounded) our view of the mesh may
      // be stale and the datachannels may have just re-established. Broadcast a
      // snapshot request — whoever is CURRENTLY leader answers, so we re-adopt the
      // live state regardless of our role. If leadership migrated while we were out,
      // the reply carries a higher epoch and the model steps us down automatically.
      apply(requestInitialSnapshot(state))
    },
    async leave() {
      clearInterval(timer)
      listeners.clear()
      await room.leave()
    },
  }
}
