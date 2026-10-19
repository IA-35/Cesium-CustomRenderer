import test from 'node:test'
import assert from 'node:assert/strict'
import { planRenderBatches143, batchKeyOf143, BATCH_KEY_FIELDS } from '../../src/renderer/RenderBatchPlanner143.js'

const item = (nativeOrderKey, overrides = {}) => ({
  pass: 'transparent.forward', frustumIndex: 0, passIndex: 1, framebufferKey: 'fb',
  shaderSourceId: 'shader-a', renderStateKey: 'state-a', nativeOrderKey, ...overrides
})

test('batch key uses only program/state identity, never per-object data', () => {
  assert.deepEqual(BATCH_KEY_FIELDS, ['pass', 'shaderSourceId', 'injectedVariant', 'renderStateId', 'framebufferLayout', 'textureLayout', 'featureFlags'])
  const a = item(1, { sortKey: 5, materialKey: 'red' })
  const b = item(2, { sortKey: 99, materialKey: 'blue' })
  assert.equal(batchKeyOf143(a), batchKeyOf143(b), 'per-object colour must not split a batch')
  assert.notEqual(batchKeyOf143(a), batchKeyOf143(item(3, { shaderSourceId: 'shader-b' })))
  assert.notEqual(batchKeyOf143(a), batchKeyOf143(item(4, { renderStateKey: 'state-b' })))
})

test('batch planner merges only compatible continuous native-order items', () => {
  const result = planRenderBatches143([item(1), item(2), item(3, { shaderSourceId: 'shader-b' })])
  assert.equal(result.correctness, 'pass')
  assert.equal(result.noRegression, 'pass')
  assert.equal(result.batchCount, 2)
  assert.equal(result.batches[0].items.length, 2)
  assert.equal(result.meanBatchSize, 1.5)
  // 计划 2 次绑定，实际仍逐条提交 = 3 次。
  assert.equal(result.plannedProgramBinds, 2)
  assert.equal(result.programBinds, 3)
})

test('transparent planner reports native-order regression instead of sorting it away', () => {
  const result = planRenderBatches143([item(2), item(1)])
  assert.equal(result.correctness, 'fail')
  assert.equal(result.noRegression, 'fail')
})

test('batch planner preserves framebuffer and pass boundaries', () => {
  const result = planRenderBatches143([item(1), item(2, { pass: 'opaque.forward', framebufferLayout: 'other' }), item(3, { passIndex: 2, pass: 'transparent.forward' })])
  assert.equal(result.noRegression, 'pass')
  assert.equal(result.inputCount, 3)
  assert.ok(result.batchCount >= 2)
})

test('planner states real binds, not the planned upper bound, as achieved', () => {
  const four = [item(1), item(2), item(3), item(4)]
  const grouped = planRenderBatches143(four)
  assert.equal(grouped.batchCount, 1)
  // 实际：逐条经 Cesium `Context.beginDraw` 各自 `_bind()` → 4 次。
  assert.equal(grouped.programBinds, 4)
  assert.equal(grouped.programBindReduction, 0)
  // 计划：一批只需 1 次 → 0.75，但它只是上限。
  assert.equal(grouped.plannedProgramBinds, 1)
  assert.equal(grouped.plannedProgramBindReduction, 0.75)
  // 没有生产调用点，所以不得报告为已达成。
  assert.equal(grouped.optimizationSuccess, 'planned-only')
  const split = planRenderBatches143(four.map((entry, index) => ({ ...entry, shaderSourceId: 'shader-' + index })))
  assert.equal(split.programBindReduction, 0)
  assert.equal(split.plannedProgramBindReduction, 0)
  assert.equal(split.optimizationSuccess, 'not-achieved')
})
