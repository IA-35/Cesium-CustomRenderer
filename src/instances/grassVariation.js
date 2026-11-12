// Deterministic per-instance grass variation (colour, height, width).
//
// Why: the lightweight grass asset is a grayscale card tinted by one instance
// colour. Giving every clump the same tint and nearly the same height makes a
// lawn read as a repeated sticker. Real lawns vary at two scales — metre-sized
// patches (moisture, shade, mowing) and clump-to-clump jitter — so colour and
// height are driven by low-frequency value noise plus a small per-instance hash.
//
// Everything is a pure function of the local ENU position, the instance index
// and the seed, so the same polygons always produce the same lawn.

function hash2(x, y, seed) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

const smooth = t => t * t * (3 - 2 * t)
const clamp01 = value => Math.min(1, Math.max(0, value))
const smoothstep = (edge0, edge1, value) => smooth(clamp01((value - edge0) / (edge1 - edge0)))
const lerp = (a, b, t) => a + (b - a) * t
const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]

export function valueNoise(x, y, seed) {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const tx = smooth(x - xi)
  const ty = smooth(y - yi)
  const top = lerp(hash2(xi, yi, seed), hash2(xi + 1, yi, seed), tx)
  const bottom = lerp(hash2(xi, yi + 1, seed), hash2(xi + 1, yi + 1, seed), tx)
  return lerp(top, bottom, ty)
}

// Two octaves are enough to break up grid-aligned value-noise cells.
export function fbm(x, y, seed) {
  return valueNoise(x, y, seed) * 0.65 + valueNoise(x * 2.7 + 17.1, y * 2.7 - 9.3, seed + 101) * 0.35
}

// Linear-space tints for the grayscale grass card. Green stays the dominant
// channel in every entry so the lawn never turns grey or brown overall.
export const DEFAULT_GRASS_PALETTE = Object.freeze({
  lush: Object.freeze([0.12, 0.25, 0.05]),
  base: Object.freeze([0.19, 0.33, 0.08]),
  fresh: Object.freeze([0.26, 0.40, 0.10]),
  dry: Object.freeze([0.33, 0.35, 0.12]),
})

export const DEFAULT_GRASS_VARIATION = Object.freeze({
  colorVariation: 1,
  dryness: 0.35,
  colorPatchSize: 7,
  brightnessJitter: 0.12,
  heightVariation: 0.45,
  heightPatchSize: 4,
  widthJitter: 0.15,
})

export function resolveGrassVariation(options = {}) {
  const pick = (key, min, max) => {
    const value = options[key]
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : DEFAULT_GRASS_VARIATION[key]
  }
  return {
    colorVariation: pick('colorVariation', 0, 1),
    dryness: pick('dryness', 0, 1),
    colorPatchSize: pick('colorPatchSize', 0.5, 200),
    brightnessJitter: pick('brightnessJitter', 0, 0.5),
    heightVariation: pick('heightVariation', 0, 0.9),
    heightPatchSize: pick('heightPatchSize', 0.5, 200),
    widthJitter: pick('widthJitter', 0, 0.5),
    palette: { ...DEFAULT_GRASS_PALETTE, ...(options.palette || {}) },
  }
}

/**
 * @param {number} x Local ENU east, metres.
 * @param {number} y Local ENU north, metres.
 * @param {number} index Stable instance index.
 * @param {number} seed Lawn seed.
 * @param {object} settings Result of resolveGrassVariation.
 * @returns {{color: number[], heightScale: number, widthScale: number}}
 */
export function grassVariationAt(x, y, index, seed, settings) {
  const { palette } = settings
  // Patch colour: lush (shade/moist) -> base -> fresh (sunlit tips).
  const patch = fbm(x / settings.colorPatchSize, y / settings.colorPatchSize, seed)
  let color = patch < 0.5
    ? lerp3(palette.lush, palette.base, smoothstep(0.15, 0.5, patch))
    : lerp3(palette.base, palette.fresh, smoothstep(0.5, 0.85, patch))
  // Sparse dry patches on a larger scale, so they appear as worn areas rather than noise.
  const dryNoise = fbm(x / (settings.colorPatchSize * 1.9) + 31.7, y / (settings.colorPatchSize * 1.9) - 12.4, seed + 7)
  color = lerp3(color, palette.dry, smoothstep(0.6, 0.85, dryNoise) * settings.dryness)

  const jitter = hash2(index, 0x51, seed)
  const brightness = 1 + (jitter - 0.5) * 2 * settings.brightnessJitter
  const varied = color.map(channel => channel * brightness)
  const finalColor = lerp3(palette.base, varied, settings.colorVariation)

  // Taller clumps in lush patches, shorter in worn ones, plus per-clump jitter.
  const heightNoise = fbm(x / settings.heightPatchSize + 5.3, y / settings.heightPatchSize - 2.1, seed + 13)
  const heightScale = Math.min(1.8, Math.max(0.4,
    1 + (heightNoise - 0.5) * 1.4 * settings.heightVariation
      + (hash2(index, 0x93, seed) - 0.5) * 0.6 * settings.heightVariation
      + (patch - 0.5) * 0.2 * settings.heightVariation))
  const widthScale = 1 + (hash2(index, 0x2f, seed) - 0.5) * 2 * settings.widthJitter

  return { color: finalColor, heightScale, widthScale }
}
