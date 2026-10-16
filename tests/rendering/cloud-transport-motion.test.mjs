import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveCloudMotion } from '../../src/environment/cloudMotion143.js'

const periods = { weather: [32000,32000,32000], shape: [16000,16000,16000], detail: [1200,1200,1200] }
const wrap = (value, period) => ((value % period) + period) % period
const near = (actual, expected, tolerance = 1e-7) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`)

test('each cloud field wraps its own physical period after independent evolution', () => {
  for (const seconds of [-32001, -8001, 0, 25, 7999, 8000, 8001, 32000, 32001]) {
    const motion = resolveCloudMotion(seconds)
    const x = seconds * 8, y = seconds * 2, evolution = Math.sqrt(68) * Math.abs(seconds) * .25
    const expected = {
      weather: [wrap(x * .37, 32000), wrap(y * .37, 32000), 0],
      shape: [wrap(x, 16000), wrap(y, 16000), wrap(-evolution, 16000)],
      detail: [wrap(x * 1.73, 1200), wrap(y * 1.73, 1200), 0]
    }
    for (const field of Object.keys(periods)) {
      motion[field].forEach((value, axis) => near(value, expected[field][axis]))
      assert.ok(motion[field].every((value,axis) => value >= 0 && value < periods[field][axis]))
    }
    motion.displacement.forEach((value, axis) => near(value, [0 - x, 0 - y, evolution][axis]))
  }
})

test('noise phase remains continuous across the former shared 64000 metre wrap', () => {
  const epsilon = .001
  for (const seconds of [8000, 32000]) {
    const before = resolveCloudMotion(seconds - epsilon), after = resolveCloudMotion(seconds + epsilon)
    for (const [field, axisPeriods] of Object.entries(periods)) {
      for (let axis = 0; axis < 3; axis++) {
        // Shortest periodic phase difference must agree with the unwrapped field's
        // travel over 2 ms, rather than inheriting a shared-wind reset.
        const period = axisPeriods[axis]
        const phaseDelta = wrap(after[field][axis] - before[field][axis] + period * .5, period) - period * .5
        const velocity = field === 'weather' ? [8 * .37, 2 * .37, 0][axis]
          : field === 'detail' ? [8 * 1.73, 2 * 1.73, 0][axis]
            : [8, 2, -Math.sqrt(68) * .25][axis]
        near(phaseDelta, velocity * epsilon * 2)
      }
    }
    after.displacement.forEach((value, axis) => near(value - before.displacement[axis],
      [-8, -2, Math.sqrt(68) * .25][axis] * epsilon * 2))
  }
})

test('disabling motion freezes every offset and unwrapped reprojection displacement', () => {
  assert.deepEqual(resolveCloudMotion(32000, false), {
    weather: [0, 0, 0], shape: [0, 0, 0], detail: [0, 0, 0], displacement: [0, 0, 0]
  })
})
