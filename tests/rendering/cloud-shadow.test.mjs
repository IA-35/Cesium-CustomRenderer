import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'

const url = new URL('../../src/environment/cloudShadow143.js', import.meta.url)
const available = existsSync(url)
test('cloud receiver shadows have a shared transport integration module', () => {
  assert.ok(available, 'cloudShadow143.js must provide the receiver integration')
})
const module = available ? await import(url) : null
const receiver = overrides => module.cloudShadowTransmission({
  visibility: 0, validSurface: true, surfaceDistance: 100, maxReceiverDistance: 50000,
  normalDotSun: 1, sunIrradiance: [8, 8, 8], skyIrradiance: [2, 2, 2], ...overrides
})
const close = (actual, expected) => actual.forEach((value, index) => {
  assert.ok(Math.abs(value - expected[index]) < 1e-12, `${actual} != ${expected}`)
})

test('zero cloud extinction leaves the receiver unchanged', { skip: !available }, () => {
  close(receiver({ visibility: 1 }), [1, 1, 1])
})
test('no sunlight or a back-facing normal leaves ambient unchanged', { skip: !available }, () => {
  close(receiver({ sunIrradiance: [0, 0, 0] }), [1, 1, 1])
  close(receiver({ normalDotSun: -0.5 }), [1, 1, 1])
})
test('sky, invalid depth and receivers beyond the metric range are excluded', { skip: !available }, () => {
  for (const overrides of [{ validSurface: false }, { surfaceDistance: 0 },
    { surfaceDistance: 1e9 }, { surfaceDistance: -1 }, { maxReceiverDistance: 0 }]) {
    close(receiver(overrides), [1, 1, 1])
  }
})
test('opaque clouds retain the estimated diffuse sky contribution in every channel', { skip: !available }, () => {
  close(receiver({ sunIrradiance: [8, 6, 2], skyIrradiance: [2, 4, 8] }), [0.2, 0.4, 0.8])
  close(receiver({ normalDotSun: 0.25 }), [0.5, 0.5, 0.5])
})
test('transmission remains bounded for out-of-range cloud visibility', { skip: !available }, () => {
  close(receiver({ visibility: -10 }), [0.2, 0.2, 0.2])
  close(receiver({ visibility: 10 }), [1, 1, 1])
})

test('receiver shadow tends continuously to identity before the distance cutoff', () => {
  const distances=[100,35000,40000,45000,49000,49999,50000,50001]
  const factors=distances.map(surfaceDistance=>receiver({surfaceDistance})[0])
  assert.equal(factors[0],factors[1])
  assert.ok(factors[4]>0.98)
  assert.ok(1-factors[5]<1e-7)
  assert.equal(factors[6],1)
  assert.equal(factors[7],1)
  assert.ok(factors.every((factor,i)=>i===0||factor>=factors[i-1]))
})
test('an exact direct term preserves ambient, emissive, reflections and scene alpha', { skip: !available }, () => {
  close(module.cloudShadowDirect([15, 10, 8, 0.35], [10, 6, 2], 0), [5, 4, 6, 0.35])
  close(module.cloudShadowDirect([15, 10, 8, 0.35], [10, 6, 2], 0.5), [10, 7, 7, 0.35])
  close(module.cloudShadowDirect([15, 10, 8, 0.35], [10, 6, 2], 1), [15, 10, 8, 0.35])
})
test('GLSL samples the shared density from the surface and keeps scene alpha', { skip: !available }, () => {
  const shader = module.cloudShadowGLSL()
  assert.match(shader, /ccrCloudSunVisibility\(positionAtmo\)/)
  assert.match(shader, /!validSurface \|\| !\(surfaceDistance > 0\.0 && surfaceDistance <= maxReceiverDistance\)/)
  assert.match(shader, /dot\(normalAtmo, sunDirectionAtmo\)/)
  assert.match(shader, /return vec4\(source\.rgb - boundedDirect \* \(1\.0 - clamp\(visibility, 0\.0, 1\.0\)\), source\.a\)/)
  assert.doesNotMatch(shader, /for\s*\(|uniform|noiseTexture/)
})
