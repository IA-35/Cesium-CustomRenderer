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
    assert.ok(tier.steps * tier.lightSteps <= 640, `${name} product too large`)
  }
  // Higher tiers must actually cost more, otherwise the tier is decorative.
  assert.ok(cloudTier('performance').steps < cloudTier('balanced').steps)
  assert.ok(cloudTier('balanced').steps < cloudTier('high').steps)
  assert.deepEqual(cloudTier('unknown'), CLOUD_TIERS.balanced)
})

test('cloud shader replaces the previous per-step optical depth integral', () => {
  const shader = cloudGLSL('balanced')
  assert.match(shader, /#define CLOUD_STEPS 48/)
  assert.match(shader, /#define CLOUD_LIGHT_STEPS 6/)
  // The binary occlusion count from the article must be present...
  assert.match(shader, /inside \+= 1\.0/)
  // ...and the old approach of re-running a full density per light step must be gone.
  const sunBody = shader.slice(shader.indexOf('float ccrCloudSunVisibility'), shader.indexOf('float ccrCloudJitter'))
  assert.doesNotMatch(sunBody, /ccrCloudDensity\(/)
})

test('cloud slab boundaries use ellipsoid altitude, not raw z', () => {
  const shader = cloudGLSL('balanced')
  // Every slab test must go through the altitude helper; a raw `position.z` comparison against
  // the altitude bounds would be wrong away from the equator.
  assert.match(shader, /float ccrCloudAltitude\(vec3 position\)/)
  assert.match(shader, /ccrCloudProfileAtAltitude\(sampleAltitude\)/)
  assert.doesNotMatch(shader, /cloudParams\.y\s*<\s*position\.z|position\.z\s*>\s*cloudParams\.z/)
})

test('cloud march skips empty space with a growing step and integrates energy conservatively', () => {
  const shader = cloudGLSL('balanced')
  // Adapted from @takram/three-clouds: an empty sample must advance the ray by more than the
  // nominal step, otherwise most of the budget is spent re-testing air.
  assert.match(shader, /#define CLOUD_STEP_GROWTH 1\.35/)
  const emptyBranch = shader.slice(shader.indexOf('if (density <= 0.0)'), shader.indexOf('float extinction'))
  assert.match(emptyBranch, /stepLength \*= CLOUD_STEP_GROWTH/)
  assert.match(emptyBranch, /distanceAlongRay \+= stepLength/)
  // The step must advance on a hit too, and grow for the next iteration.
  assert.match(shader, /distanceAlongRay \+= stepLength;\s*\n\s*stepLength \*= CLOUD_STEP_GROWTH;/)
  // Energy-conserving form: (L - L*T)/sigma rather than L*(1 - T).
  assert.match(shader, /scatteringIntegral = \(lighting - lighting \* stepTransmittance\) \/ max\(density, 1e-6\)/)
})

test('every tier keeps the adaptive step so the iteration budget stays a ceiling', () => {
  const performance = cloudGLSL('performance')
  const high = cloudGLSL('high')
  // The tier bounds the iteration count; the adaptive step is what changes the actual sampling
  // density, so both tiers must carry the growth factor rather than a fixed step.
  assert.match(performance, /#define CLOUD_STEPS 24/)
  assert.match(high, /#define CLOUD_STEPS 80/)
  for (const shader of [performance, high]) assert.match(shader, /#define CLOUD_STEP_GROWTH 1\.35/)
})
