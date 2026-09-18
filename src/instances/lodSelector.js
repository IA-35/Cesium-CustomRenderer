export const DEFAULT_TREE_LOD_THRESHOLDS = Object.freeze([96, 40, 16])

export function projectedTreePixels({ height, distance, viewportHeight, fovY }) {
  if (distance <= 0) return Infinity
  if (![height, distance, viewportHeight, fovY].every(Number.isFinite) || height < 0 || viewportHeight <= 0 || fovY <= 0) return 0
  return height * viewportHeight / (2 * distance * Math.tan(fovY / 2))
}

export function selectTreeLod({ pixels, currentLod, thresholds = DEFAULT_TREE_LOD_THRESHOLDS, hysteresis = 0.15 }) {
  if (!Array.isArray(thresholds) || thresholds.length !== 3 || thresholds.some(value => !Number.isFinite(value) || value <= 0)) throw new Error('Tree LOD requires three positive thresholds')
  if (!Number.isFinite(pixels)) return pixels === Infinity ? 0 : 3
  let desired = pixels >= thresholds[0] ? 0 : pixels >= thresholds[1] ? 1 : pixels >= thresholds[2] ? 2 : 3
  if (!Number.isInteger(currentLod) || currentLod < 0 || currentLod > 3) return desired
  let lod = currentLod
  while (desired > lod && lod < 3 && pixels < thresholds[lod] * (1 - hysteresis)) lod++
  while (desired < lod && lod > 0 && pixels > thresholds[lod - 1] * (1 + hysteresis)) lod--
  return lod
}
