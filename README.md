# Empower — Peer-to-Peer Shared Gallery (feasibility spike)

A browser PWA where **4–6 co-located people share a gallery experience over WebRTC**:
one "leader" drives what everyone sees and hears; followers mirror. Content (artwork
info + audio) is **device-local** (PWA-cached), so the wire only ever carries tiny
control messages — never media. Leadership migrates automatically if the leader leaves.

This is a **tech spike**, not a design exercise. The UI is deliberately skeletal; the
prominent **debug panel** is the point — it shows what the mesh is doing.

> Built to mirror the local-data/PWA conventions of the reference app `apsys-eileen-web`.
> See [`NOTES-reference.md`](NOTES-reference.md) for the reference study and every
> deliberate deviation.

## Stack

- **Vite 7** + **React 18** + **TypeScript** (strict)
- **`vite-plugin-pwa`** (`injectManifest`, hand-written service worker) — offline caching
- **`trystero`** — serverless WebRTC matchmaking (no signaling server we run)
- **Yarn 4** (Corepack), **Node 24.13.0**

## Run it

```bash
# Node 24 (matches .nvmrc); Corepack provides Yarn 4
nvm use            # or: nvm install 24.13.0
corepack enable

yarn install
yarn dev           # → http://localhost:3000  (this is the dev-server command)
```

Other scripts:

| Command | What it does |
|---|---|
| `yarn dev` / `yarn start` | Vite dev server on :3000 (no service worker — see offline note) |
| `yarn build` | Type-check + production build to `dist/` (generates the service worker) |
| `yarn preview` | Serve the production build on :4173 (service worker active) |
| `yarn sim` | Headless multi-peer model simulation (see "Verification") |

## Trystero strategy (which is configured)

Configured strategy: **`nostr`** (default). Matchmaking/signaling goes over **public
Nostr relays** — i.e. the public internet, **not** same-LAN discovery. This is
deliberate: museum guest WiFi often enables client (AP) isolation that blocks
device-to-device LAN traffic, so peers must connect via public infrastructure.

Swap it (all matchmake over public infra) in one place:

```bash
VITE_TRYSTERO_STRATEGY=mqtt yarn dev      # or: torrent, nostr
```

or edit `STRATEGY` in [`src/transport/config.ts`](src/transport/config.ts). Public
STUN is configured; **TURN is a config seam** — set `VITE_TURN_URL` /
`VITE_TURN_USERNAME` / `VITE_TURN_CREDENTIAL` to enable relaying (tiny control
payloads make relay cost negligible, and traffic stays end-to-end encrypted).

**Nostr relays:** leave them at Trystero's defaults. Trystero deterministically picks
the same relay subset for everyone with the same `appId`, so discovery overlaps by
design. Discovery takes a few seconds over public relays — this is normal. You *can*
override with `VITE_NOSTR_RELAYS="wss://a,wss://b"`, but don't casually pin "popular"
relays: many (e.g. `relay.damus.io`, `offchain.pub`) rate-limit or web-of-trust-gate
Trystero's announces and will silently break discovery.

### Connection & leadership behavior
- A joining follower shows **"… Connecting"** until it receives the leader's snapshot.
  It will **not** promote itself while unsynced — so you never get two "leaders" just
  because discovery is slow. (This was a real bug: a blind follower used to self-promote
  after 2s; now it waits and keeps requesting the snapshot. Regression-tested in
  `yarn sim` scenario [8].)
- If two devices sit on "Connecting"/`peers (1)` forever, they genuinely aren't reaching
  each other (relay/NAT) — that's a connectivity issue, not leadership. Try same WiFi
  first, then configure TURN.

### Gossip relay (partial-mesh tolerance)
On real networks the WebRTC mesh is often only *partially* connected — some phone pairs
can't traverse NAT (e.g. a phone that connects to everyone *except* the leader). To
handle this, control messages are **flooded hop-by-hop across the mesh** and
de-duplicated by id (`Gossip` envelope in
[`src/transport/session-controller.ts`](src/transport/session-controller.ts)), and
presence heartbeats are relayed too. A follower therefore only needs a path to **any**
connected peer — not a direct link to the leader — to follow along and to participate in
leader migration. Verified in `yarn sim` scenario [9]. (Trade-off: multi-hop relay means
the original sender isn't transport-authenticated end-to-end; fine for a code-gated,
encrypted, co-located group — see FEASIBILITY.md §5.6.) Devices that can't reach *anyone*
directly still need TURN.

### Leader takeover is quorum-guarded (no hijack by a flaky follower)
A follower can't tell "the leader crashed" from "I lost my own connection to the leader."
So takeover is **guarded**: a follower only promotes/migrates when the leader is silent
**and it can still see at least one other peer** (a corroborating witness). An *isolated*
follower (e.g. a phone whose Wi-Fi just woke and briefly dropped) does **not** seize
leadership — it stays a follower and re-syncs when its connection returns. This prevents
the failure where a follower on a flaky link takes over from a leader that never actually
went away. Also, a dropped direct link to the leader no longer triggers instant migration:
liveness is judged purely by whether heartbeats keep arriving (directly **or** relayed),
so migration only happens on genuine, ~6s-confirmed silence. Verified in `yarn sim`
scenarios [5], [7], [9] (real migrations) and [10] (isolated follower must not hijack).

Trade-offs: in a **2-device** session, if the leader leaves, the lone survivor won't
promote itself (there's no one to lead) — it waits/reconnects. And a mesh that splits into
two multi-peer islands can still briefly form two leaders until they rejoin (classic
partition; the epoch rule reconciles on reunion). Full majority-quorum would tighten this
further; the ≥1-witness rule already fixes the common single-device case.

### Keeping the session alive (screen sleep / backgrounding)
When a phone's screen sleeps or the tab is backgrounded, the browser suspends the page:
the leader's heartbeat stops, WebRTC tears down, and followers migrate away — the churn
you notice on wake. Two mitigations are built in:

- **Screen Wake Lock** (`Keep screen awake`, on by default) — holds a
  [`navigator.wakeLock('screen')`](https://developer.mozilla.org/docs/Web/API/Screen_Wake_Lock_API)
  while the app is visible so the screen won't sleep. The browser releases it when the
  tab is hidden, so it's **automatically re-acquired** on return to visibility. Status is
  shown in the bar (🟢 active / 🟡 idle). Most important on the **leader's** device.
- **Resync on wake** — whenever the app becomes visible again it calls `recover()`, which
  re-pulls the current snapshot from whoever is leader now. So if a device did drop, or
  leadership migrated while it was out, it heals to the live state instead of limping.

Wake Lock keeps the screen on only while the app is **foreground**; it can't prevent a
manual lock or an OS app-switch. For a guided in-gallery experience that's the right
scope — keep the app open on the leader's device. (If brief tab-switches still cause
unwanted migrations, raise `STALE_TIMEOUT_MS` in `src/transport/session-controller.ts`;
it trades faster crash-detection for more tolerance of blips.)

## How to test with two clients

### Quick (one machine, two tabs)
1. `yarn dev`, open http://localhost:3000, click **Start session (become leader)**.
2. Copy the 4-char room code (or scan the QR), open a second tab, **Join** with it.
3. The leader's debug panel should show 2 peers. Open an artwork / play audio as
   leader → the follower mirrors. Toggle **detach** / **resync**. Close the leader
   tab → the follower is promoted (epoch bumps).

### Real two-device / not-same-LAN (the acceptance target)
WebRTC + iOS + service worker want HTTPS, and one-phone-on-cellular proves it's not
relying on the LAN. Easiest is a quick public tunnel to the dev server:

```bash
yarn dev
# in another terminal (any HTTPS tunnel works; cloudflared shown):
cloudflared tunnel --url http://localhost:3000
```

Open the `https://…trycloudflare.com` URL on both phones (put one on cellular, one on
WiFi). `allowedHosts` already permits `*.trycloudflare.com`. Each device taps **Join /
Start** once — that tap unlocks audio (required by the iOS autoplay gate).

### Offline test (criterion 7)
The service worker is **production-only** (mirrors the reference). To exercise offline:

```bash
yarn build && yarn preview          # open the :4173 URL once (SW installs + precaches)
```
Then, in DevTools → Network, set **Offline** (or turn off WiFi) and reload: artwork
content and audio still load and play. Only a *new peer joining* needs the network.

## Verification status

Run `yarn sim` — a headless simulation drives the real `session-model` reducers through
the **same event mapping the transport uses** (peer-join → request snapshot, receive
with authenticated-sender overwrite, heartbeat, stale-timeout, leader-loss), over an
in-memory full mesh. All checks pass, covering:

| # | Acceptance criterion | Where verified |
|---|---|---|
| 1 | 2+ clients connect as peers | `yarn sim` (mesh) + browser smoke test |
| 2 | Leader opens artwork → followers switch | `yarn sim` |
| 3 | Leader plays → followers play **local** audio | `yarn sim` (state) + manual (audio) |
| 4 | Detach stops mirroring; resync jumps to current | `yarn sim` |
| 5 | Late joiner lands on **current** state | `yarn sim` |
| 6 | Kill leader → deterministic promotion, epoch bump, no split-brain | `yarn sim` (clean-leave **and** stale-timeout paths) |
| 7 | Offline content + audio after first load | build precache manifest (16 entries incl. all audio) + manual DevTools-offline |

Additionally, criteria **1, 2 and 6 were confirmed live over real WebRTC** in-browser
(two independent app instances discovered each other over Nostr, follower mirrored the
leader's artwork, and killing the leader promoted the survivor to `epoch 1` — one leader
only). The **audio** half of criterion 3 (actual sound after the iOS unlock) is the main
item still needing the two-device manual pass, since it needs a real speaker/gesture.

## Architecture (where things live)

```
src/
  session/session-model.ts        # PROVIDED authoritative state machine (pure reducers). Not modified.
  transport/
    config.ts                     # strategy swap seam + ICE/STUN + TURN seam
    session-controller.ts         # Trystero ⇄ model glue: maps room events → reducers, flushes outbox
  audio/audio-player.ts           # device-local playback + iOS autoplay-gate unlock
  content/
    content.json                  # bundled artwork manifest (title/blurb/trackId)
    audio/*.mp3                    # bundled audio, imported as ES-module URLs → precached
    index.ts, audio.ts            # content accessors
  hooks/useSession.ts             # React binding: lifecycle, audio driving, detached browsing
  ui/App.tsx, DebugPanel.tsx, QRCode.tsx
  service-worker/sw.ts            # injectManifest SW: precache + SPA fallback + audio cache
  service-worker-registration.ts  # prod-only manual registration
test/model-sim.ts                 # the `yarn sim` harness
```

**Key contract:** the controller only (a) persists the model's returned `state` and
(b) flushes its `outbox`; it invents no session logic. On receipt, the payload's `from`
is **overwritten with the transport's authenticated sender id** so peers can't spoof
identity. Mesh underneath (everyone connected to everyone); star *semantics* on top
(only the current leader's events are authoritative) — this is what makes migration cheap.

## Constraints handled (from the brief)

- **iOS autoplay gate** — a network `play` isn't a user gesture; the one-time Join/Start
  tap unlocks the audio element + resumes an AudioContext for the session.
- **Guest-WiFi AP isolation** — Nostr (public relays), not LAN discovery; strategy is swappable.
- **TURN** — public STUN included; TURN left as an env-configured seam.
- **Mesh under, star over** — Trystero connects everyone; the model enforces leader authority.

## Out of scope (per brief)

Visual design, any persistence (sessions are ephemeral), groups larger than ~6,
accounts/auth, cross-session history. None turned out to be load-bearing for feasibility.
