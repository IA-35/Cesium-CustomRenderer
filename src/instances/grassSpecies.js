// Species mix for lightweight grass: lawn grass, coarse tall grass and two weeds.
//
// Why: a campus lawn is never one plant. Weeds grow in clusters (where mowing,
// trampling or moisture favour them), so every non-lawn species is driven by its
// own low-frequency noise field instead of being sprinkled uniformly, which would
// read as noise rather than as plants.
import { GRASS_SPECIES_ASSET_URLS } from './grassSpeciesAssets.js'
import { DEFAULT_GRASS_PALETTE, fbm, resolveGrassVariation } from './grassVariation.js'

const freezePalette = palette => Object.freeze(Object.fromEntries(
  Object.entries(palette).map(([key, value]) => [key, Object.freeze(value)])))

// Linear-space tints; each keeps green dominant (the atlas is grayscale).
export const DEFAULT_GRASS_SPECIES = Object.freeze([
  Object.freeze({ id: 'lawn', weight: 0.72, clusterScale: 0, size: 1, dryness: 0.35, palette: DEFAULT_GRASS_PALETTE }),
  Object.freeze({ id: 'tall', weight: 0.1, clusterScale: 6, size: 1, dryness: 0.5, palette: freezePalette({
    lush: [0.10, 0.22, 0.07], base: [0.15, 0.29, 0.09], fresh: [0.21, 0.35, 0.11], dry: [0.32, 0.33, 0.13] }) }),
  Object.freeze({ id: 'broadleaf', weight: 0.09, clusterScale: 8, size: 1, dryness: 0.15, palette: freezePalette({
    lush: [0.11, 0.25, 0.04], base: [0.17, 0.32, 0.06], fresh: [0.24, 0.40, 0.07], dry: [0.28, 0.33, 0.10] }) }),
  Object.freeze({ id: 'clover', weight: 0.09, clusterScale: 5, size: 1, dryness: 0.1, palette: freezePalette({
    lush: [0.09, 0.24, 0.08], base: [0.13, 0.31, 0.10], fresh: [0.18, 0.38, 0.12], dry: [0.26, 0.33, 0.12] }) }),
])

function hash(index, salt, seed) {
  let h = Math.imul(index | 0, 0x9e3779b1) ^ Math.imul(salt | 0, 0x85ebca6b) ^ Math.imul(seed | 0, 0xc2b2ae35)
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d)
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

const smoothstep = (edge0, edge1, value) => {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/**
 * Merges caller overrides (matched by id) onto the default species and resolves
 * each species' variation settings once.
 * @param {object[]} [overrides] e.g. [{ id: 'clover', weight: 0 }, { id: 'lawn', size: 1.2 }]
 * @param {object} [variationOptions] Shared options for resolveGrassVariation.
 */
export function resolveGrassSpecies(overrides = [], variationOptions = {}) {
  const byId = new Map((Array.isArray(overrides) ? overrides : []).filter(item => item?.id).map(item => [item.id, item]))
  const species = DEFAULT_GRASS_SPECIES.map(base => {
    const merged = { ...base, ...(byId.get(base.id) || {}) }
    return {
      id: merged.id,
      assetId: `grass-${merged.id}`,
      url: merged.url || GRASS_SPECIES_ASSET_URLS[merged.id],
      weight: Number.isFinite(merged.weight) ? Math.max(0, merged.weight) : base.weight,
      clusterScale: Number.isFinite(merged.clusterScale) ? Math.max(0, merged.clusterScale) : base.clusterScale,
      size: Number.isFinite(merged.size) ? Math.max(0.05, merged.size) : base.size,
      variation: resolveGrassVariation({ ...variationOptions, dryness: merged.dryness, palette: merged.palette }),
    }
  }).filter(item => item.weight > 0 && item.url)
  if (!species.length) throw new Error('Grass species mix has no species with a positive weight')
  return species
}

/** Picks the species for one clump from clustered noise affinities and a stable hash. */
export function pickGrassSpecies(species, x, y, index, seed) {
  if (species.length === 1) return species[0]
  let total = 0
  const scores = species.map((item, order) => {
    const affinity = item.clusterScale > 0
      ? 0.15 + 2.2 * smoothstep(0.45, 0.8, fbm(x / item.clusterScale + order * 37.1, y / item.clusterScale - order * 11.3, seed + 97 * (order + 1)))
      : 1
    const score = item.weight * affinity
    total += score
    return score
  })
  let pick = hash(index, 0x5ec, seed) * total
  for (let i = 0; i < species.length; i++) {
    pick -= scores[i]
    if (pick < 0) return species[i]
  }
  return species[species.length - 1]
}
