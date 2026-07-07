/** Local gallery content — a bundled JSON manifest + ES-module media/image URLs. */
import manifest from './content.json'
import { MEDIA, type MediaKind } from './media'
import { IMAGES } from './images'

export interface Artwork {
  id: string
  title: string
  blurb: string
  image?: string // key into device-local images
  trackId: string // key into device-local timed media (audio OR video)
}

export const ARTWORKS: Artwork[] = manifest.artworks

export function artworkById(id: string | null): Artwork | undefined {
  return id ? ARTWORKS.find((a) => a.id === id) : undefined
}

/** Resolve a control-message trackId to this device's local (cached) media URL. */
export function mediaUrl(trackId: string | null): string | null {
  return trackId ? (MEDIA[trackId]?.url ?? null) : null
}

/** Is this track audio or video? Decides which element the device drives. */
export function mediaKind(trackId: string | null): MediaKind | null {
  return trackId ? (MEDIA[trackId]?.kind ?? null) : null
}

/** Resolve an artwork image key to its local (cached) URL. */
export function imageUrl(imageKey: string | undefined): string | null {
  return imageKey ? (IMAGES[imageKey] ?? null) : null
}
