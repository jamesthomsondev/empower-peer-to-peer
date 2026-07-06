/**
 * Headless multi-peer simulation of the session model + the exact event mapping
 * used by src/transport/session-controller.ts, over an in-memory full-mesh "bus"
 * that mimics Trystero semantics (broadcast/targeted send, onPeerJoin fires both
 * ways across the mesh, onPeerLeave, authenticated sender id).
 *
 * Verifies acceptance criteria 2, 4, 5, 6 deterministically. Run with:
 *   node sim.ts
 */
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
  type PeerId,
  type PeerInfo,
} from '../src/session/session-model.ts'

let clock = 1000
const now = () => clock
const STALE = 6000
const PEER_PRUNE = 9000
const MAX_HOPS = 8

// Gossip envelope — mirrors session-controller.ts
interface Gossip {
  gid: string
  origin: PeerId
  to: PeerId | 'all'
  ttl: number
  msg: Message
}

// ── Peers gossip over a partial-mesh bus ────────────────────────────────────
class Peer {
  state: ClientState
  staleReportedFor: PeerId | null = null
  id: PeerId
  mesh: Mesh
  private seq = 0
  private seen = new Set<string>()
  constructor(id: PeerId, asLeader: boolean, mesh: Mesh) {
    this.id = id
    this.mesh = mesh
    this.state = asLeader ? createSession(id, now()) : joinSession(id, now())
  }
  private originate(msg: Message, to: PeerId | 'all') {
    const env: Gossip = { gid: `${this.id}#${this.seq++}`, origin: this.id, to, ttl: MAX_HOPS, msg }
    this.seen.add(env.gid)
    this.mesh.fanout(this.id, env)
  }
  private apply(o: Outcome) {
    this.state = o.state
    for (const { to, msg } of o.outbox) this.originate(msg, to)
  }
  private addPeer(pid: PeerId) {
    if (this.state.peers.has(pid)) return
    const peers = new Map<PeerId, PeerInfo>(this.state.peers)
    peers.set(pid, { id: pid, lastSeen: now() })
    this.state = { ...this.state, peers }
  }
  private removePeer(pid: PeerId) {
    if (!this.state.peers.has(pid)) return
    const peers = new Map<PeerId, PeerInfo>(this.state.peers)
    peers.delete(pid)
    this.state = { ...this.state, peers }
  }
  // Gossip receive from a direct neighbour: de-dup, deliver-if-for-me, relay onward.
  onMessage(fromNeighbour: PeerId, env: Gossip) {
    if (this.seen.has(env.gid)) return
    this.seen.add(env.gid)
    if (env.to === 'all' || env.to === this.id) {
      this.apply(receive(this.state, { ...env.msg, from: env.origin }, now()))
    }
    if (env.to !== this.id && env.ttl > 1) {
      this.mesh.fanout(this.id, { ...env, ttl: env.ttl - 1 }, fromNeighbour)
    }
  }
  onPeerJoin(pid: PeerId) {
    this.addPeer(pid)
    if (this.state.role === 'follower' && this.state.snapshot.epoch < 0) {
      this.apply(requestInitialSnapshot(this.state, now()))
    }
  }
  onPeerLeave(pid: PeerId) {
    // Dropped direct link ≠ peer gone (gossip may still relay it). Losing the leader
    // link does NOT trigger takeover here; the quorum-guarded stale check decides.
    if (pid !== this.state.snapshot.leaderId) this.removePeer(pid)
  }
  private otherLive(): number {
    let n = 0
    for (const p of this.state.peers.values()) {
      if (p.id === this.id || p.id === this.state.snapshot.leaderId) continue
      if (now() - p.lastSeen <= STALE) n++
    }
    return n
  }
  private prune() {
    let changed = false
    const peers = new Map<PeerId, PeerInfo>(this.state.peers)
    for (const [id, info] of peers) {
      if (id === this.id) continue
      if (now() - info.lastSeen > PEER_PRUNE) {
        peers.delete(id)
        changed = true
      }
    }
    if (changed) this.state = { ...this.state, peers }
  }
  tick() {
    this.prune()
    if (this.state.role === 'leader') {
      this.apply(leaderHeartbeat(this.state, now()))
      return
    }
    // follower — mirrors session-controller.ts: flooded presence heartbeat first
    this.originate(
      { type: 'heartbeat', from: this.id, epoch: this.state.snapshot.epoch, ts: now() },
      'all',
    )
    const s = this.state.snapshot
    const hasEstablishedLeader =
      s.epoch >= 0 && s.leaderId !== '' && s.leaderId !== this.state.selfId
    if (!hasEstablishedLeader) {
      this.apply(requestInitialSnapshot(this.state, now()))
      return
    }
    if (isLeaderStale(this.state, STALE, now())) {
      if (this.otherLive() >= 1) {
        if (this.staleReportedFor !== s.leaderId) {
          this.staleReportedFor = s.leaderId
          this.apply(onLeaderLost(this.state, now()))
        }
      } else {
        // Isolated: don't hijack a (possibly still-live) leader — try to recover.
        this.apply(requestInitialSnapshot(this.state, now()))
      }
    } else {
      this.staleReportedFor = null
    }
  }
  // leader/follower UI actions
  setView(v: Parameters<typeof leaderSetView>[1]) {
    this.apply(leaderSetView(this.state, v, now()))
  }
  setAudio(a: Parameters<typeof leaderSetAudio>[1]) {
    this.apply(leaderSetAudio(this.state, a, now()))
  }
  detach() {
    this.apply(detach(this.state))
  }
  resync() {
    this.apply(resync(this.state, now()))
  }
}

class Mesh {
  peers = new Map<PeerId, Peer>()
  present = new Set<PeerId>()
  links = new Map<PeerId, Set<PeerId>>() // adjacency — who is DIRECTLY connected to whom
  private link(a: PeerId, b: PeerId) {
    if (!this.links.has(a)) this.links.set(a, new Set())
    if (!this.links.has(b)) this.links.set(b, new Set())
    this.links.get(a)!.add(b)
    this.links.get(b)!.add(a)
  }
  /** Add a peer. connectTo defaults to a FULL mesh (all present peers). */
  add(id: PeerId, asLeader: boolean, connectTo?: PeerId[]): Peer {
    const p = new Peer(id, asLeader, this)
    this.peers.set(id, p)
    const neighbours = connectTo ?? [...this.present]
    this.present.add(id)
    this.links.set(id, this.links.get(id) ?? new Set())
    for (const other of neighbours) {
      if (!this.present.has(other)) continue
      this.link(id, other)
      // datachannel connected before onPeerJoin fires → snapshot reply is deliverable
      p.onPeerJoin(other)
      this.peers.get(other)!.onPeerJoin(id)
    }
    return p
  }
  kill(id: PeerId) {
    this.present.delete(id)
    // Only DIRECT neighbours observe a clean onPeerLeave; others detect via staleness.
    for (const other of this.links.get(id) ?? []) {
      if (this.present.has(other)) this.peers.get(other)!.onPeerLeave(id)
    }
    this.peers.delete(id)
  }
  /** Form a direct link between two already-present peers (simulates late discovery). */
  connect(a: PeerId, b: PeerId) {
    this.link(a, b)
    if (this.present.has(a) && this.present.has(b)) {
      this.peers.get(a)!.onPeerJoin(b)
      this.peers.get(b)!.onPeerJoin(a)
    }
  }
  /** Drop a direct link (both peers stay alive) — simulates a flaky/partitioned link. */
  disconnect(a: PeerId, b: PeerId) {
    this.links.get(a)?.delete(b)
    this.links.get(b)?.delete(a)
    if (this.present.has(a)) this.peers.get(a)!.onPeerLeave(b)
    if (this.present.has(b)) this.peers.get(b)!.onPeerLeave(a)
  }
  /** Deliver an envelope to the sender's DIRECT neighbours (minus `exclude`). */
  fanout(fromId: PeerId, env: Gossip, exclude?: PeerId) {
    if (!this.present.has(fromId)) return
    for (const n of this.links.get(fromId) ?? []) {
      if (n === exclude || !this.present.has(n)) continue
      this.peers.get(n)!.onMessage(fromId, env)
    }
  }
  tickAll() {
    for (const id of this.present) this.peers.get(id)!.tick()
  }
}

// ── Assertions ──────────────────────────────────────────────────────────────
let failures = 0
function assert(cond: boolean, label: string) {
  if (cond) console.log(`  ✓ ${label}`)
  else {
    console.error(`  ✗ FAIL: ${label}`)
    failures++
  }
}
const advance = (ms: number) => {
  clock += ms
}

// ── Scenario ─────────────────────────────────────────────────────────────────
const mesh = new Mesh()

console.log('\n[1] A starts as leader; B joins → mesh + mirror')
const A = mesh.add('A', true)
advance(100)
const B = mesh.add('B', false)
assert(B.state.role === 'follower', 'B is follower')
assert(B.state.snapshot.leaderId === 'A', 'B sees A as leader')
assert(B.state.snapshot.epoch === 0, 'B adopted epoch 0')
assert(A.state.peers.has('B') && B.state.peers.has('A'), 'A and B know each other (criterion 1)')

console.log('\n[2] Leader opens artwork + plays audio → B mirrors (criteria 2, 3)')
advance(100)
A.setView({ screen: 'artwork', artworkId: 'aw-tide' })
A.setAudio({ trackId: 'track-tide', status: 'playing', positionSec: 0, updatedAt: 0 })
assert(B.state.snapshot.view.artworkId === 'aw-tide', 'B mirrored view → aw-tide')
assert(
  B.state.snapshot.audio.trackId === 'track-tide' && B.state.snapshot.audio.status === 'playing',
  'B mirrored audio → playing track-tide',
)

console.log('\n[3] Late joiner C lands on CURRENT state, not the start (criterion 5)')
advance(2000)
const C = mesh.add('C', false)
assert(C.state.snapshot.view.artworkId === 'aw-tide', 'C landed on current artwork (not home)')
assert(C.state.snapshot.audio.status === 'playing', 'C landed on current audio (playing)')
assert(C.state.snapshot.epoch === 0, 'C adopted current epoch')

console.log('\n[4] B detaches → stops mirroring; resync → jumps to current (criterion 4)')
B.detach()
A.setView({ screen: 'artwork', artworkId: 'aw-ember' })
assert(B.state.snapshot.view.artworkId === 'aw-tide', 'detached B did NOT follow to aw-ember')
assert(C.state.snapshot.view.artworkId === 'aw-ember', 'following C DID follow to aw-ember')
B.resync()
assert(B.state.snapshot.view.artworkId === 'aw-ember', 'resynced B jumped to current (aw-ember)')
assert(B.state.followMode === 'following', 'B is following again after resync')

console.log('\n[5] Kill leader A → deterministic successor, epoch bumps, single leader (criterion 6)')
mesh.kill('A')
// Takeover is now via the quorum-guarded stale check (not instant on leave), so tick
// the survivors past the stale timeout. B and C witness each other → corroborated loss.
for (let i = 0; i < 4; i++) {
  advance(2000)
  mesh.tickAll()
}
const leadersNow = [...mesh.present].filter((id) => mesh.peers.get(id)!.state.role === 'leader')
assert(leadersNow.length === 1, `exactly one leader after migration (got ${leadersNow.length})`)
assert(leadersNow[0] === 'B', 'deterministic successor is B (lowest id)')
assert(B.state.snapshot.epoch === 1, 'new leader bumped epoch to 1')
assert(C.state.snapshot.leaderId === 'B', 'C follows new leader B')
assert(C.state.snapshot.epoch === 1, 'C adopted bumped epoch')

console.log('\n[6] New leader B drives; C still mirrors post-migration')
B.setView({ screen: 'home', artworkId: null })
assert(C.state.snapshot.view.screen === 'home', 'C mirrors new leader B after migration')

console.log('\n[7] Stale detection: silent leader promotes successor via heartbeat timeout')
const mesh2 = new Mesh()
const X = mesh2.add('X', true)
advance(100)
mesh2.add('Y', false)
mesh2.add('Z', false)
const Y = mesh2.peers.get('Y')!
const Z = mesh2.peers.get('Z')!
// X goes silent (never heartbeats, but is still "present" — a crash, not a clean leave).
// Only Y and Z tick. After the stale timeout they must promote deterministically.
for (let i = 0; i < 5; i++) {
  advance(2000)
  Y.tick()
  Z.tick()
}
const leaders2 = ['Y', 'Z'].filter((id) => mesh2.peers.get(id)!.state.role === 'leader')
assert(leaders2.length === 1, `stale timeout → exactly one leader (got ${leaders2.length})`)
assert(leaders2[0] === 'Y', 'stale successor is Y (lowest of survivors)')
assert(Y.state.snapshot.epoch === 1 && Z.state.snapshot.epoch === 1, 'epoch bumped on stale takeover')
assert(Z.state.snapshot.leaderId === 'Y', 'Z re-points to new leader Y')

console.log('\n[8] Blind follower (leader not yet discovered) must NOT self-promote (split-brain regression)')
// Slow matchmaking: a follower joins but the leader hasn't connected yet. It should
// stay a follower and keep requesting a snapshot — NEVER promote itself.
const mesh3 = new Mesh()
mesh3.add('L', true) // leader exists...
advance(100)
// ...but M is NOT connected to the mesh yet (relay still discovering peers). It is
// present but has no links, so it ticks in isolation — no peers, no snapshot.
const M = new Peer('M', false, mesh3)
mesh3.peers.set('M', M)
mesh3.present.add('M')
mesh3.links.set('M', new Set())
for (let i = 0; i < 6; i++) {
  advance(2000)
  M.tick()
}
assert(M.state.role === 'follower', 'blind M stayed follower (did NOT self-promote)')
assert(M.state.snapshot.epoch < 0, 'blind M did NOT bump its own epoch')
// Now discovery completes: M links to L → syncs to L, no split-brain.
mesh3.connect('L', 'M')
const leaders3 = [...mesh3.present].filter((id) => mesh3.peers.get(id)!.state.role === 'leader')
assert(leaders3.length === 1 && leaders3[0] === 'L', 'after discovery: exactly one leader (L), no split-brain')
assert(M.state.role === 'follower' && M.state.snapshot.leaderId === 'L', 'M synced to L as follower')
assert(M.state.snapshot.epoch === 0, 'M adopted L\'s epoch')

console.log('\n[9] PARTIAL MESH: a follower with NO direct link to the leader still works (gossip relay)')
// Topology:  P(leader) ── Q ── R ── S ,  plus P──R.  Crucially S links ONLY to R,
// so S can NOT reach the leader P directly — everything must relay through R.
const m4 = new Mesh()
const P = m4.add('P', true)
advance(50)
m4.add('Q', false, ['P']) // Q ↔ P
advance(50)
m4.add('R', false, ['P', 'Q']) // R ↔ P, Q
advance(50)
const S = m4.add('S', false, ['R']) // S ↔ R ONLY (no direct link to leader P)
const Q4 = m4.peers.get('Q')!
const R4 = m4.peers.get('R')!

assert(S.state.snapshot.leaderId === 'P', 'S synced to leader P via relay (no direct link to P)')
assert(S.state.snapshot.epoch === 0, 'S adopted epoch 0 via relay')
assert(S.state.peers.has('P'), 'S sees leader P as a peer (learned via relayed messages)')

advance(50)
P.setView({ screen: 'artwork', artworkId: 'aw-ember' })
assert(S.state.snapshot.view.artworkId === 'aw-ember', 'S mirrored the leader view via relay')

// Let flooded heartbeats converge everyone's peer sets, then kill the leader.
for (let i = 0; i < 2; i++) {
  advance(2000)
  m4.tickAll()
}
assert(S.state.peers.has('Q') && S.state.peers.has('R'), 'S learned all peers via relayed heartbeats')

m4.kill('P')
// S has no direct link to P, so it never gets onPeerLeave(P) — it must heal via the
// new leader's relayed snapshot and/or stale detection.
for (let i = 0; i < 4; i++) {
  advance(2000)
  m4.tickAll()
}
const leaders4 = ['Q', 'R', 'S'].filter((id) => m4.peers.get(id)!.state.role === 'leader')
assert(leaders4.length === 1, `partial-mesh migration → exactly one leader (got ${leaders4.length})`)
assert(leaders4[0] === 'Q', 'deterministic successor is Q (lowest survivor id)')
assert(S.state.snapshot.leaderId === 'Q', 'relay-only follower S re-homed to new leader Q')
assert(Q4.state.snapshot.epoch === 1 && S.state.snapshot.epoch === 1, 'epoch bumped everywhere')
// new leader drives; relay-only S still mirrors
Q4.setView({ screen: 'home', artworkId: null })
assert(S.state.snapshot.view.screen === 'home', 'S mirrors new leader Q via relay through R')
void R4

console.log('\n[10] Isolated follower must NOT hijack a live leader (flaky-reconnect regression)')
// The reported bug: leader stays up, but a follower briefly loses its link to it and
// seizes leadership (bumping epoch), then WINS on reconnect. Fix: an isolated follower
// (no other witness) must not take over.
const m5 = new Mesh()
const DA = m5.add('DA', true) // leader
advance(50)
const FB = m5.add('FB', false, ['DA']) // follower, only link is to the leader
assert(
  FB.state.snapshot.leaderId === 'DA' && FB.state.snapshot.epoch === 0,
  'FB synced to leader DA (epoch 0)',
)
// FB loses its only link — but DA is still alive. FB is now isolated.
m5.disconnect('DA', 'FB')
for (let i = 0; i < 6; i++) {
  advance(2000)
  FB.tick()
  DA.tick()
}
assert(FB.state.role === 'follower', 'isolated FB stayed a follower (did NOT hijack)')
assert(FB.state.snapshot.epoch === 0, 'isolated FB did NOT bump the epoch')
assert(
  DA.state.role === 'leader' && DA.state.snapshot.epoch === 0,
  'real leader DA kept leading at epoch 0 the whole time',
)
// Reconnect → FB re-syncs cleanly; no leadership change happened.
m5.connect('DA', 'FB')
advance(2000)
FB.tick()
DA.tick()
assert(
  FB.state.snapshot.leaderId === 'DA' && FB.state.snapshot.epoch === 0,
  'after reconnect FB is following DA again, still epoch 0 (leader never changed)',
)
assert(DA.state.role === 'leader', 'DA remained the leader throughout')

console.log(`\n${failures === 0 ? '✅ ALL PASSED' : `❌ ${failures} FAILURE(S)`}\n`)
process.exit(failures === 0 ? 0 : 1)
