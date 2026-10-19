import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import * as port from '../../src/antialiasing/taaR186Math143.js'

// The oracle below is independently expanded from fixed r186 TSL, rather than
// using the port to calculate its own expected values.
const shader = await readFile(new URL('../../src/antialiasing/taaShaders143.js', import.meta.url), 'utf8')
const near = (actual, expected, tolerance = 1e-12) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`)
const call = (name, ...args) => {
  assert.equal(typeof port[name], 'function', `r186 ${name} has not been ported`)
  return port[name](...args)
}
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

test('CCR adaptations retain the r186 resolve core and do not revive the withdrawn blend block', () => {
  assert.match(shader, /float currentWeight = acquisitionAge/)
  assert.match(shader, /vec4 currentColor = taaCurrent\(uv\)/)
  assert.match(shader, /taaHistory\(historyUV, expectedPreviousEyeDepth\)/)
  assert.doesNotMatch(shader, /u_staticFrames|u_taaVariance|YCoCg|rejectionScale/)
  assert.match(shader, /return taaClipAABB/)
  assert.match(shader, /taaFlickerReduction\(currentColor, clippedHistoryColor, currentWeight\)/)
})

test('history invalidation obeys bounds, edge exception and mandatory lifecycle gates', () => {
  const base = { historyUv: [0.5, 0.5], closestDepth: 0.8, farthestDepth: 0.8, previousDepth: 0.7 }
  assert.equal(call('r186HistoryValid', base), false)
  assert.equal(call('r186HistoryValid', { ...base, farthestDepth: 0.802 }), true)
  assert.equal(call('r186HistoryValid', { ...base, farthestDepth: 0.802, globalValid: false }), false)
  assert.equal(call('r186HistoryValid', { ...base, farthestDepth: 0.802, localValid: false }), false)
  assert.equal(call('r186HistoryValid', { ...base, farthestDepth: 0.802, historyUv: [-0.001, 0.5] }), false)
  assert.equal(call('r186HistoryValid', { ...base, closestDepth: 0.7, previousDepth: 0.8 }), true)
})

test('subpixel weights preserve floor-based fract for positive and negative phase', () => {
  for (const pixels of [[0, 0], [0.5, 0.5], [-0.5, -0.5], [-1.25, 0.75], [1.25, -0.75], [128, 0]]) {
    const phase = pixels.map(value => Math.abs(value - Math.floor(value)))
    const product = phase.map(value => Math.max(value, 1 - value)).reduce((a, b) => a * b)
    const expected = Math.min(1, 0.05 + 0.25 * (1 - product) / 0.75 + Math.min(1, Math.hypot(...pixels) / 128))
    near(call('r186CurrentWeight', pixels.map(value => value / 256), [256, 256], true), expected)
    near(call('r186CurrentWeight', pixels.map(value => value / 256), [256, 256], false), 1)
  }
  near(call('r186CurrentWeight', [0.5 / 256, 0], [256, 256], true, 128, false), 0.05 + 0.5 / 128)
})

test('variance gamma uses squared remaining motion with official endpoints', () => {
  near(call('r186VarianceGamma', 0), 1)
  near(call('r186VarianceGamma', 0.5), 0.625)
  near(call('r186VarianceGamma', 1), 0.5)
})

test('variance clips along the RGB AABB ray without clamping HDR to one', () => {
  const neighbors = Array.from({ length: 9 }, (_, i) => [i + 2, i * 2 + 3, 12 - i, 1])
  const history = [60, 15, 3, 1]
  const mean = [6, 11, 8, 1]
  const sigma = [Math.sqrt(20 / 3), Math.sqrt(80 / 3), Math.sqrt(20 / 3), 0]
  const gamma = 0.625
  const ratio = Math.max(...history.slice(0, 3).map((value, i) => Math.abs(value - mean[i]) / (sigma[i] * gamma + 1e-7)))
  const expected = history.map((value, i) => mean[i] + (value - mean[i]) / ratio)
  const actual = call('r186VarianceClip', neighbors, history, gamma)
  actual.forEach((value, i) => near(value, expected[i]))
  assert.ok(actual[0] > 1)
})

test('flickerReduction uses compressed luminance only for weights and retains HDR energy', () => {
  const current = [16, 4, 2, 1], history = [2, 8, 20, 1], weight = 0.3
  const luma = color => (color[0] * 0.2126 + color[1] * 0.7152 + color[2] * 0.0722) / (1 + Math.max(...color.slice(0, 3)))
  const a = weight / (1 + luma(current)), b = (1 - weight) / (1 + luma(history))
  const expected = current.map((value, i) => (value * a + history[i] * b) / (a + b))
  const actual = call('r186FlickerReduction', current, history, weight)
  actual.forEach((value, i) => near(value, expected[i]))
  const constant = call('r186FlickerReduction', current, current, 0.05)
  constant.forEach((value, i) => near(value, current[i]))
  assert.ok(actual[2] > 1)
})

test('eye meters map to current perspective depth despite changed camera near/far', () => {
  for (const [n, f] of [[0.1, 1000], [10, 10000000]]) {
    near(call('r186PerspectiveDepth', n, [n, f]), 0)
    near(call('r186PerspectiveDepth', f, [n, f]), 1)
    near(call('r186PerspectiveDepth', 0, [n, f]), 1)
    near(call('r186PerspectiveDepth', 100, [n, f]), f * (100 - n) / (100 * (f - n)))
    // A transformed history point behind the current camera is not the sky.
    near(call('r186PerspectiveDepth', -100, [n, f]), f * (-100 - n) / (-100 * (f - n)))
  }
})

test('history reconstructs through previous raster inverse and current relative view', () => {
  const previousInverseRaster = [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, -1, 0, 0.2, -0.3, -1, 1]
  // Rotation makes previous raster XY relevant to current Z; translation tests w=1.
  const view = [1, 0, 0.25, 0, 0, 1, -0.5, 0, 0, 0, 1, 0, 0, 0, -7, 1]
  const uv = [0.7, 0.4], eye = 12
  const rayX = (uv[0] * 2 - 1) * 2 + 0.2
  const rayY = (uv[1] * 2 - 1) * 3 - 0.3
  const expectedEye = -(0.25 * rayX * eye - 0.5 * rayY * eye - eye - 7)
  near(call('r186PreviousDepth', eye, uv, previousInverseRaster, view, [0.1, 5000]), 5000 * (expectedEye - 0.1) / (expectedEye * 4999.9))
  near(call('r186PreviousDepth', 0, uv, previousInverseRaster, view, [0.1, 5000]), 1)
  near(call('r186PreviousDepth', eye, uv, previousInverseRaster, identity, [2, 8000]), 8000 * (eye - 2) / (eye * 7998))
})
