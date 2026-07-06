# Feasibility Summary — Peer-to-Peer Shared Gallery

A plain-English writeup of what this spike proves, how the technology works, and the
trade-offs and limits of the approach. For run/test instructions see [`README.md`](README.md);
for the reference-app study see [`NOTES-reference.md`](NOTES-reference.md).

---

## 1. What we set out to prove

Can a group of 4–6 co-located people share one guided gallery experience — a "leader"
drives what everyone sees and hears — using **only the phones in the room**, no
app-store install, no backend we run, and with the artwork/audio working offline?

Short answer: **the mechanics work and are demonstrated; the open risk is reliable
device-to-device connectivity for groups larger than two on real venue networks.** That
risk is addressable, but it's the thing to resolve before committing.

---

## 2. How it works

Four independent layers, each doing one job.

### a) Transport — serverless WebRTC via Trystero
Phones talk **directly to each other** over **WebRTC data channels** (the same
peer-to-peer tech behind video calls). To find each other and set up those direct
connections, WebRTC needs a "matchmaking"/signaling step. Normally you run a signaling
server for this; instead we use **Trystero**, which piggybacks signaling on **public
infrastructure** (we use public **Nostr** relays). So:

- **No signaling server of our own.** Peers exchange the initial "how do I reach you"
  handshake through public relays, then drop to a **direct encrypted connection**.
- The relays are used **only for the few-hundred-byte handshake**, never for ongoing
  traffic. Once connected, data flows phone-to-phone.
- Everyone in a room forms a **mesh** (everyone tries to connect to everyone).
- **Gossip relay (added after the 4-phone finding).** On real venue networks the mesh is
  often only *partially* connected — some phone pairs can't traverse NAT. So every
  message is wrapped in an envelope with a unique id and **flooded hop-by-hop**: each
  phone forwards messages to its neighbours and de-duplicates by id. A follower therefore
  only needs a path to **any** connected peer, not a direct link to the leader — messages
  (and the leader's snapshot) reach it by relay through intermediaries. Presence
  heartbeats are flooded too, so every phone learns the full group even without direct
  links, which keeps leader-succession deterministic on a partial mesh.

### b) State — a leader/follower state machine with automatic succession
On top of the mesh we impose **"star semantics"**: at any moment exactly one peer is the
**leader**, and only its events count. The shared picture is a single `SessionSnapshot`
(current artwork + audio state) guarded by an **`epoch`** (a term counter that bumps on
every leadership change).

- **Late join / reconnect / resync are one code path:** "adopt the current snapshot."
- **Leader leaves or crashes → automatic, deterministic promotion.** Every surviving
  phone independently computes the *same* successor (lowest peer id), so there's no
  election chatter and no two-leaders outcome. The `epoch` bump makes the handover
  unambiguous and stops a returning old leader from clobbering state.

### c) Content — bundled and device-local, never sent over the wire
The artwork text and audio clips are **baked into the app** and cached on each device.
The leader broadcasts **only tiny control messages** — "show artwork 2", "play track B
from 12.4s" — and each phone plays **its own local copy**. Audio is positioned from the
leader's timestamp so everyone is roughly in sync (fine on headphones; not sample-exact).

**Consequence:** bandwidth is negligible (control only), and content keeps working with
no network.

### d) Offline & app-like — PWA
Packaged as a Progressive Web App with a service worker that **precaches the app shell +
all content + all audio on first load**. After opening it once, the app and its media load
and play with **zero connectivity**; it installs to the home screen and runs full-screen
like a native app.

### What actually needs the network (important nuance)
"Offline" and "the live session" are two different things — don't conflate them:

- **App + content (fully offline):** loading the app and *playing audio* need no network at
  all. The media is device-local and is **never sent between devices** — only tiny control
  messages ("play track B at 12.4s") cross the wire, and each phone plays its own copy.
- **Joining a session (needs the public internet):** WebRTC's *signaling/matchmaking* — two
  devices finding each other and exchanging connection-setup info — goes over public Nostr
  relays. This is the **only** time an external server is involved. Once connected, the relay
  is out of the loop for good.
- **Staying in sync (needs a path between devices, not necessarily the internet):** after
  joining, control messages flow **directly peer-to-peer** over the established WebRTC data
  channel. If the phones share a WiFi that allows device-to-device traffic, that path is
  **local** (no internet). If they're on different networks — or the WiFi blocks peer traffic
  (guest-WiFi AP isolation) — the path is routed over the internet, possibly via TURN.

So: a **fully offline** device (airplane mode) can still open the app and play audio manually,
but it drops out of the *live* leader-driven sync because it has no path to receive control
messages. The win for a venue is that the bandwidth-heavy part (audio) is fully local, and the
live coordination is just a few hundred bytes of control state over a direct link — **no media
server and no signaling server running during the experience.**

### e) Resilience
- **Screen Wake Lock** keeps the (leader's) screen from sleeping while the app is open —
  a sleeping screen is the main cause of dropouts.
- **Resync-on-wake** re-pulls the live state whenever the app returns to the foreground.
- **Heartbeats** (every 2s) let followers notice a silent leader and migrate within ~6s.
- **Quorum-guarded takeover.** A follower can't distinguish "leader crashed" from "I lost
  my link to the leader", so it only takes over when the leader is silent **and** it can
  still see another peer (a witness). An isolated follower (e.g. a phone whose Wi-Fi just
  woke) stays a follower and re-syncs instead of hijacking a leader that never left.

---

## 3. Pros

- **No backend to build, run, scale, or pay for.** No signaling server, no media server,
  no accounts. This is the headline advantage — operationally almost free.
- **Truly offline content.** Artwork and audio load and play with no connectivity after
  first open; ideal for spotty museum WiFi / basement galleries.
- **Tiny bandwidth & cost.** Only control messages cross the network; audio is local.
- **End-to-end encrypted.** WebRTC data channels are DTLS-encrypted; we additionally key
  an app-level password to the room code.
- **Cheap, robust leader migration.** Because everyone is already interconnected, a
  leader change is instant and needs no re-negotiation — the session survives the leader
  leaving.
- **Cross-platform, zero-install.** One URL / QR code; runs on iOS, Android, and desktop
  browsers; installable as a PWA.
- **Fast to build on a standard web stack** (Vite + React + TypeScript), matching the
  team's existing PWA conventions.

---

## 4. Cons

- **Mesh connectivity is probabilistic and per-pair.** Every pair of phones must
  independently succeed at NAT traversal. Some pairs connect, some don't, depending on
  each end's network — so connectivity is not all-or-nothing (see Limitations).
- **Number of connections grows with the square of the group.** N phones = N×(N−1)/2
  links to establish and maintain; more phones = more chances one link fails, and more
  battery/CPU per device.
- **Dependence on third-party public relays for matchmaking.** They have no SLA, vary in
  uptime, and some rate-limit or gate writes. If the ones a session picks are down,
  peers can't find each other (join fails; existing connections are unaffected).
- **Join latency.** Discovering peers over public relays takes a few seconds — noticeably
  slower than a dedicated signaling server.
- **Hostile mobile lifecycle.** Phone screen sleep / app backgrounding suspends the page
  and tears down connections; iOS blocks audio until a user tap. We mitigate (wake lock,
  unlock tap, resync-on-wake) but can't fully eliminate this without a native app.
- **Approximate audio sync.** Clock-based; good enough for "everyone roughly together on
  headphones," not for shared-speaker sample-accurate sync.
- **Distributed debugging is hard.** Failures are per-device and network-dependent; the
  in-app debug panel exists precisely because you can't reason about this from one screen.

---

## 5. Limitations (the hard edges)

These are the boundaries to design around, not bugs.

1. **Partial mesh — the original key risk, now mitigated by gossip relay.** In the first
   4-device test, two phones saw every peer *except the leader* — the classic WebRTC-mesh
   failure where some pairs can't traverse NAT and there was no fallback. This is now
   addressed: messages are **flooded/relayed across the mesh** (see §2a), so a follower
   that can reach *any* connected peer follows the leader through intermediaries. **Residual
   limit:** a phone that can't connect *directly to anyone* (fully isolated), or a group
   that fragments into two islands with no bridging peer, still can't be reached — that's
   where TURN (item 1 in Recommendations) closes the gap. So gossip handles "can reach
   someone but not the leader"; TURN handles "can't reach anyone directly."

2. **Symmetric NAT / strict firewalls need TURN.** When two endpoints both sit behind
   symmetric NAT (common on cellular and some corporate/guest WiFi), a *direct* WebRTC
   link is impossible; traffic must be relayed through a **TURN** server. We include
   public STUN and left TURN as a config seam, but **no TURN is stood up** — so those
   pairs currently fail. TURN is the standard, well-understood fix.

3. **Guest-WiFi AP isolation is only half-solved.** Using public relays for *signaling*
   sidesteps the "devices can't discover each other on the LAN" problem, but if the
   network also blocks the peer-to-peer *data path*, you're back to needing TURN (ideally
   TURN over TCP/443, which most captive networks allow).

4. **Group size ceiling.** The O(N²) mesh and per-pair connectivity make ~6–8 a practical
   ceiling; reliability degrades as the group grows.

5. **Network required to join.** Only *content playback* is offline. Forming or joining a
   session needs connectivity for the handshake.

6. **Minimal security model.** Anyone with the room code can join; there's no moderation,
   identity, or abuse protection beyond the code + encryption. Fine for a co-located
   guided group, not for open/public rooms. **Note on the gossip relay:** with multi-hop
   forwarding we can no longer *transport-authenticate the original sender end-to-end* — a
   relaying peer could in principle rewrite the claimed origin. This is acceptable here
   because the room is code-gated and encrypted (only invited devices are in the mesh at
   all); a production version with untrusted relays would add per-message signatures.

7. **Ephemeral only.** No persistence, history, or reconnect-to-same-session across app
   restarts (by design for the spike).

---

## 6. What's been verified vs. still open

| Area | Status |
|---|---|
| State-machine logic (mirror, late-join, detach/resync, deterministic migration, no split-brain) | ✅ Verified headless (`yarn sim`) |
| Two devices: connect, mirror artwork, migrate leader on drop | ✅ Verified live over real WebRTC |
| Offline: content + audio after first load | ✅ Verified (precache manifest) |
| Screen-sleep resilience (wake lock + resync) | ✅ Implemented & behaves per spec |
| Partial mesh — follower with no direct link to leader still syncs/mirrors/migrates | ✅ Verified via gossip relay (`yarn sim` scenario [9]) |
| Flaky follower must NOT hijack a live leader; real 3-peer migration still works | ✅ Verified (`yarn sim` [10] + live 3-device kill-the-leader test) |
| **3–6 devices connecting reliably on real venue WiFi/cellular** | ⚠️ Improved by gossip; **fully-isolated devices still need TURN** — re-test on-site |
| Audio actually audible after iOS unlock, two-device | ⚠️ Needs on-device manual pass |

---

## 7. Recommendations to make it dependable

In priority order:

1. **Stand up a TURN server.** Now the biggest remaining reliability win — it rescues the
   NAT/firewall cases the gossip relay *can't* (a device that connects directly to no one,
   or a mesh split into two islands with no bridging peer). Use `coturn` self-hosted, or a
   managed provider (Cloudflare, Twilio, Metered). Payloads are tiny, so relay cost is
   negligible and traffic stays encrypted.

2. ~~**Relay leader events through the mesh (gossip).**~~ **✅ Implemented.** Messages are now
   flooded hop-by-hop with de-duplication, and presence heartbeats are relayed so peer
   sets converge. A follower follows the leader as long as it has a path to any connected
   peer. Verified in `yarn sim` scenario [9] (a follower with no direct link to the leader
   syncs, mirrors, and migrates correctly). A production hardening would add per-message
   signatures (see Limitations §6).

3. **Reduce reliance on flaky public relays.** Optionally run your own signaling relay
   (self-hosted Nostr relay or a Trystero MQTT broker) for faster, more reliable joins in
   the venue — still far lighter than a full media backend.

4. **Consider a "designated relay" hybrid if pure P2P proves too flaky in situ.** One
   device (or a tiny always-on box in the gallery) acts as a guaranteed hub. Trades some
   serverless purity for reliability; keep P2P as the optimization.

5. **Test the real NAT matrix in the venue.** Connectivity is entirely dependent on the
   actual guest-WiFi/cellular NAT behaviour — validate on-site, on the real network, at
   the real group size, before committing.

---

## 8. Verdict

The concept is **technically feasible and demonstrated** end-to-end for the happy path,
on a cheap, serverless, offline-capable stack. The economics (no backend) and the offline
story are genuinely attractive.

The **deciding factor is multi-device connectivity robustness** on real venue networks.
The 4-phone test exposed a partial-mesh failure; the **gossip relay now added** removes
the "can reach someone but not the leader" class of failure (verified in simulation).
The remaining gap — devices that can't connect directly to *anyone* — is closed by
standing up **TURN** (item 1). Neither is a dead end; both are well-understood.
Recommend: add TURN, then re-run the on-site multi-device test (item 5). With those, this
is a viable, low-cost approach for small co-located groups.
