import { environmentDefaults, normalizeEnvironmentOptions } from './environment/environmentState.js'
import { antiAliasingDefaults, normalizeAntiAliasing } from './antialiasing/settings143.js'

export const colorGradingPresets = Object.freeze({
  neutral: Object.freeze({ contrast: 1, brightness: 1, exposure: 1.6, saturation: 1, hue: 0 }),
  clear: Object.freeze({ contrast: 1.1, brightness: 1.08, exposure: 1.6, saturation: 1.05, hue: 0 })
})

export const defaultFilters = colorGradingPresets.clear

export const defaults = Object.freeze({
  ...antiAliasingDefaults,
  ...environmentDefaults,
  ...defaultFilters, shadows: true, shadowMode: 'custom', shadowDebug: false, shadowStatic: false, shadowSize: 4096, shadowCascades: 1, shadowDistance: 4000,
  msaaCombine: false,
  ambientOcclusion: false, fog: true, fogDensity: 0.000025, bloom: false,
  geometryEnabled: false, geometryDebugMode: 'off', materialChannelsEnabled: false, albedoEnabled: false, depthPyramidEnabled: false,
  screenSpaceAoEnabled: false, screenSpaceAoRadius: 3, screenSpaceAoStrength: 1, screenSpaceAoBias: 0.08,
  screenSpaceReflectionEnabled: false, screenSpaceReflectionDistance: 150, screenSpaceReflectionThickness: 0.5, screenSpaceReflectionStrength: 1,
  screenSpaceReflectionTransparent: false,
  taaJitterSamples: 8, taaHistoryBlend: 0.03, taaMotionBlend: 0.5, taaVelocityThreshold: 12, taaDepthTolerance: 0.1
})

const ranges = {
  contrast: [0, 3], brightness: [0, 3], exposure: [0.05, 5],
  saturation: [0, 3], hue: [-1, 1], shadowDistance: [100, 20000],
  fogDensity: [0, 0.0005], screenSpaceAoRadius: [0.1, 20], screenSpaceAoStrength: [0, 2], screenSpaceAoBias: [0.02, 0.5],
  screenSpaceReflectionDistance: [1, 2000], screenSpaceReflectionThickness: [0.01, 20], screenSpaceReflectionStrength: [0, 1],
  taaHistoryBlend: [0.02, 0.5], taaMotionBlend: [0.1, 1], taaVelocityThreshold: [1, 64], taaDepthTolerance: [0, 0.5]
}

export function normalizeOptions(input = {}, current = defaults) {
  if (!input || typeof input !== 'object') input = {}
  const result = normalizeAntiAliasing(input, normalizeEnvironmentOptions(input, current))
  Object.keys(ranges).forEach(key => {
    if (Number.isFinite(input[key])) {
      result[key] = Math.max(ranges[key][0], Math.min(ranges[key][1], input[key]))
    }
  })
  ;['shadows', 'ambientOcclusion', 'fog', 'bloom', 'shadowDebug', 'shadowStatic', 'geometryEnabled', 'materialChannelsEnabled', 'albedoEnabled', 'depthPyramidEnabled', 'screenSpaceAoEnabled', 'screenSpaceReflectionEnabled', 'screenSpaceReflectionTransparent', 'msaaCombine'].forEach(key => {
    if (typeof input[key] === 'boolean') result[key] = input[key]
  })
  if ([1024, 2048, 4096].includes(input.shadowSize)) result.shadowSize = input.shadowSize
  if ([1, 4].includes(input.shadowCascades)) result.shadowCascades = input.shadowCascades
  if ([4, 8, 16].includes(input.taaJitterSamples)) result.taaJitterSamples = input.taaJitterSamples
  if (['native', 'custom'].includes(input.shadowMode)) result.shadowMode = input.shadowMode
  if (['off', 'normal', 'depth'].includes(input.geometryDebugMode)) result.geometryDebugMode = input.geometryDebugMode
  return result
}

export const colorGradingControls = Object.freeze([
  ['brightness', '亮度'], ['contrast', '对比度'], ['saturation', '饱和度'], ['hue', '色相'], ['exposure', '曝光']
].map(([key, label]) => Object.freeze({ key, label, min: ranges[key][0], max: ranges[key][1], step: 0.01 })))

export function normalizeColorGrading(input = {}, current = defaultFilters) {
  const accepted = {}
  for (const key of Object.keys(defaultFilters)) {
    if (input && Number.isFinite(input[key])) accepted[key] = input[key]
  }
  const result = normalizeOptions(accepted, { ...defaults, ...current })
  return Object.fromEntries(Object.keys(defaultFilters).map(key => [key, result[key]]))
}

// The first version saved its defaults on every map load. Upgrade only that exact
// preset; retain records that users have changed, and keep renderer/UI consistent.
export function resolveSavedFilters(saved) {
  const previous = [
    { contrast: 1.05, brightness: 1, exposure: 1, saturation: 0.95, hue: 0 },
    { contrast: 1, brightness: 1, exposure: 1.6, saturation: 0.95, hue: 0 }
  ]
  const input = saved && typeof saved === 'object' ? saved : {}
  if (previous.some(preset => Object.keys(preset).every(key => input[key] === preset[key]))) return { ...defaultFilters }
  const normalized = normalizeOptions(input)
  return Object.fromEntries(Object.keys(defaultFilters).map(key => [key, normalized[key]]))
}
