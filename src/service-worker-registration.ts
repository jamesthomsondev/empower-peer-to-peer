/**
 * Manual SW registration (prod only), mirroring the reference which registers the
 * service worker itself rather than letting the plugin auto-inject it.
 * Uses vite-plugin-pwa's virtual module, honouring registerType: 'autoUpdate'.
 */
import { registerSW } from 'virtual:pwa-register'

export function registerServiceWorker(): void {
  registerSW({ immediate: true })
}
