import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeEnvironmentOptions, resolveEnvironmentState } from '../../src/environment/environmentState.js'

test('environment settings reject invalid modes and bound density controls without changing input', () => {
  const input = { environmentPreset: 'unknown', skyLightIntensity: 200, cloudCoverage: -1, sunIntensity: NaN }
  const result = normalizeEnvironmentOptions(input)
  assert.equal(result.environmentPreset, 'clear')
  assert.equal(result.skyLightIntensity, 5)
  assert.equal(result.cloudCoverage, 0)
  assert.equal(result.sunIntensity, 2.2)
  assert.equal(input.skyLightIntensity, 200)
})

test('night has no direct sunlight while daytime keeps a positive sky contribution', () => {
  const night = resolveEnvironmentState({}, -0.3, 0)
  const day = resolveEnvironmentState({}, 0.7, 0)
  assert.equal(night.sunIntensity, 0)
  assert.ok(day.sunIntensity > 1.5)
  assert.ok(day.skyRadiance.every((v, i) => v > night.skyRadiance[i]))
})

test('morning fog concentrates near ground and overcast chooses a separate cloud density model', () => {
  const clear = resolveEnvironmentState({}, 0.4, 0)
  const morning = resolveEnvironmentState({ environmentPreset: 'morning' }, 0.4, 0)
  const overcast = resolveEnvironmentState({ environmentPreset: 'overcast' }, 0.4, 0)
  assert.ok(morning.fogDensity > clear.fogDensity)
  assert.ok(morning.fogScaleHeight < clear.fogScaleHeight)
  assert.equal(overcast.cloudModel, 'stratus')
  assert.ok(overcast.cloudCoverage > clear.cloudCoverage)
})

test('wind uses simulation time, can be frozen, and only wraps at a periodic noise boundary', () => {
  const first = resolveEnvironmentState({}, 0.4, 100)
  const next = resolveEnvironmentState({}, 0.4, 110)
  assert.notDeepEqual(first.windOffset, next.windOffset)
  assert.deepEqual(resolveEnvironmentState({ environmentAnimation: false }, 0.4, 110).windOffset, [0, 0])
  assert.ok(resolveEnvironmentState({}, 0.4, 1e10).windOffset.every(v => Number.isFinite(v) && Math.abs(v) < 64000))
})

test('explicit fog and cloud heights override presets while retaining positive layer thickness', () => {
  const state = resolveEnvironmentState({ fogBaseHeight: -980, fogHeightFalloff: 80, cloudBaseHeight: 200, cloudThickness: 400 }, 0.5, 0)
  assert.equal(state.fogBaseHeight, -980)
  assert.equal(state.fogScaleHeight, 80)
  assert.equal(state.cloudBase, 200)
  assert.equal(state.cloudTop, 600)
  assert.equal(resolveEnvironmentState({ cloudThickness: -20 }, 0.5, 0).cloudTop, 1700)
})
