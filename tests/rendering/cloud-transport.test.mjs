import test from 'node:test'
import assert from 'node:assert/strict'
import { cloudGLSL } from '../../src/environment/volumetricClouds143.js'
import { cloudShellIntervals } from '../../src/environment/cloudShell143.js'
import { cloudTransportDensityGLSL } from '../../src/environment/reference/three-clouds/cloudTransportDensity.js'

const shader = cloudGLSL('balanced')
test('density ports weather semicircle coverage filter before shape/detail erosion', () => {
  assert.match(shader, /ccrCloudWeatherDensity/)
  assert.match(shader, /pow\(heightFraction, 0\.35\)/)
  assert.match(shader, /1\.0 - coverage \* heightScale/)
  assert.match(shader, /pow\(detail, 6\.0\)/)
  assert.match(shader, /0\.75 \* heightFraction \+ 0\.25/)
  assert.doesNotMatch(shader, /sqrt\(max\(mass - erosion/)
})
test('light and view transport share ground-clipped spherical shell intervals', () => {
  assert.match(shader, /vec4 ccrCloudShellIntervals/)
  assert.match(shader, /ccrCloudShellIntervals\(position, sunDirectionAtmo, 1\.0e9\)/)
  const sunPath=shader.slice(shader.indexOf('float ccrCloudSunOpticalDepth('),shader.indexOf('float ccrCloudSunVisibility('))
  assert.doesNotMatch(sunPath, /6000\.0|distanceToTop = 4000/)
  const radius = 6371000
  const intervals = cloudShellIntervals([0, 0, radius + 1500], [1, 0, 0], radius, 1000, 2200, 1e9)
  assert.ok(intervals[1] > 90000, 'grazing sun extinction must cover the entire ~94 km chord')
})
test('cloud sunlight is attenuated at each sample altitude and includes bounded bounce/powder', () => {
  assert.match(shader, /ccrAtmosphereLightTransmittance\(position, sunDirectionAtmo/)
  assert.match(shader, /atmosphereSunRadiance \* ccrCloudAtmosphereSunTransmittance/)
  assert.match(shader, /ccrCloudGroundBounce/)
  assert.match(shader, /1\.0 - 0\.8 \* exp\(-density \* 150\.0\)/)
  assert.match(shader, /mix\(ccrCloudPhase\(mu, 0\.7 \* attenuation\), ccrCloudPhase\(mu, -0\.2 \* attenuation\), 0\.5\)/)
})
test('geometry transport returns weighted metric distance and uses exactly the radiance quadrature', () => {
  assert.match(shader, /vec2 ccrCloudGeometry\(vec3 origin, vec3 direction, float sceneDistance\)/)
  assert.match(shader, /weightedDistance \+= distanceAlongRay \* sampleWeight/)
  assert.match(shader, /cloudDistance = weightSum > 0\.0 \? weightedDistance \/ weightSum : sceneDistance/)
  assert.match(shader, /if \(cloudParams.x <= 0\.0 \|\| cloudParams.w <= 0\.0\)/)
  assert.match(shader, /min\(max\(sceneDistance, 0\.0\), viewRange\)/)
  assert.match(shader, /ccrCloudDensity\(position\) \* ccrCloudDistanceFade\(distanceAlongRay, viewRange\)/)
  assert.match(shader, /1\.0 - smoothstep\(maxDistance \* 0\.7, maxDistance, distance\)/)
})
test('temporal jitter is gated, with independent weather/shape/detail evolution', () => {
  assert.match(shader, /uniform vec2 cloudFrame/)
  assert.match(shader, /if \(cloudFrame.y < 0\.5\) return 0\.5/)
  for (const offset of ['cloudWeatherOffset', 'cloudShapeOffset', 'cloudDetailOffset']) {
    assert.ok(shader.includes(`uniform vec3 ${offset}`))
    assert.ok(shader.includes(`p + ${offset}`))
  }
  assert.doesNotMatch(shader, /cloudWind \*|length\(cloudWind/)
})

// Execute the production scalar GLSL arithmetic on the CPU. This checks numerical
// behavior of the emitted equations; WebGL compilation/precision is a separate check.
const scalarSource = cloudTransportDensityGLSL
  .replace(/float (\w+)\(([^)]*)\)/g, (_, name, args) => `function ${name}(${args.replace(/float /g, '')})`)
  .replace(/\bfloat /g, 'let ')
const { weatherDensity, mediaDensity } = new Function('clamp', 'mix', 'pow', 'max', `${scalarSource}
  return { weatherDensity: ccrCloudWeatherDensity, mediaDensity: ccrCloudMediaDensity };`)(
  (x, low, high) => Math.min(high, Math.max(low, x)),
  (a, b, t) => a * (1 - t) + b * t, Math.pow, Math.max)
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`)

test('weather and media match pinned upstream scalar golden samples through both erosion regimes', () => {
  // Direct scalar evaluations of clouds.glsl at the pinned commit; no atlas dependence.
  for (const [h, local, coverage, shape, detail, expectedWeather, expectedDensity] of [
    [.4, .5, .5, .8, .6, .33028918180522443, .08643453122772955],
    [.6, .5, .7, .8, .6, .3055994713672528, .055998843615865546],
    [.9, .9, 1, 1, .8, .1659584464497491, .2383590288133732],
    [.1, .2, .4, .9, .5, .1257529617442003, .01618675780505221],
    [.02, .8, .6, .8, .3, .6252089791690112, .265]
  ]) {
    const weather = weatherDensity(h, local, coverage)
    near(weather, expectedWeather)
    near(mediaDensity(h, weather, shape, detail, 1), expectedDensity)
  }
})

test('weather is exactly absent at boundaries/zero coverage and increases monotonically with coverage', () => {
  for (const height of [-1, 0, 1, 2]) near(weatherDensity(height, 1, 1), 0)
  for (let h = .01; h < 1; h += .07) {
    near(weatherDensity(h, 1, 0), 0)
    for (let local = 0; local <= 1; local += .1) {
      let previous = 0
      for (let coverage = 0; coverage <= 1; coverage += .05) {
        const value = weatherDensity(h, local, coverage)
        assert.ok(value >= previous && value <= 1)
        previous = value
      }
    }
  }
})

test('shape/detail remaps never create density in empty weather, and retain the vertical profile bound', () => {
  for (let h = .01; h < 1; h += .07) {
    for (const shape of [0, .3, .8, 1]) {
      for (const detail of [0, .5, 1]) {
        near(mediaDensity(h, 0, shape, detail, 1), 0)
        const density = mediaDensity(h, 1, shape, detail, 1)
        assert.ok(density >= 0 && density <= .75 * h + .25)
      }
    }
  }
})
