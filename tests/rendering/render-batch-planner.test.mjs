import test from 'node:test'
import assert from 'node:assert/strict'
import { planRenderBatches143 } from '../../src/renderer/RenderBatchPlanner143.js'

const item = (nativeOrderKey, overrides = {}) => ({
  pass: 'transparent.forward', frustumIndex: 0, passIndex: 1, framebufferKey: 'fb',
  pipelineKey: 'pipe', materialKey: 'mat', nativeOrderKey, ...overrides
})

test('batch planner merges only compatible continuous native-order items', () => {
  const result = planRenderBatches143([item(1), item(2), item(3, { materialKey: 'other' })])
  assert.equal(result.correctness, 'pass')
  assert.equal(result.noRegression, 'pass')
  assert.equal(result.batchCount, 2)
  assert.equal(result.optimizationSuccess, 'pass')
  assert.equal(result.batches[0].items.length, 2)
})

test('transparent planner reports native-order regression instead of sorting it away', () => {
  const result = planRenderBatches143([item(2), item(1)])
  assert.equal(result.correctness, 'fail')
  assert.equal(result.noRegression, 'fail')
})

test('batch planner preserves framebuffer and pass boundaries', () => {
  const result = planRenderBatches143([item(1), item(2, { framebufferKey: 'other' }), item(3, { passIndex: 2 })])
  assert.equal(result.batchCount, 3)
  assert.equal(result.inputCount, 3)
  assert.equal(result.noRegression, 'pass')
  assert.equal(result.optimizationSuccess, 'not-achieved')
})
