import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import {
  RAYLEIGH_BETA, MIE_BETA, ABSORPTION_BETA, RAYLEIGH_SCALE_HEIGHT, MIE_SCALE_HEIGHT,
  OZONE_CENTER_HEIGHT, OZONE_FALLOFF, MIE_G, PLANET_RADIUS_M, ATMOSPHERE_RADIUS_M, atmosphereGLSL
} from '../../src/environment/atmosphereScattering143.js'

// The reference shader is vendored verbatim so the constants below can be checked against it
// rather than against a summary. Its MIT licence text travels with the file.
const referencePath = new URL('../../src/environment/reference/shadertoy_wlBXWK.glsl', import.meta.url)
const reference = readFileSync(referencePath, 'utf8')

test('the vendored reference keeps its MIT licence and is pinned by hash', () => {
  assert.match(reference, /MIT License/)
  assert.match(reference, /Copyright \(c\) 2019 Dimas Leenman/)
  // Pinned so a silent edit of the vendored file is noticed: the porting notes quote this hash.
  const hash = createHash('sha256').update(reference).digest('hex')
  assert.equal(hash, '6944dd3e0661fa9b2c33fa22be631b61b121b3bbe1f920ec9f90fa5216b79fe7')
})

// Each expectation is parsed out of the vendored source, so the test fails if either side drifts.
function referenceVector(name) {
  const match = new RegExp(`#define ${name} vec3\\(([^)]*)\\)`).exec(reference)
  assert.ok(match, `${name} not found in the reference`)
  return match[1].split(',').map(value => Number(value.trim()))
}
function referenceNumber(name) {
  const match = new RegExp(`#define ${name} ([0-9.e+-]+)`).exec(reference)
  assert.ok(match, `${name} not found in the reference`)
  return Number(match[1])
}

test('scattering constants match the reference exactly', () => {
  assert.deepEqual(RAYLEIGH_BETA, referenceVector('RAY_BETA'))
  assert.deepEqual(ABSORPTION_BETA, referenceVector('ABSORPTION_BETA'))
  assert.equal(MIE_BETA, referenceVector('MIE_BETA')[0])
  assert.equal(MIE_G, referenceNumber('G'))
})

test('the absorption term is not the rescaled one that shipped before', () => {
  // The previous implementation rewrote this term entirely; pin the corrected values so the
  // mistake cannot return unnoticed.
  assert.deepEqual(ABSORPTION_BETA, [2.04e-5, 4.97e-5, 1.95e-6])
  assert.ok(ABSORPTION_BETA[2] < ABSORPTION_BETA[0] && ABSORPTION_BETA[2] < ABSORPTION_BETA[1],
    'the reference absorbs the least in blue; the old values had blue as the largest term')
})

test('height constants match the reference exactly', () => {
  assert.equal(RAYLEIGH_SCALE_HEIGHT, referenceNumber('HEIGHT_RAY'))
  assert.equal(MIE_SCALE_HEIGHT, referenceNumber('HEIGHT_MIE'))
  assert.equal(OZONE_CENTER_HEIGHT, referenceNumber('HEIGHT_ABSORPTION'))
  assert.equal(OZONE_FALLOFF, referenceNumber('ABSORPTION_FALLOFF'))
})

test('planet and atmosphere radii match the reference exactly', () => {
  assert.equal(PLANET_RADIUS_M, referenceNumber('PLANET_RADIUS'))
  assert.equal(ATMOSPHERE_RADIUS_M, referenceNumber('ATMOS_RADIUS'))
})

test('the shader keeps the three reference structures the port depends on', () => {
  const shader = atmosphereGLSL('balanced')
  // 1. planet_position offset (reference line 120)
  assert.match(shader, /CCR_PLANET_POS/)
  assert.match(shader, /vec3 start = origin - CCR_PLANET_POS/)
  // 2. the allow_mie guard (reference lines 139-140, applied at line 170)
  assert.match(shader, /bool allowMie = maxDist > rayLength\.y/)
  assert.match(shader, /ccrPhaseMie\(mu, sceneSampling \? atmosphereMieParameters\.y : ATMOS_MIE_G\)/)
  assert.match(shader, /ccrAtmosphereIntegral\(origin, direction, maxDist, sceneColor, transmittance, false\)/)
  // 3. scene extinction in the composite (reference line 267)
  assert.match(shader, /sceneSampling \? atmosphereSunRadiance : vec3\(CCR_ATMOSPHERE_LIGHT_INTENSITY\)/)
  assert.match(shader, /return radiance \* lightRadiance \+ sceneColor \* transmittance/)
})

test('a ray that misses the atmosphere returns the scene untouched', () => {
  const shader = atmosphereGLSL('balanced')
  // Reference lines 129 and 138 both return scene_color, not black and not transparent.
  const misses = [...shader.matchAll(/return sceneColor;/g)]
  assert.ok(misses.length >= 2, `expected both early returns to preserve the scene, found ${misses.length}`)
})

test('the ray is clipped to max_dist before the mie guard is evaluated', () => {
  const shader = atmosphereGLSL('balanced')
  // This ordering is what makes allow_mie false for geometry pixels; reversing it would silently
  // change the meaning of the guard.
  const clipIndex = shader.indexOf('min((-b + sqrt(d)) / (2.0 * a), maxDist)')
  const guardIndex = shader.indexOf('bool allowMie')
  assert.ok(clipIndex > 0 && guardIndex > 0 && clipIndex < guardIndex)
})

test('tier budgets stay bounded and are labelled as a ceiling, not the reference default', () => {
  // The reference declares PRIMARY_STEPS twice: in the HW_PERFORMANCE==0 (mobile) branch and in
  // the desktop branch. Walk the preprocessor lines explicitly, because the source writes the
  // separator as "# else" with a space and a naive split misses it.
  const lines = reference.split('\n')
  const branches = { mobile: [], desktop: [] }
  let current = null
  for (const line of lines) {
    if (/^\s*#\s*if\s+HW_PERFORMANCE\s*==\s*0/.test(line)) { current = branches.mobile; continue }
    if (/^\s*#\s*else/.test(line) && current === branches.mobile) { current = branches.desktop; continue }
    if (/^\s*#\s*endif/.test(line)) { current = null; continue }
    if (current) current.push(line)
  }
  const steps = branch => Number(/#define PRIMARY_STEPS\s+(\d+)/.exec(branch.join('\n'))[1])
  assert.equal(steps(branches.mobile), 12, 'reference mobile primary steps changed')
  assert.equal(steps(branches.desktop), 32, 'reference desktop primary steps changed')
  // CCR's tiers are a runtime budget, while the reference desktop figure is a correctness target,
  // so the two are asserted separately rather than claimed equal.
  for (const tier of ['performance', 'balanced', 'high']) {
    const shader = atmosphereGLSL(tier)
    const outer = Number(/#define ATMOS_OUTER_STEPS (\d+)/.exec(shader)[1])
    const light = Number(/#define ATMOS_LIGHT_STEPS (\d+)/.exec(shader)[1])
    assert.ok(outer * light <= 128, `${tier} nested budget ${outer * light} exceeds the ceiling`)
  }
  const balancedOuter = Number(/#define ATMOS_OUTER_STEPS (\d+)/.exec(atmosphereGLSL('balanced'))[1])
  assert.ok(balancedOuter >= 12 && balancedOuter <= 32,
    'balanced must sit between the reference mobile and desktop budgets')
})
