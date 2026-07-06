/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_TRYSTERO_STRATEGY?: string
  readonly VITE_NOSTR_RELAYS?: string
  readonly VITE_TURN_URL?: string
  readonly VITE_TURN_USERNAME?: string
  readonly VITE_TURN_CREDENTIAL?: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}
