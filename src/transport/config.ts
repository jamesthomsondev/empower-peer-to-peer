/**
 * Transport configuration — the "swap seam" for the feasibility spike.
 *
 * Trystero matchmaking strategy is chosen here. We deliberately default to a
 * strategy that signals over PUBLIC INTERNET infrastructure (Nostr relays), NOT
 * same-LAN discovery, because museum guest WiFi commonly enables client (AP)
 * isolation which blocks device-to-device LAN traffic. See the brief's constraints.
 *
 * Swap the strategy with VITE_TRYSTERO_STRATEGY=nostr|mqtt|torrent (build/dev env),
 * or just change STRATEGY below. All three matchmake over public infra.
 */

export type Strategy = 'nostr' | 'mqtt' | 'torrent'

export const STRATEGY: Strategy =
  (import.meta.env.VITE_TRYSTERO_STRATEGY as Strategy) || 'nostr'

/** Namespaces the room so we don't collide with other Trystero apps on shared relays. */
export const APP_ID = 'empower-p2p-spike-v1'

/**
 * ICE servers. Public STUN by default. TURN is a config seam only — payloads are
 * tiny control messages, so relaying (if a direct path fails) is negligible and
 * still end-to-end encrypted. Provide VITE_TURN_URL/USERNAME/CREDENTIAL to enable.
 */
function buildIceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [
    {
      urls: [
        'stun:stun.l.google.com:19302',
        'stun:stun1.l.google.com:19302',
      ],
    },
  ]
  const turnUrl = import.meta.env.VITE_TURN_URL
  if (turnUrl) {
    servers.push({
      urls: turnUrl,
      username: import.meta.env.VITE_TURN_USERNAME,
      credential: import.meta.env.VITE_TURN_CREDENTIAL,
    })
  }
  return servers
}

export const RTC_CONFIG: RTCConfiguration = { iceServers: buildIceServers() }

/**
 * Optional Nostr relay override (for STRATEGY==='nostr'), comma-separated in
 * VITE_NOSTR_RELAYS. Leave UNSET to use Trystero's built-in relay list — that's the
 * right default: Trystero deterministically shuffles its curated default relays by a
 * seed derived from `appId` and takes the same first N, so every peer with the same
 * appId lands on the SAME relays (guaranteed discovery overlap). Its defaults are also
 * chosen to be Trystero-friendly (permissive, no write-gating / rate-limiting).
 *
 * Do NOT pin "popular" relays here casually — many (e.g. relay.damus.io, offchain.pub)
 * rate-limit or web-of-trust-gate Trystero's announces and will BREAK discovery. Use
 * this only if you have specific relays known to work with Trystero.
 */
export const RELAY_URLS: string[] = (import.meta.env.VITE_NOSTR_RELAYS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

/** Dynamically load the selected strategy module. Keeps swapping to one line/env var. */
export async function loadStrategy(): Promise<{
  joinRoom: typeof import('trystero/nostr').joinRoom
  selfId: string
}> {
  // NOTE: in trystero 0.25 the `trystero/mqtt` and `trystero/torrent` subpaths are
  // deprecated stubs; the real strategies ship as standalone @trystero-p2p/* packages.
  // nostr is bundled with `trystero` itself, so we use it via `trystero/nostr`.
  switch (STRATEGY) {
    case 'mqtt': {
      const m = await import('@trystero-p2p/mqtt')
      return { joinRoom: m.joinRoom, selfId: m.selfId }
    }
    case 'torrent': {
      const m = await import('@trystero-p2p/torrent')
      return { joinRoom: m.joinRoom, selfId: m.selfId }
    }
    case 'nostr':
    default: {
      const m = await import('trystero/nostr')
      return { joinRoom: m.joinRoom, selfId: m.selfId }
    }
  }
}
