export const environmentDefaults = Object.freeze({
  environment: true, environmentPreset: 'clear', environmentQuality: 'balanced',
  skyLightIntensity: 3.2, sunIntensity: 2.2, clouds: true, cloudCoverage: null,
  cloudModel: 'auto', cloudGeometry: 'shell', volumetricFog: true, sunScattering: true, environmentAnimation: true,
  fogBaseHeight: 20, fogHeightFalloff: null, cloudBaseHeight: null, cloudThickness: null
})

// Log-luminance fit to native SkyAtmosphere (intensity 20), measured before
// tonemapping at 06:30/11:00/17:30 and three camera directions. The two
// scattering implementations do not share an intensity unit. Native sun bloom
// and its LDR intermediate are excluded. The fitted 8.952 is rounded to 9.
// This is a mean-luminance calibration, not angular/spectral model equivalence.
export const ATMOSPHERE_HDR_INTENSITY = 9

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
    environmentQuality: ['performance', 'balanced', 'high'], cloudModel: ['auto', 'cumulus', 'stratus'], cloudGeometry: ['local', 'shell'] })) {
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

export function resolveEnvironmentState(options = {}, sunHeight = 1, seconds = 0, celestial = {}) {
  const o = normalizeEnvironmentOptions(options)
  const p = profiles[o.environmentPreset]
  const daylight = smooth(-0.12, 0.18, sunHeight)
  const nightWeight = 1 - smooth(-0.12, -0.01, sunHeight)
  const moonHeight = Number.isFinite(celestial.moonHeight) ? Math.max(-1, Math.min(1, celestial.moonHeight)) : -1
  const moonPhase = Number.isFinite(celestial.moonPhase) ? Math.max(0, Math.min(1, celestial.moonPhase)) : 0
  // Engineering radiance, independent of the solar spectrum and exposure. Moon
  // phase is the Lambert brightness supplied by the celestial-direction solver.
  const moonStrength = 0.15 * nightWeight * moonPhase * smooth(0, 0.12, moonHeight)
  const direct = smooth(0, 0.12, sunHeight) * (0.65 + 0.35 * smooth(0.12, 0.6, sunHeight))
  const white = smooth(0.02, 0.35, sunHeight)
  const sunColor = [1, 0.28 + 0.66 * white, 0.07 + 0.75 * white]
  const sunIntensity = o.sunIntensity * direct * p.sun
  const windTime = o.environmentAnimation && Number.isFinite(seconds) ? seconds : 0
  const cloudModel = o.cloudModel === 'auto' ? p.cloud : o.cloudModel
  return {
    ...o, sunIntensity, sunColor, daylight, nightWeight, moonHeight, moonPhase,
    moonRadiance: [0.65, 0.8, 1].map(v => v * moonStrength),
    nightSkyRadiance: [0.012, 0.022, 0.045].map(v => v * nightWeight * (o.skyLightIntensity / 3.2)),
    sunRadiance: sunColor.map(v => v * sunIntensity * 3),
    // Scalar feeding the scattering integral's light term. The integral already computes the
    // solar spectrum, horizon extinction and planet occlusion, so this stays white and is not
    // tinted twice.
    //
    // Calibrated against the native sky across solar angles, not copied from its
    // numerically different intensity parameter. This remains an engineering
    // radiance scale; neither this value nor the reference's "40 looks nice" is SI.
    //
    // daylight, not direct: direct collapses to zero as soon as the sun crosses the horizon,
    // which would delete the sunset glow this integral is meant to produce. daylight spans
    // roughly -0.12..0.18 of sun height, so the sky dims through dusk and stays dark at night.
    // Omitting it entirely left the sky at full noon brightness after sunset.
    atmosphereSunRadiance: [1, 1, 1].map(v => v * ATMOSPHERE_HDR_INTENSITY
      * (o.sunIntensity / environmentDefaults.sunIntensity) * p.sun * daylight),
    skyRadiance: [0.3, 0.43, 0.65].map(v => v * (0.025 + 0.975 * daylight) * o.skyLightIntensity / 2.8),
    fogDensity: (Number.isFinite(options.fogDensity) ? Math.max(0, Math.min(0.0005, options.fogDensity)) : 0.000025) * p.fog,
    fogScaleHeight: o.fogHeightFalloff === null ? p.height : o.fogHeightFalloff, fogNoise: o.volumetricFog ? 0.45 : 0,
    cloudCoverage: o.cloudCoverage === null ? p.coverage : o.cloudCoverage,
    cloudModel,
    cloudBase: o.cloudBaseHeight === null ? p.base : o.cloudBaseHeight,
    cloudTop: (o.cloudBaseHeight === null ? p.base : o.cloudBaseHeight) + (o.cloudThickness === null ? p.top - p.base : o.cloudThickness),
    // The single cumulus layer needs opaque cores after weather/shape carving.
    // Calibrate the medium itself; stratus retains its existing extinction.
    cloudExtinction: cloudModel === 'cumulus' ? 0.06 : 0.03,
    windOffset: [(windTime * 8) % 64000, (windTime * 2) % 64000],
    // Native HDR bypasses the sky's own tone map; balance its radiance before
    // the shared exposure/ACES pass without darkening scene materials or IBL.
    rayleighScale: 1, mieScale: p.mie, atmosphereIntensity: 10, skyAtmosphereIntensity: 20
  }
}
