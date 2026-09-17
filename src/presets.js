import { environmentDefaults, normalizeEnvironmentOptions } from './environment/environmentState.js'
import { antiAliasingDefaults, normalizeAntiAliasing } from './antialiasing/settings143.js'
import { LENS_EFFECT_DEFAULTS } from './stages/lensEffects143.js'
import { TONE_CURVES } from './stages/toneMapping143.js'

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
  renderTargetPoolEnabled: true,
  occlusionCullingEnabled: false,
  ambientOcclusion: false, fog: true, fogDensity: 0.000025, bloom: false,
  hdrBloomEnabled: false, hdrBloomStrength: 0.15, hdrBloomThreshold: 1, hdrBloomKnee: 0.5, hdrBloomLevels: 5,
  geometryEnabled: false, geometryDebugMode: 'off', materialChannelsEnabled: false, albedoEnabled: false, depthPyramidEnabled: false,
  // B02: deferred lighting is experimental and off by default. `enhanced` keeps native forward
  // lighting untouched. The per-term switches exist so a lighting mismatch can be attributed to one
  // term instead of being blamed on "the lighting" as a whole.
  lightingMode: 'enhanced', lightingDirect: true, lightingIndirect: true, lightingEmissive: true,
  lightingShadow: true, lightingAo: true, lightingAoStrength: 1, lightingDebugMode: 0,
  screenSpaceAoEnabled: false, screenSpaceAoAlgorithm: 'ssao', screenSpaceAoRadius: 3, screenSpaceAoStrength: 1, screenSpaceAoBias: 0.08,
  screenSpaceReflectionEnabled: false, screenSpaceReflectionDistance: 150, screenSpaceReflectionThickness: 0.5, screenSpaceReflectionStrength: 1,
  screenSpaceReflectionTransparent: false,
  taaJitterSamples: 8, taaHistoryBlend: 0.03, taaMotionBlend: 0.5, taaVelocityThreshold: 12, taaDepthTolerance: 0.1,
  // B09: tone mapping and lens effects. All off/inert by default; `aces` keeps the native ACES
  // path that CCR already owned, so enabling tone mapping alone changes nothing.
  toneMappingCurve: 'aces',
  ...LENS_EFFECT_DEFAULTS
})

/** B09 的曲线名必须在白名单内；未知值回退到 `aces`（原生默认），不静默切到实验曲线。 */
export const toneMappingCurveNames = Object.freeze(Object.keys(TONE_CURVES))

const ranges = {
  hdrBloomStrength: [0, 2], hdrBloomThreshold: [0, 20], hdrBloomKnee: [0, 1],
  contrast: [0, 3], brightness: [0, 3], exposure: [0.05, 5],
  saturation: [0, 3], hue: [-1, 1], shadowDistance: [100, 20000],
  fogDensity: [0, 0.0005], screenSpaceAoRadius: [0.1, 20], screenSpaceAoStrength: [0, 2], screenSpaceAoBias: [0.02, 0.5],
  screenSpaceReflectionDistance: [1, 2000], screenSpaceReflectionThickness: [0.01, 20], screenSpaceReflectionStrength: [0, 1],
  taaHistoryBlend: [0.02, 0.5], taaMotionBlend: [0.1, 1], taaVelocityThreshold: [1, 64], taaDepthTolerance: [0, 0.5],
  lightingAoStrength: [0, 1], lightingDebugMode: [0, 7],
  // B09 镜头效果范围。
  tiltShiftFocus: [0, 1], tiltShiftWidth: [0.005, 0.5], tiltShiftRadius: [0, 32], tiltShiftStrength: [0, 1],
  blurRadius: [0, 32], blurStrength: [0, 1],
  depthOfFieldFocus: [0.1, 5000], depthOfFieldRange: [0.1, 2000], depthOfFieldRadius: [0, 32], depthOfFieldStrength: [0, 1],
  chromaticAberrationStrength: [0, 8],
  sunFlareStrength: [0, 2],
  lightShaftStrength: [0, 2], lightShaftSamples: [4, 32]
}

export function normalizeOptions(input = {}, current = defaults) {
  if (!input || typeof input !== 'object') input = {}
  const result = normalizeAntiAliasing(input, normalizeEnvironmentOptions(input, current))
  Object.keys(ranges).forEach(key => {
    if (Number.isFinite(input[key])) {
      result[key] = Math.max(ranges[key][0], Math.min(ranges[key][1], input[key]))
    }
  })
  ;['shadows', 'ambientOcclusion', 'fog', 'bloom', 'shadowDebug', 'shadowStatic', 'geometryEnabled', 'materialChannelsEnabled', 'albedoEnabled', 'depthPyramidEnabled', 'screenSpaceAoEnabled', 'screenSpaceReflectionEnabled', 'screenSpaceReflectionTransparent', 'msaaCombine', 'lightingDirect', 'lightingIndirect', 'lightingEmissive', 'lightingShadow', 'lightingAo'].forEach(key => {
    if (typeof input[key] === 'boolean') result[key] = input[key]
  })
  if (typeof input.renderTargetPoolEnabled==='boolean') result.renderTargetPoolEnabled=input.renderTargetPoolEnabled
  if (typeof input.occlusionCullingEnabled==='boolean') result.occlusionCullingEnabled=input.occlusionCullingEnabled
  if ([1024, 2048, 4096].includes(input.shadowSize)) result.shadowSize = input.shadowSize
  if (typeof input.hdrBloomEnabled === 'boolean') result.hdrBloomEnabled = input.hdrBloomEnabled
  if (Number.isFinite(input.hdrBloomLevels)) result.hdrBloomLevels = Math.max(2, Math.min(6, Math.round(input.hdrBloomLevels)))
  if ([1, 3, 4].includes(input.shadowCascades)) result.shadowCascades = input.shadowCascades
  if ([4, 8, 16].includes(input.taaJitterSamples)) result.taaJitterSamples = input.taaJitterSamples
  if (['native', 'custom'].includes(input.shadowMode)) result.shadowMode = input.shadowMode
  if (['ssao', 'hbao'].includes(input.screenSpaceAoAlgorithm)) result.screenSpaceAoAlgorithm = input.screenSpaceAoAlgorithm
  if (['off', 'normal', 'depth'].includes(input.geometryDebugMode)) result.geometryDebugMode = input.geometryDebugMode
  // `enhanced` is both the default and the fallback for anything unrecognised, so a typo can never
  // silently switch the renderer into an experimental lighting path.
  if (['enhanced', 'deferred'].includes(input.lightingMode)) result.lightingMode = input.lightingMode
  // B09：只有白名单内的曲线名被接受；未知值保持当前值（默认 aces = 原生），
  // 不静默切到实验性的自建曲线。
  if (toneMappingCurveNames.includes(input.toneMappingCurve)) result.toneMappingCurve = input.toneMappingCurve
  // B09 镜头效果的开关：严格布尔，字符串 'true' 不得被当作开启（与既有纪律一致）。
  for (const key of Object.keys(LENS_EFFECT_DEFAULTS)) {
    if (key.endsWith('Enabled')) {
      if (typeof input[key] === 'boolean') result[key] = input[key]
    } else if (Number.isFinite(input[key]) && ranges[key]) {
      result[key] = Math.max(ranges[key][0], Math.min(ranges[key][1], input[key]))
    }
  }
  if (Number.isFinite(input.lightShaftSamples)) result.lightShaftSamples = Math.max(4, Math.min(32, Math.round(input.lightShaftSamples)))
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
