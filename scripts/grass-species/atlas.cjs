// Procedural grayscale+alpha texture atlas shared by every grass species.
//
// Albedo stays grayscale because the instance colour tints it in the shader;
// that is what lets one atlas serve lawn grass, coarse grass and weeds with
// different palettes. Transparent pixels keep a mid gray so mipmaps do not
// darken leaf edges.
//
// Layout (512 x 256, glTF UV origin at the top-left, leaf tips point up):
//   blades     x 0..127,   y 0..255  eight 16 px columns, tip at the top
//   broadleaf  x 128..255, y 0..127  plantain/dandelion leaf, base at the bottom
//   clover     x 128..191, y 128..191 heart-shaped leaflet with a pale chevron
//   tuft       x 256..511, y 0..255  fan of blades from one root (lawn cards)

const SIZE = 256 // atlas height; blade columns span it
const WIDTH = 512
const BLADE_COLUMNS = 8
const BLADE_COLUMN_WIDTH = 16
const FILL_GRAY = 0.78

const clamp01 = value => Math.min(1, Math.max(0, value))
const smoothstep = (edge0, edge1, value) => {
  const t = clamp01((value - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

function createRandom(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Coverage from a signed distance in pixels (positive inside), one pixel of anti-aliasing.
const coverage = insidePixels => smoothstep(-0.75, 0.75, insidePixels)

function paintBlades(put, random) {
  for (let column = 0; column < BLADE_COLUMNS; column++) {
    const brightness = 0.8 + random() * 0.2
    const centre = column * BLADE_COLUMN_WIDTH + BLADE_COLUMN_WIDTH / 2
    const bend = (random() - 0.5) * 3
    for (let y = 0; y < SIZE; y++) {
      const t = 1 - y / (SIZE - 1) // 0 at the base, 1 at the tip
      const halfWidth = 6.2 * Math.pow(1 - t, 0.55) + 0.4
      const axis = centre + bend * t * t
      for (let x = column * BLADE_COLUMN_WIDTH + 1; x < (column + 1) * BLADE_COLUMN_WIDTH - 1; x++) {
        const distance = Math.abs(x + 0.5 - axis)
        const alpha = coverage(halfWidth - distance)
        if (alpha <= 0) continue
        const midrib = 0.07 * Math.exp(-Math.pow(distance / 1.1, 2))
        const edge = 0.1 * smoothstep(halfWidth * 0.45, halfWidth, distance)
        const gray = brightness * (0.84 + 0.16 * t) + midrib - edge + (random() - 0.5) * 0.04
        put(x, y, gray, alpha)
      }
    }
  }
}

function paintBroadleaf(put, random) {
  const left = 128, top = 0, size = 128
  for (let y = top; y < top + size; y++) {
    const t = 1 - (y - top) / (size - 1) // 0 base (petiole), 1 tip
    for (let x = left; x < left + size; x++) {
      const u = ((x + 0.5 - left) / size) * 2 - 1
      // Oblanceolate (widest past the middle), as in plantain and dandelion rosettes.
      const blade = t < 0.12 ? 0.06 : 0.56 * Math.pow(Math.sin(Math.PI * Math.pow((t - 0.12) / 0.88, 1.35)), 0.8)
      // Shallow teeth along the margin read as a dandelion/plantain edge.
      const teeth = 1 - 0.07 * Math.max(0, Math.sin(t * 46))
      const halfWidth = Math.max(0.05, blade * teeth)
      const alpha = coverage((halfWidth - Math.abs(u)) * size / 2)
      if (alpha <= 0) continue
      const midrib = 0.13 * Math.exp(-Math.pow(u / 0.045, 2))
      const veinPhase = t * 11 - Math.abs(u) * 2.6
      const veins = 0.05 * smoothstep(0.82, 1, Math.cos(veinPhase * Math.PI * 2))
      const margin = 0.1 * smoothstep(0.55, 1, Math.abs(u) / halfWidth)
      const gray = 0.8 + midrib + veins - margin + (random() - 0.5) * 0.04
      put(x, y, gray, alpha)
    }
  }
}

function paintClover(put, random) {
  const left = 128, top = 128, size = 64
  for (let y = top; y < top + size; y++) {
    const w = 1 - (y - top) / (size - 1) // 0 at the attachment, 1 at the outer edge
    for (let x = left; x < left + size; x++) {
      const u = ((x + 0.5 - left) / size) * 2 - 1
      // Two overlapping lobes give the heart outline with a notch at the outer edge.
      const lobe = Math.max(0.47 - Math.hypot(u + 0.34, w - 0.58), 0.47 - Math.hypot(u - 0.34, w - 0.58))
      const wedge = 0.12 + w * 1.15 - Math.abs(u)
      const inside = Math.min(lobe, wedge)
      const alpha = coverage(inside * size / 2)
      if (alpha <= 0) continue
      const chevron = 0.16 * Math.exp(-Math.pow((w - (0.42 + 0.45 * Math.abs(u))) / 0.06, 2))
      const midrib = 0.06 * Math.exp(-Math.pow(u / 0.05, 2))
      const gray = 0.76 + chevron + midrib + (random() - 0.5) * 0.04
      put(x, y, gray, alpha)
    }
  }
}

// Nine to eleven blades fanning from the bottom centre. One small card of this
// reads as a dense tuft from the side and as scattered blades from above.
function paintTuft(put, random) {
  const left = 256, size = 256
  const rootX = left + size / 2, rootY = size - 2
  const count = 11
  for (let blade = 0; blade < count; blade++) {
    const spread = ((blade + 0.5) / count - 0.5) * 1.25 + (random() - 0.5) * 0.18
    const length = (0.55 + random() * 0.43) * (size - 6)
    const curl = (random() - 0.5) * 0.5
    const baseHalfWidth = 4.5 + random() * 2.5
    const brightness = 0.76 + random() * 0.24
    const steps = Math.ceil(length)
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const angle = spread + curl * t * t
      const cx = rootX + Math.sin(angle) * length * t
      const cy = rootY - Math.cos(angle) * length * t
      const halfWidth = baseHalfWidth * Math.pow(1 - t, 0.6) + 0.35
      for (let x = Math.floor(cx - halfWidth - 1); x <= Math.ceil(cx + halfWidth + 1); x++) {
        if (x < left || x >= left + size) continue
        const y = Math.round(cy)
        if (y < 0 || y >= size) continue
        const distance = Math.abs(x + 0.5 - cx)
        const alpha = coverage(halfWidth - distance)
        if (alpha <= 0) continue
        const midrib = 0.06 * Math.exp(-Math.pow(distance / 1.1, 2))
        const gray = brightness * (0.82 + 0.18 * t) + midrib + (random() - 0.5) * 0.04
        put(x, y, gray, alpha)
      }
    }
  }
}

/** @returns {{width: number, height: number, pixels: Uint8Array}} gray+alpha pixels */
function createGrassAtlas(seed = 20261111) {
  const pixels = new Uint8Array(WIDTH * SIZE * 2)
  for (let i = 0; i < WIDTH * SIZE; i++) pixels[i * 2] = Math.round(FILL_GRAY * 255)
  const put = (x, y, gray, alpha) => {
    const index = (y * WIDTH + x) * 2
    // Overlapping blades in the tuft keep the most opaque coverage.
    if (pixels[index + 1] > Math.round(clamp01(alpha) * 255)) return
    pixels[index] = Math.round(clamp01(gray) * 255)
    pixels[index + 1] = Math.round(clamp01(alpha) * 255)
  }
  const random = createRandom(seed)
  paintBlades(put, random)
  paintBroadleaf(put, random)
  paintClover(put, random)
  paintTuft(put, random)
  return { width: WIDTH, height: SIZE, pixels }
}

// UV rectangles: [uLeft, vTop, uRight, vBottom]; vTop is the leaf tip / outer edge.
const pixelRect = (x0, y0, x1, y1) => [x0 / WIDTH, y0 / SIZE, x1 / WIDTH, y1 / SIZE]
const ATLAS_REGIONS = Object.freeze({
  blades: Array.from({ length: BLADE_COLUMNS }, (_, column) =>
    pixelRect(column * BLADE_COLUMN_WIDTH + 1, 0, (column + 1) * BLADE_COLUMN_WIDTH - 1, SIZE)),
  broadleaf: pixelRect(128, 0, 256, 128),
  clover: pixelRect(128, 128, 192, 192),
  tuft: pixelRect(256, 0, 512, 256),
})

module.exports = { createGrassAtlas, createRandom, ATLAS_REGIONS }
