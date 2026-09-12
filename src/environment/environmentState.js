export const environmentDefaults = Object.freeze({
  environment: true, environmentPreset: 'clear', environmentQuality: 'balanced',
  skyLightIntensity: 3.2, sunIntensity: 2.2, clouds: true, cloudCoverage: null,
  cloudModel: 'auto', volumetricFog: true, sunScattering: true, environmentAnimation: true,
  fogBaseHeight: 20, fogHeightFalloff: null, cloudBaseHeight: null, cloudThickness: null
})

const profiles = {
  clear: { fog: 1, height: 180, coverage: 0.42, cloud: 'cumulus', base: 1600, top: 2800, mie: 0.65, sun: 1 },
  morning: { fog: 9, height: 85, coverage: 0.3, cloud: 'cumulus', base: 1800, top: 2800, mie: 1.1, sun: 0.9 },
  overcast: { fog: 2.5, height: 260, coverage: 0.78, cloud: 'stratus', base: 1000, top: 1600, mie: 1.6, sun: 0.45 },
  sunset: { fog: 2, height: 160, coverage: 0.4, cloud: 'cumulus', base: 1400, top: 2600, mie: 1.2, sun: 1 },
  haze: { fog: 5, height: 380, coverage: 0.22, cloud: 'stratus', base: 1800, top: 2400, mie: 2, sun: 0.7 }
}

export function normalizeEnvironmentOptions(input = {}, current = environmentDefaults) {
  const result = { ...current }
  for (const key of ['environment', 'clouds', 'volumetricFog', 'sunScattering', 'environmentAnimation']) {
    if (typeof input[key] === 'boolean') result[key] = input[key]
  }
  for (const [key, values] of Object.entries({ environmentPreset: Object.keys(profiles),
    environmentQuality: ['balanced', 'high'], cloudModel: ['auto', 'cumulus', 'stratus'] })) {
    if (values.includes(input[key])) result[key] = input[key]
  }
  for (const [key, min, max] of [['skyLightIntensity', 0, 5], ['sunIntensity', 0, 5], ['cloudCoverage', 0, 0.95],
    ['fogBaseHeight', -1000, 10000], ['fogHeightFalloff', 10, 3000], ['cloudBaseHeight', 50, 12000], ['cloudThickness', 100, 6000]]) {
    if (Number.isFinite(input[key])) result[key] = Math.max(min, Math.min(max, input[key]))
  }
  for (const key of ['cloudCoverage', 'fogHeightFalloff', 'cloudBaseHeight', 'cloudThickness']) {
    if (input[key] === null) result[key] = null
  }
  return result
}

const smooth = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

export function resolveEnvironmentState(options = {}, sunHeight = 1, seconds = 0) {
  const o = normalizeEnvironmentOptions(options)
  const p = profiles[o.environmentPreset]
  const daylight = smooth(-0.12, 0.18, sunHeight)
  const direct = smooth(0, 0.12, sunHeight) * (0.65 + 0.35 * smooth(0.12, 0.6, sunHeight))
  const white = smooth(0.02, 0.35, sunHeight)
  const sunColor = [1, 0.28 + 0.66 * white, 0.07 + 0.75 * white]
  const sunIntensity = o.sunIntensity * direct * p.sun
  const windTime = o.environmentAnimation && Number.isFinite(seconds) ? seconds : 0
  return {
    ...o, sunIntensity, sunColor, daylight,
    sunRadiance: sunColor.map(v => v * sunIntensity * 3),
    skyRadiance: [0.3, 0.43, 0.65].map(v => v * (0.025 + 0.975 * daylight) * o.skyLightIntensity / 2.8),
    fogDensity: (Number.isFinite(options.fogDensity) ? Math.max(0, Math.min(0.0005, options.fogDensity)) : 0.000025) * p.fog,
    fogScaleHeight: o.fogHeightFalloff === null ? p.height : o.fogHeightFalloff, fogNoise: o.volumetricFog ? 0.45 : 0,
    cloudCoverage: o.cloudCoverage === null ? p.coverage : o.cloudCoverage,
    cloudModel: o.cloudModel === 'auto' ? p.cloud : o.cloudModel,
    cloudBase: o.cloudBaseHeight === null ? p.base : o.cloudBaseHeight,
    cloudTop: (o.cloudBaseHeight === null ? p.base : o.cloudBaseHeight) + (o.cloudThickness === null ? p.top - p.base : o.cloudThickness),
    cloudExtinction: 0.006,
    windOffset: [(windTime * 8) % 64000, (windTime * 2) % 64000],
    // Native HDR bypasses the sky's own tone map; balance its radiance before
    // the shared exposure/ACES pass without darkening scene materials or IBL.
    rayleighScale: 1, mieScale: p.mie, atmosphereIntensity: 10, skyAtmosphereIntensity: 20
  }
}
