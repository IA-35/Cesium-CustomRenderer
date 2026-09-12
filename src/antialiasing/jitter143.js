// Temporal anti-aliasing needs a different sub-pixel offset every frame so that
// consecutive frames sample different positions inside the same pixel; the history
// pass then averages them into edges that no single frame can resolve. Halton(2,3)
// is the standard low-discrepancy pair for this: it covers the pixel evenly without
// repeating until the cycle length is reached.

export const DEFAULT_JITTER_SAMPLES = 8

// Van der Corput radical inverse. Index 0 is defined as 0 so the sequence starts
// cleanly, and unusable input degrades to 0 instead of propagating NaN into the
// projection matrix.
export function halton(index, base) {
  if (!Number.isFinite(index) || !Number.isFinite(base) || index < 1 || base < 2) return 0
  let result = 0
  let fraction = 1 / base
  let value = Math.floor(index)
  while (value > 0) {
    result += (value % base) * fraction
    value = Math.floor(value / base)
    fraction /= base
  }
  return result
}

// Pixel offsets inside [-0.5, 0.5]; +x is right and +y is up. The sequence repeats
// after `samples` frames, so the temporal pattern stays bounded and reproducible.
export function jitterSample(index, samples = DEFAULT_JITTER_SAMPLES) {
  const cycle = Number.isInteger(samples) && samples > 0 ? samples : DEFAULT_JITTER_SAMPLES
  const position = Math.floor(index)
  const step = Number.isFinite(position) ? ((position % cycle) + cycle) % cycle : 0
  return { x: halton(step + 1, 2) - 0.5, y: halton(step + 1, 3) - 0.5 }
}

// Cesium's PerspectiveFrustum applies xOffset/yOffset by shifting left/right/top/bottom
// together, which translates the near plane by that many metres. A translated near plane
// moves normalized device coordinates by -offset/halfExtent, and one pixel spans 2/size
// in NDC, so a one-pixel request maps to (2/size) * halfExtent metres. Both the offsets
// and the offsets' participants (`update()` compares xOffset/yOffset as well) are public
// API, which is why jitter does not need to patch Cesium internals.
export function nearPlaneOffsets(frustum, jitter, resolution) {
  if (!frustum || !jitter || !resolution) return null
  const fovy = frustum.fovy
  const aspectRatio = frustum.aspectRatio
  const near = frustum.near
  const width = resolution.width
  const height = resolution.height
  if (!Number.isFinite(fovy) || !Number.isFinite(aspectRatio) || !Number.isFinite(near)) return null
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null
  if (!(fovy > 0) || !(aspectRatio > 0) || !(near > 0) || !(width > 0) || !(height > 0)) return null
  const halfHeight = near * Math.tan(fovy * 0.5)
  const halfWidth = aspectRatio * halfHeight
  // A zero component must be +0: -0 survives into frustum.xOffset/yOffset and would make
  // later exact comparisons (and diagnostic readouts) report a non-zero jitter.
  const signed = value => value === 0 ? 0 : value
  return { xOffset: signed(-(2 * jitter.x / width) * halfWidth),
    yOffset: signed(-(2 * jitter.y / height) * halfHeight) }
}

// Consumers that assume a symmetric camera (screen-space reflections) still have to accept
// the sub-pixel offsets temporal anti-aliasing installs every frame. This separates those
// from a genuinely off-centre projection, which would break their screen-space math.
export function isSubPixelOffset(frustum, resolution, pixels = 1) {
  if (!frustum || !resolution) return false
  const x = frustum.xOffset
  const y = frustum.yOffset
  if (x === 0 && y === 0) return true
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false
  const bound = nearPlaneOffsets(frustum, { x: pixels, y: pixels }, resolution)
  if (!bound) return false
  return Math.abs(x) <= Math.abs(bound.xOffset) && Math.abs(y) <= Math.abs(bound.yOffset)
}
