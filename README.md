# Empower — Peer-to-Peer Shared Gallery (feasibility spike)

A browser PWA where **4–6 co-located people share a gallery experience over WebRTC**: one
"leader" drives what everyone sees/hears, followers mirror, and leadership migrates
automatically if the leader leaves. Content (artwork text, **images, audio, and video**) is
**device-local** (PWA-cached), so the wire only carries tiny control messages — never media.
Timed media (audio *or* video) is play/pause/seek-synced from the leader's clock; images
follow the mirrored view.

A **tech spike**: skeletal UI, prominent **debug panel**. For how it works and the
pros/cons/limits see **[FEASIBILITY.md](FEASIBILITY.md)**; for the reference-app study see
**[NOTES-reference.md](NOTES-reference.md)**.

**Stack:** Vite 7 · React 18 · TypeScript · `vite-plugin-pwa` (offline) · `trystero`
(serverless WebRTC) · Yarn 4 (Corepack) · Node 24.13.0.

## Run

```bash
nvm use          # Node 24.13.0 (see .nvmrc)
corepack enable  # provides Yarn 4
yarn install
yarn dev         # → http://localhost:3000
```

| Command | What it does |
|---|---|
| `yarn dev` | Dev server on :3000 (no service worker — see Offline below) |
| `yarn build` | Type-check + production build to `dist/` (builds the service worker) |
| `yarn preview` | Serve the production build on :4173 (service worker active) |
| `yarn sim` | Headless multi-peer simulation of the state machine (10 scenarios) |

## Test with two+ clients

- **Quick (one machine):** `yarn dev`, open the URL, **Start session**, copy the room code,
  open a second tab and **Join**. The debug panel shows both peers; opening an artwork / playing
  audio as leader mirrors to the follower; closing the leader tab promotes a survivor.
- **Two devices (not same-LAN):** expose the dev server over HTTPS via a tunnel, e.g.
  `cloudflared tunnel --url http://localhost:3000` (`*.trycloudflare.com` is already allowed),
  and open it on both phones (one on cellular proves it isn't LAN-only). Each device taps once
  to join — that tap unlocks audio (iOS autoplay gate).
- **Offline (app + content):** the service worker is production-only, so `yarn build && yarn preview`,
  open once, then go offline (DevTools → Network → Offline) and reload — the app, artwork, and audio
  load and play from cache. This proves the *content* needs no network (audio is device-local and
  never sent between devices). The *live session* is separate: joining uses the public internet once
  (WebRTC signaling), then control messages flow directly peer-to-peer — see
  [FEASIBILITY.md → "What actually needs the network"](FEASIBILITY.md).

## Configuration (Trystero)

- **Strategy:** `nostr` by default (matchmaking over public internet, not LAN — museum guest WiFi
  often blocks device-to-device LAN traffic). Swap with `VITE_TRYSTERO_STRATEGY=mqtt|torrent|nostr`
  or edit `STRATEGY` in [`src/transport/config.ts`](src/transport/config.ts).
- **STUN/TURN:** public STUN is on; TURN is a seam — set `VITE_TURN_URL` / `VITE_TURN_USERNAME` /
  `VITE_TURN_CREDENTIAL` to enable relaying when direct connections fail.
- **Relays:** leave at Trystero's defaults (peers with the same `appId` pick the same relays, so
  discovery overlaps by design; it takes a few seconds). `VITE_NOSTR_RELAYS` can override, but
  don't pin "popular" relays — many rate-limit / gate Trystero and break discovery.

## Robustness notes (detail in FEASIBILITY.md)

- **Connecting state:** a follower that hasn't received the leader's snapshot shows "… Connecting"
  and never self-promotes — no phantom leaders while discovery is slow.
- **Gossip relay:** control messages are flooded hop-by-hop and de-duplicated, so a follower only
  needs a path to *any* peer, not a direct link to the leader (handles a partial mesh).
- **Quorum-guarded takeover:** a follower only takes over when the leader is silent *and* it can
  see another peer — an isolated/flaky follower waits and re-syncs instead of hijacking a live
  leader.
- **Keep screen awake:** on by default (Screen Wake Lock) so the leader's screen doesn't sleep;
  re-syncs on wake. Foreground-only.

## Architecture

```
src/
  session/session-model.ts        # PROVIDED authoritative state machine (pure reducers). Unmodified.
  transport/
    config.ts                     # strategy swap seam + STUN/TURN + relay override
    session-controller.ts         # Trystero ⇄ model glue: gossip relay, heartbeats, migration
  media/media-controller.ts       # device-local audio+video playback + iOS autoplay-gate unlock
  content/                        # bundled, precached content:
    content.json, index.ts, media.ts, images.ts
    audio/*.mp3, video/*.mp4, images/*.jpg
  hooks/useSession.ts             # React binding: lifecycle, audio, wake lock, detached browsing
  ui/{App,DebugPanel,QRCode}.tsx
  service-worker/sw.ts            # injectManifest SW: precache + SPA fallback
test/model-sim.ts                 # the `yarn sim` harness
```

The controller invents no session logic: it persists the model's returned `state`, flushes its
`outbox`, and trusts the transport's authenticated sender id. Mesh underneath; star *semantics*
on top (only the current leader's events are authoritative).

## Out of scope

Visual design, persistence (sessions are ephemeral), groups larger than ~6, accounts/auth,
cross-session history.
```
