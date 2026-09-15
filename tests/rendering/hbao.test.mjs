import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { normalizeOptions } from '../../src/presets.js'
import ScreenSpaceAo143 from '../../src/ao/ScreenSpaceAo143.js'
const C = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')

test('AO algorithm selection defaults to SSAO and rejects unknown values', () => {
  assert.equal(normalizeOptions().screenSpaceAoAlgorithm, 'ssao')
  const current = normalizeOptions({ screenSpaceAoAlgorithm: 'hbao' })
  assert.equal(current.screenSpaceAoAlgorithm, 'hbao')
  assert.equal(normalizeOptions({ screenSpaceAoAlgorithm: 'invalid' }, current).screenSpaceAoAlgorithm, 'hbao')
})

test('AO switches algorithm without retaining old resources or changing foreign HDR settings', () => {
  const native = new C.PostProcessStageCollection(), execute = native.execute
  const options = { screenSpaceAoAlgorithm: 'ssao' }
  const scene = { context: { webgl2: true, depthTexture: true, floatingPointTexture: true, colorBufferFloat: true },
    postProcessStages: native, requestRender() {}, isDestroyed: () => false }
  const ao = new ScreenSpaceAo143(C, scene, () => null, () => options)
  ao.setEnabled(true)
  const first = ao.collection
  options.screenSpaceAoAlgorithm = 'hbao'
  ao.setEnabled(true)
  assert.equal(first.isDestroyed(), true)
  assert.equal(ao.algorithm, 'hbao')
  const second = ao.collection
  ao.setEnabled(true)
  assert.equal(ao.collection, second)
  ao.destroy()
  assert.equal(second.isDestroyed(), true)
  assert.equal(native.execute, execute)
  native.destroy()
})
