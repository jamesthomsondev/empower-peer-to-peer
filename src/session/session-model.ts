/**
 * Shared-gallery session — state & message model (design sketch)
 * ----------------------------------------------------------------
 * Scope: the leader-broadcasts / followers-mirror experience for a group of
 * 4–6 co-located people. Ephemeral. Content (artwork info + audio) is local to
 * each device via the PWA cache, so the wire only ever carries tiny CONTROL
 * messages, never media.
 *
 * Three ideas do most of the work here:
 *   1. `epoch` — a term counter that bumps on every leadership change. It is the
 *      guard against a "deposed" or crashed-then-returned leader injecting stale
 *      state, and against two peers both promoting themselves at once.
 *   2. `SessionSnapshot` — the single authoritative picture. Late-join, reconnect,
 *      and resync are all just "adopt the current snapshot," so they share one path.
 *   3. Deterministic succession — every surviving peer computes the SAME next
 *      leader from the SAME peer set, so nobody has to volunteer or hold an election.
 *
 * The transport is assumed to be a mesh (e.g. a Trystero room where everyone is
 * connected to everyone). We impose STAR *semantics* on top: only the current
 * leader's events are authoritative. Mesh-underneath is what makes migration cheap
 * — the successor is already connected to everyone.
 */

// ─────────────────────────── Identity & roles ───────────────────────────

export type PeerId = string;            // assigned by the mesh layer on join
export type Role = 'leader' | 'follower';
export type FollowMode = 'following' | 'detached'; // only meaningful while a follower

// ──────────────────────── Authoritative shared state ────────────────────

export type AudioStatus = 'playing' | 'paused' | 'stopped';

export interface AudioState {
  trackId: string | null; // key into the device-local (PWA-cached) audio assets
  status: AudioStatus;
  positionSec: number;    // playback offset captured at `updatedAt`
  updatedAt: number;      // LEADER's epoch-ms when this state was set
}

export type Screen = 'home' | 'artwork';

export interface ViewState {
  screen: Screen;
  artworkId: string | null; // set when screen === 'artwork'
}

/**
 * The complete authoritative picture. The leader owns it; everyone else mirrors it.
 * Anyone who needs to "catch up" — a late joiner, a reconnect, a resyncing follower —
 * simply adopts this wholesale.
 */
export interface SessionSnapshot {
  epoch: number;    // bumps on every leadership change
  leaderId: PeerId; // whose events are authoritative this epoch
  view: ViewState;
  audio: AudioState;
}

// ───────────────────────────── Wire protocol ────────────────────────────

interface BaseMsg {
  from: PeerId;
  epoch: number; // sender's view of the current epoch (receivers reject stale ones)
  ts: number;    // sender epoch-ms — drives audio-position math + peer liveness
}

/** Leader → peer(s): full state. The landing point for join / reconnect / resync / migration. */
export interface SnapshotMsg extends BaseMsg { type: 'snapshot'; snapshot: SessionSnapshot; }
/** Any peer → leader: "send me current state." Answered regardless of epoch. */
export interface RequestSnapshotMsg extends BaseMsg { type: 'requestSnapshot'; }
/** Leader → all: screen changed (opened an artwork / went home). */
export interface SetViewMsg extends BaseMsg { type: 'setView'; view: ViewState; }
/** Leader → all: audio changed. play/pause/seek/stop are all just a new AudioState. */
export interface SetAudioMsg extends BaseMsg { type: 'setAudio'; audio: AudioState; }
/** Leader → all: liveness ping so followers can detect a silent (crashed) leader. */
export interface HeartbeatMsg extends BaseMsg { type: 'heartbeat'; }

export type Message =
  | SnapshotMsg
  | RequestSnapshotMsg
  | SetViewMsg
  | SetAudioMsg
  | HeartbeatMsg;

// Note: there is deliberately no `leaderChanged` message. A migration announces
// itself: the new leader broadcasts a SnapshotMsg carrying the bumped epoch and its
// own id as leaderId. That is self-describing, so it can't disagree with itself.

// ───────────────────────── Local (per-device) state ─────────────────────

export interface PeerInfo {
  id: PeerId;
  lastSeen: number; // epoch-ms of last message/heartbeat from this peer
}

export interface ClientState {
  selfId: PeerId;
  role: Role;
  followMode: FollowMode;
  snapshot: SessionSnapshot;    // best-known authoritative state
  peers: Map<PeerId, PeerInfo>; // everyone in the room, including self
}

// ───────────────────────────── Constructors ─────────────────────────────

export function createSession(selfId: PeerId, now = Date.now()): ClientState {
  // The founder starts as leader at epoch 0.
  return {
    selfId,
    role: 'leader',
    followMode: 'following', // a leader "follows itself"
    snapshot: {
      epoch: 0,
      leaderId: selfId,
      view: { screen: 'home', artworkId: null },
      audio: { trackId: null, status: 'stopped', positionSec: 0, updatedAt: now },
    },
    peers: new Map([[selfId, { id: selfId, lastSeen: now }]]),
  };
}

export function joinSession(selfId: PeerId, now = Date.now()): ClientState {
  // A follower starts blind (epoch -1) and pulls the real state via requestInitialSnapshot().
  return {
    selfId,
    role: 'follower',
    followMode: 'following',
    snapshot: {
      epoch: -1, // below any real epoch → the leader's reply is always adopted
      leaderId: '',
      view: { screen: 'home', artworkId: null },
      audio: { trackId: null, status: 'stopped', positionSec: 0, updatedAt: 0 },
    },
    peers: new Map([[selfId, { id: selfId, lastSeen: now }]]),
  };
}

// ─────────────────────────── Outgoing effects ───────────────────────────

export interface Outcome {
  state: ClientState;
  outbox: Array<{ to: PeerId | 'all'; msg: Message }>;
}

const none = (state: ClientState): Outcome => ({ state, outbox: [] });

function mkSnapshot(state: ClientState, now: number): SnapshotMsg {
  return { type: 'snapshot', from: state.selfId, epoch: state.snapshot.epoch, ts: now, snapshot: state.snapshot };
}

// ────────────────────────── Receiving messages ──────────────────────────

/** Pure reducer: fold an incoming message into state and emit any replies. */
export function receive(state: ClientState, msg: Message, now = Date.now()): Outcome {
  const outbox: Outcome['outbox'] = [];

  // Record liveness for every message we see (this is also how heartbeats "count").
  const peers = new Map(state.peers);
  peers.set(msg.from, { id: msg.from, lastSeen: now });
  let next: ClientState = { ...state, peers };

  // A snapshot request is a QUERY, not a state claim — answer it regardless of epoch.
  // (Late joiners legitimately have a stale/unknown epoch; that's the whole point.)
  if (msg.type === 'requestSnapshot') {
    if (next.role === 'leader') outbox.push({ to: msg.from, msg: mkSnapshot(next, now) });
    return { state: next, outbox };
  }

  // Reject state-bearing messages from a stale/deposed epoch.
  if (msg.epoch < next.snapshot.epoch) return { state: next, outbox };

  // A higher epoch = a leadership change we haven't adopted yet. Trust the new leader.
  if (msg.epoch > next.snapshot.epoch) {
    next = {
      ...next,
      role: msg.from === next.selfId ? 'leader' : 'follower',
      snapshot: { ...next.snapshot, epoch: msg.epoch, leaderId: msg.from },
    };
  }

  switch (msg.type) {
    case 'snapshot': {
      const incoming = msg.snapshot;
      // Same-epoch tiebreak: if two peers both claim leadership at this epoch
      // (a contested migration), the lower id wins. Prevents split-brain.
      if (incoming.epoch === next.snapshot.epoch && next.snapshot.leaderId &&
          incoming.leaderId > next.snapshot.leaderId) {
        break; // keep our current (lower-id) leader
      }
      next = { ...next, snapshot: incoming };
      if (next.role === 'follower') next = { ...next, followMode: 'following' };
      // If I thought I was leader but a lower id won the tie, step down.
      if (next.role === 'leader' && incoming.leaderId !== next.selfId) {
        next = { ...next, role: 'follower' };
      }
      break;
    }

    case 'setView':
      if (obeysLeader(next, msg)) next = { ...next, snapshot: { ...next.snapshot, view: msg.view } };
      break;

    case 'setAudio':
      if (obeysLeader(next, msg)) next = { ...next, snapshot: { ...next.snapshot, audio: msg.audio } };
      break;

    case 'heartbeat':
      break; // liveness already recorded above
  }

  return { state: next, outbox };
}

/** Leader events apply only to a follower who is actively following the current leader. */
function obeysLeader(state: ClientState, msg: BaseMsg): boolean {
  return state.role === 'follower' &&
         state.followMode === 'following' &&
         msg.from === state.snapshot.leaderId;
}

// ─────────────────────────── Leader actions ─────────────────────────────

export function leaderSetView(state: ClientState, view: ViewState, now = Date.now()): Outcome {
  if (state.role !== 'leader') return none(state);
  const next = { ...state, snapshot: { ...state.snapshot, view } };
  return { state: next, outbox: [{ to: 'all', msg: { type: 'setView', from: state.selfId, epoch: state.snapshot.epoch, ts: now, view } }] };
}

export function leaderSetAudio(state: ClientState, audio: AudioState, now = Date.now()): Outcome {
  if (state.role !== 'leader') return none(state);
  const stamped: AudioState = { ...audio, updatedAt: now }; // stamp with leader's clock
  const next = { ...state, snapshot: { ...state.snapshot, audio: stamped } };
  return { state: next, outbox: [{ to: 'all', msg: { type: 'setAudio', from: state.selfId, epoch: state.snapshot.epoch, ts: now, audio: stamped } }] };
}

/** Leader calls this on an interval (~2s) so followers can detect a crash. */
export function leaderHeartbeat(state: ClientState, now = Date.now()): Outcome {
  if (state.role !== 'leader') return none(state);
  return { state, outbox: [{ to: 'all', msg: { type: 'heartbeat', from: state.selfId, epoch: state.snapshot.epoch, ts: now } }] };
}

// ────────────────────────── Follower actions ────────────────────────────

/** Detach to explore alone. Leader events are still received but no longer applied. */
export function detach(state: ClientState): Outcome {
  if (state.role !== 'follower') return none(state);
  return { state: { ...state, followMode: 'detached' }, outbox: [] };
}

/** Resync: ask the leader for current state; receive() flips us back to 'following' when it lands. */
export function resync(state: ClientState, now = Date.now()): Outcome {
  if (state.role !== 'follower') return none(state);
  const req: RequestSnapshotMsg = { type: 'requestSnapshot', from: state.selfId, epoch: state.snapshot.epoch, ts: now };
  return { state, outbox: [{ to: state.snapshot.leaderId, msg: req }] };
}

/** Emit right after joinSession() to pull the current state (leaderId unknown yet → broadcast). */
export function requestInitialSnapshot(state: ClientState, now = Date.now()): Outcome {
  const req: RequestSnapshotMsg = { type: 'requestSnapshot', from: state.selfId, epoch: state.snapshot.epoch, ts: now };
  return { state, outbox: [{ to: 'all', msg: req }] };
}

// ─────────────────────── Leader loss & migration ────────────────────────

/**
 * Deterministic successor: lowest peer id among everyone EXCEPT the departed leader.
 * Every survivor computes the identical result over the identical set, so there is no
 * volunteering and no election chatter. (Swap in a pre-agreed join-order rank if you'd
 * rather succession follow who joined first.)
 */
export function pickSuccessor(peers: Map<PeerId, PeerInfo>, departedLeader: PeerId): PeerId | null {
  const candidates = [...peers.keys()].filter(id => id !== departedLeader).sort();
  return candidates[0] ?? null;
}

/** True when a follower's leader has gone silent past the timeout (crash, not clean leave). */
export function isLeaderStale(state: ClientState, timeoutMs = 6000, now = Date.now()): boolean {
  if (state.role !== 'follower') return false;
  const leader = state.peers.get(state.snapshot.leaderId);
  return !leader || (now - leader.lastSeen) > timeoutMs;
}

/** Call on onPeerLeave(leaderId) OR when isLeaderStale() first returns true. */
export function onLeaderLost(state: ClientState, now = Date.now()): Outcome {
  const peers = new Map(state.peers);
  peers.delete(state.snapshot.leaderId);

  const successor = pickSuccessor(peers, state.snapshot.leaderId);
  if (!successor) return { state: { ...state, peers }, outbox: [] }; // nobody left; session is over

  const newEpoch = state.snapshot.epoch + 1;

  if (successor === state.selfId) {
    // I'm promoted. Keep MY current view/audio and become the source of truth.
    // (For an ephemeral session we continue from the successor's own view rather
    //  than trying to perfectly inherit the dead leader's last frame — nobody notices.)
    const snapshot: SessionSnapshot = { ...state.snapshot, epoch: newEpoch, leaderId: state.selfId };
    const next: ClientState = { ...state, role: 'leader', followMode: 'following', snapshot, peers };
    return { state: next, outbox: [{ to: 'all', msg: mkSnapshot(next, now) }] };
  }

  // Someone else takes over. Point at them; their snapshot (carrying newEpoch) will arrive.
  // Detached followers stay detached — leadership changing shouldn't yank them back.
  const next: ClientState = { ...state, peers, snapshot: { ...state.snapshot, leaderId: successor } };
  return { state: next, outbox: [] };
}

// ───────────────────────── Audio-position helper ────────────────────────

/**
 * Where local playback should actually be right now. Uses the leader's `updatedAt`;
 * because sync only needs to be "roughly together" (everyone's on headphones), we
 * ignore cross-device clock skew — a few hundred ms is inaudible.
 */
export function currentAudioPosition(audio: AudioState, now = Date.now()): number {
  if (audio.status !== 'playing') return audio.positionSec;
  return audio.positionSec + Math.max(0, (now - audio.updatedAt) / 1000);
}
