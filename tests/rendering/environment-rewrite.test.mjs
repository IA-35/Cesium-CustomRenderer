import test from 'node:test'
import assert from 'node:assert/strict'
import { atmosphereGLSL, atmosphereTier, ATMOSPHERE_TIERS, PLANET_RADIUS_M, ATMOSPHERE_RADIUS_M,
  RAYLEIGH_SCALE_HEIGHT, MIE_SCALE_HEIGHT, OZONE_CENTER_HEIGHT } from '../../src/environment/atmosphereScattering143.js'
import { cloudGLSL, cloudTier, CLOUD_TIERS } from '../../src/environment/volumetricClouds143.js'

// Reproduce the shader's sphere intersection in JS so the geometry can be checked numerically.
function intersectSphere(origin, direction, radius) {
  const a = direction.reduce((sum, v) => sum + v * v, 0)
  const b = 2 * origin.reduce((sum, v, i) => sum + v * direction[i], 0)
  const c = origin.reduce((sum, v) => sum + v * v, 0) - radius * radius
  const d = b * b - 4 * a * c
  if (d < 0) return [1e9, -1e9]
  const sqrtD = Math.sqrt(d)
  return [(-b - sqrtD) / (2 * a), (-b + sqrtD) / (2 * a)]
}

test('atmosphere declaratives expose finite march budgets for every tier', () => {
  for (const name of ['performance', 'balanced', 'high']) {
    const tier = atmosphereTier(name)
    assert.ok(tier.outerSteps > 0 && tier.lightSteps > 0)
    // The product is the real cost, so it must stay bounded as the tier rises.
    assert.ok(tier.outerSteps * tier.lightSteps <= 128, `${name} product too large`)
    const shader = atmosphereGLSL(name)
    assert.match(shader, new RegExp(`#define ATMOS_OUTER_STEPS ${tier.outerSteps}`))
    assert.match(shader, new RegExp(`#define ATMOS_LIGHT_STEPS ${tier.lightSteps}`))
  }
  assert.deepEqual(atmosphereTier('unknown'), ATMOSPHERE_TIERS.balanced)
})

test('atmosphere scale heights are physical and ordered', () => {
  assert.ok(RAYLEIGH_SCALE_HEIGHT > MIE_SCALE_HEIGHT, 'Rayleigh haze must be deeper than Mie haze')
  assert.ok(OZONE_CENTER_HEIGHT > 15000, 'ozone layer must sit well above the ground')
  assert.ok(ATMOSPHERE_RADIUS_M > PLANET_RADIUS_M)
})

test('a horizontal ray from the ground is inside the atmosphere shell', () => {
  const origin = [0, 0, PLANET_RADIUS_M + 2]
  const direction = [1, 0, 0]
  const hit = intersectSphere(origin, direction, ATMOSPHERE_RADIUS_M)
  assert.ok(hit[0] < 0, 'the near intersection is behind the camera')
  assert.ok(hit[1] > 0, 'the far intersection is ahead')
  // The chord length across the shell must be far larger than the shell thickness.
  assert.ok(hit[1] - Math.max(hit[0], 0) > 100000)
})

test('a ray pointing away from the planet still meets the atmosphere shell', () => {
  const origin = [0, 0, PLANET_RADIUS_M + 2]
  const direction = [0, 0, 1]
  const hit = intersectSphere(origin, direction, ATMOSPHERE_RADIUS_M)
  assert.ok(hit[1] > 0)
  assert.ok(hit[1] < 200000, 'the shell is only about 100km thick')
})

test('atmosphere shader declares no texture lookups on the scattering path', () => {
  const shader = atmosphereGLSL('balanced')
  // The whole point of the rewrite: the medium density is analytic, so the march must not
  // sample a texture inside the outer or inner loop.
  const marchBody = shader.slice(shader.indexOf('vec3 ccrAtmosphere('))
  assert.doesNotMatch(marchBody, /texture\(|texelFetch\(/)
})

test('cloud tiers keep steps times light steps bounded and expose a distance limit', () => {
  for (const name of ['performance', 'balanced', 'high']) {
    const tier = cloudTier(name)
    assert.ok(tier.steps > 0 && tier.lightSteps > 0 && tier.maxDistance > 0)
    assert.ok(tier.steps * tier.lightSteps <= 1024, `${name} product too large`)
  }
  // Higher tiers must actually cost more, otherwise the tier is decorative.
  assert.ok(cloudTier('performance').steps < cloudTier('balanced').steps)
  assert.ok(cloudTier('balanced').steps < cloudTier('high').steps)
  assert.deepEqual(cloudTier('unknown'), CLOUD_TIERS.balanced)
})

test('cloud sunlight integrates the same density field as the view ray', () => {
  const shader = cloudGLSL('balanced')
  assert.match(shader, /#define CLOUD_STEPS 96/)
  assert.match(shader, /#define CLOUD_LIGHT_STEPS 6/)
  // Integrate continuous optical depth rather than counting occupied light samples.
  assert.match(shader, /opticalDepth \+= ccrCloudDensity\(samplePosition\) \* stepLength/)
  const sunBody = shader.slice(shader.indexOf('float ccrCloudSunOpticalDepth'), shader.indexOf('float ccrCloudSunVisibility'))
  assert.match(sunBody, /ccrCloudShellIntervals\(position, sunDirectionAtmo, 1\.0e9\)/)
  assert.match(sunBody, /ccrCloudOpticalDepth\(position, sunDirectionAtmo, intervals\)/)
  assert.doesNotMatch(sunBody, /inside \+=|> 0\.35/)
})

test('cloud spherical boundaries use planet-centred altitude and local ground normals', () => {
  const shader = cloudGLSL('balanced')
  // The atmosphere and the cloud now share one planet-centred frame, so altitude is the distance
  // from the planet centre minus the radius. A raw z comparison would only hold on the equator.
  assert.match(shader, /float ccrCloudAltitude\(vec3 position\)/)
  assert.match(shader, /return length\(position - CCR_PLANET_POS\) - atmosphereParams\.x/)
  assert.match(shader, /ccrCloudDensity\(samplePosition\)/)
  assert.doesNotMatch(shader, /cloudParams\.y\s*<\s*position\.z|position\.z\s*>\s*cloudParams\.z/)
  assert.match(shader, /ccrAtmosphereIntersect\(centredOrigin, direction, atmosphereParams\.x \+ cloudParams\.z\)/)
  assert.match(shader, /ccrAtmosphereIntersect\(centredOrigin, direction, atmosphereParams\.x \+ cloudParams\.y\)/)
  // Ground bounce uses the local normal; sunlight follows the spherical interval.
  assert.match(shader, /vec3 up = normalize\(position - CCR_PLANET_POS\)/)
  assert.match(shader, /ccrCloudShellIntervals\(position, -up, 1\.0e9\)/)
  assert.doesNotMatch(shader, /sunVertical|distanceToTop/)
})

test('cloud march covers clipped shell intervals and weights radiance by extinction', () => {
  const shader = cloudGLSL('balanced')
  assert.match(shader, /float limit = min\(max\(sceneDistance, 0\.0\), viewRange\)/)
  assert.match(shader, /float stepLength = pathLength \/ float\(CLOUD_STEPS\)/)
  assert.match(shader, /ccrCloudIntervalDistance\(intervals, pathDistance\)/)
  assert.match(shader, /if \(density <= 0\.0\) continue/)
  assert.doesNotMatch(shader, /stepLength \*=/)
  // The source term is sigma_s * L. With unit albedo sigma_s/sigma_t cancels.
  assert.match(shader, /float sampleWeight = transmittance \* \(1\.0 - stepTransmittance\)/)
  assert.match(shader, /accumulated \+= lighting \* sampleWeight/)
  assert.match(shader, /transmittance \*= stepTransmittance/)
})

test('every tier covers the whole interval within its finite sampling budget', () => {
  const performance = cloudGLSL('performance')
  const high = cloudGLSL('high')
  // Each tier divides the entire occupied path by its finite sample count.
  assert.match(performance, /#define CLOUD_STEPS 24/)
  assert.match(high, /#define CLOUD_STEPS 128/)
  for (const shader of [performance, high]) {
    assert.match(shader, /stepLength = pathLength \/ float\(CLOUD_STEPS\)/)
    assert.match(shader, /for \(int i = 0; i < CLOUD_STEPS \* 2; i\+\+\)/)
  }
})

test('empty spherical intervals return identity transport without dividing by a zero path', () => {
  const shader = cloudGLSL('balanced')
  assert.match(shader, /if \(finish <= start\) return vec4\(0\.0\)/)
  assert.match(shader, /return max\(intervals\.y - intervals\.x, 0\.0\) \+ max\(intervals\.w - intervals\.z, 0\.0\)/)
  assert.match(shader, /if \(stepLength <= 0\.0\) return 0\.0/)
  const march = shader.slice(shader.indexOf('vec4 ccrCloudMarch'), shader.indexOf('vec2 ccrCloudGeometry'))
  assert.match(march, /cloudDistance = sceneDistance/)
  assert.match(march, /if \(pathLength <= 0\.0\) return vec4\(0\.0, 0\.0, 0\.0, 1\.0\)/)
  assert.ok(march.indexOf('if (pathLength <= 0.0)') < march.indexOf('pathLength / float(CLOUD_STEPS)'))
})

test('color and geometry share density, temporal jitter and extinction-weighted metric depth', () => {
  const shader = cloudGLSL('balanced')
  assert.match(shader, /if \(cloudFrame\.y < 0\.5\) return 0\.5/)
  assert.match(shader, /float jitter = ccrCloudJitter\(\)/)
  assert.match(shader, /ccrCloudMarch\(origin, direction, sceneDistance, false, cloudDistance\)/)
  assert.match(shader, /ccrCloudMarch\(origin, direction, sceneDistance, true, cloudDistance\)/)
  assert.match(shader, /weightedDistance \+= distanceAlongRay \* sampleWeight/)
  assert.match(shader, /cloudDistance = weightSum > 0\.0 \? weightedDistance \/ weightSum : sceneDistance/)
  assert.match(shader, /return vec2\(cloudDistance, transport\.a\)/)
})
