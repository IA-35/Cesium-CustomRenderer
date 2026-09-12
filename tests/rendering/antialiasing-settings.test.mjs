import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeAntiAliasing, selectMsaaSamples } from '../../src/antialiasing/settings143.js'

test('AA defaults use native pixels and reject invalid quality settings', () => {
  const result = normalizeAntiAliasing({ antialiasing: 'tsr', msaaSamples: 99, resolutionMode: 'auto', resolutionScale: Infinity })
  assert.deepEqual(result, { antialiasing: 'smaa', msaaSamples: 1, resolutionMode: 'native', resolutionScale: 1 })
  assert.equal(normalizeAntiAliasing({ resolutionScale: 0.1 }).resolutionScale, 0.5)
  assert.equal(normalizeAntiAliasing({ antialiasing: 'msaa', msaaSamples: 8 }).msaaSamples, 8)
})

test('MSAA selection intersects real color and depth format support rather than trusting a global limit', () => {
  const gl = { RENDERBUFFER: 1, SAMPLES: 2, MAX_SAMPLES: 3, RGBA16F: 4, RGBA32F: 5, RGBA8: 6, DEPTH24_STENCIL8: 7,
    getParameter: () => 8, getInternalformatParameter: (target, format) => format === 4 ? new Int32Array([4, 2]) : new Int32Array([8, 4]) }
  const scene = { highDynamicRange: true, msaaSupported: true, context: { webgl2: true, halfFloatingPointTexture: true, _gl: gl } }
  assert.equal(selectMsaaSamples(scene, 8).selected, 4)
  assert.equal(selectMsaaSamples(scene, 2).selected, 1)
  assert.equal(selectMsaaSamples(scene, 1).selected, 1)
  assert.equal(selectMsaaSamples({ msaaSupported: false }, 4).selected, 1)
})
