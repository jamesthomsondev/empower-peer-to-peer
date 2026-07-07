/** Bundled artwork images, imported as ES-module URLs → fingerprinted + precached offline. */
import loom from './images/img-loom.jpg'
import tide from './images/img-tide.jpg'
import ember from './images/img-ember.jpg'
import motion from './images/img-motion.jpg'

export const IMAGES: Record<string, string> = {
  'img-loom': loom,
  'img-tide': tide,
  'img-ember': ember,
  'img-motion': motion,
}
