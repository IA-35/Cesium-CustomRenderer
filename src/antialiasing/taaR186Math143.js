// CPU oracle/helper for fixed Three.js r186 TRAA (MIT, ./reference/three-r186).
// Formula checks do not substitute for GLSL/GPU tests.
const saturate = value => Math.min(1, Math.max(0, value))

export function r186HistoryValid({ historyUv, closestDepth, farthestDepth, previousDepth,
  globalValid = true, localValid = true, edgeDepthDiff = 0.001, depthThreshold = 0.0005 }) {
  const inBounds = historyUv.every(value => value >= 0 && value <= 1)
  const edge = farthestDepth - closestDepth > edgeDepthDiff
  const disocclusion = closestDepth - previousDepth > depthThreshold
  return globalValid && localValid && inBounds && (edge || !disocclusion)
}

export function r186CurrentWeight(offsetUv, resolution, valid, maxVelocityLength = 128, useSubpixelCorrection = true) {
  if (!valid) return 1
  const pixels = offsetUv.map((value, i) => value * resolution[i])
  const motionFactor = saturate(Math.hypot(...pixels) / maxVelocityLength)
  const weight = pixels.map(value => {
    const phase = Math.abs(value - Math.floor(value))
    return Math.max(phase, 1 - phase)
  })
  const subpixel = (1 - weight[0] * weight[1]) / 0.75
  return saturate(0.05 + (useSubpixelCorrection ? subpixel * 0.25 : 0) + motionFactor)
}

export function r186VarianceGamma(motionFactor) {
  return 0.5 + 0.5 * (1 - motionFactor) ** 2
}

export function r186VarianceClip(colors, historyColor, gamma) {
  const moments = [0, 1, 2, 3].map(channel => {
    const values = colors.map((color, i) => i === 0 ? color[channel] : Math.max(0, color[channel]))
    const mean = values.reduce((a, b) => a + b, 0) / 9
    const variance = Math.max(0, values.reduce((sum, value) => sum + value * value, 0) / 9 - mean * mean)
    return [mean, Math.sqrt(variance) * gamma]
  })
  const maxUnit = Math.max(...moments.slice(0, 3).map(([mean, extent], i) => Math.abs(historyColor[i] - mean) / (extent + 1e-7)))
  return maxUnit > 1 ? historyColor.map((value, i) => moments[i][0] + (value - moments[i][0]) / maxUnit) : [...historyColor]
}

export function r186FlickerReduction(currentColor, historyColor, currentWeight) {
  const luminance = color => {
    const scale = 1 / (Math.max(...color.slice(0, 3)) + 1)
    return (color[0] * 0.2126 + color[1] * 0.7152 + color[2] * 0.0722) * scale
  }
  const a = currentWeight / (luminance(currentColor) + 1)
  const b = (1 - currentWeight) / (luminance(historyColor) + 1)
  return currentColor.map((value, i) => (value * a + historyColor[i] * b) / Math.max(a + b, 0.00001))
}

export function r186PerspectiveDepth(eyeDepth, [near, far]) {
  return eyeDepth === 0 ? 1 : (far - near * far / eyeDepth) / (far - near)
}

export function r186PreviousDepth(eyeDepth, uv, previousInverseRasterProjection, currentViewFromPreviousEye, nearFar) {
  if (eyeDepth <= 0) return 1
  const multiply = (matrix, vector) => [0, 1, 2, 3].map(row => vector.reduce((sum, value, col) => sum + matrix[col * 4 + row] * value, 0))
  const ray = multiply(previousInverseRasterProjection, [uv[0] * 2 - 1, uv[1] * 2 - 1, 0, 1])
  const eye = ray.slice(0, 3).map(value => value * (-eyeDepth / ray[2]))
  const currentEye = multiply(currentViewFromPreviousEye, [...eye, 1])
  return r186PerspectiveDepth(-currentEye[2], nearFar)
}
