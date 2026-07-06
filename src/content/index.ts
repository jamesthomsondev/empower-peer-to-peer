/** Local gallery content — a bundled JSON manifest + ES-module audio URLs. */
import manifest from './content.json'
import { AUDIO_URLS } from './audio'

export interface Artwork {
  id: string
  title: string
  blurb: string
  trackId: string
}

export const ARTWORKS: Artwork[] = manifest.artworks

export function artworkById(id: string | null): Artwork | undefined {
  return id ? ARTWORKS.find((a) => a.id === id) : undefined
}

/** Resolve a control-message trackId to this device's local (cached) audio URL. */
export function audioUrl(trackId: string | null): string | null {
  return trackId ? AUDIO_URLS[trackId] ?? null : null
}
