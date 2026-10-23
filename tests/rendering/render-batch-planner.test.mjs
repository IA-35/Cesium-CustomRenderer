import test from 'node:test'
import assert from 'node:assert/strict'
import { planRenderBatches143, batchKeyOf143, BATCH_KEY_FIELDS } from '../../src/renderer/RenderBatchPlanner143.js'
import { createRenderItem143 } from '../../src/renderer/RenderItem143.js'

test('real framebuffer identities and pass-state fallback separate render targets', () => {
  const program = { id: 0 }, state = { id: 0 }, a = {}, b = {}
  const item = (target, passState) => createRenderItem143({ shaderProgram: program, renderState: state,
    framebuffer: target }, { passState })
  assert.notEqual(batchKeyOf143(item(a)), batchKeyOf143(item(b)))
  assert.equal(batchKeyOf143(item(a)), batchKeyOf143(item(undefined, { framebuffer: a })))
  assert.notEqual(batchKeyOf143(item(undefined, {})), batchKeyOf143(item(b)))
  assert.notEqual(batchKeyOf143({ ...item(a), framebufferLayout: 'same' }),
    batchKeyOf143({ ...item(b), framebufferLayout: 'same' }))
  assert.notEqual(batchKeyOf143(createRenderItem143({}, { framebufferKey: 'a' })),
    batchKeyOf143(createRenderItem143({}, { framebufferKey: 'b' })))
  const command = { shaderProgram: program, renderState: state }
  assert.equal(planRenderBatches143([0, 1].map(nativeOrderKey =>
    createRenderItem143(command, { nativeOrderKey }))).batchCount, 2,
  'an unresolved execution target must not establish a shared batch')
})

test('opaque plans preserve input order and never merge frustum or pass-index boundaries', () => {
  const command = { shaderProgram: { id: 1 }, renderState: { id: 2 } }
  const items = [0, 1, 2].map(i => createRenderItem143(command, { nativeOrderKey: i,
    sortKey: 3 - i, frustumIndex: i === 2 ? 1 : 0, passIndex: i === 1 ? 1 : 0, passState: {} }))
  const plan = planRenderBatches143(items)
  assert.deepEqual(plan.batches.flatMap(b => b.items), items)
  assert.equal(plan.batchCount, 3)
  assert.equal(plan.correctness, 'pass')
  assert.equal(plan.programBinds, null)
  assert.equal(plan.renderStateBinds, null)
})

const item = (nativeOrderKey, overrides = {}) => ({
  pass: 'transparent.forward', frustumIndex: 0, passIndex: 1, framebufferKey: 'fb',
  shaderSourceId: 'shader-a', renderStateKey: 'state-a', nativeOrderKey, ...overrides
})

test('batch key uses only program/state identity, never per-object data', () => {
  assert.deepEqual(BATCH_KEY_FIELDS, ['pass', 'sourcePass', 'frustumIndex', 'passIndex', 'framebufferKey', 'shaderSourceId', 'injectedVariant', 'renderStateId', 'framebufferLayout', 'textureLayout', 'featureFlags'])
  const a = item(1, { sortKey: 5, materialKey: 'red' })
  const b = item(2, { sortKey: 99, materialKey: 'blue' })
  assert.equal(batchKeyOf143(a), batchKeyOf143(b), 'per-object colour must not split a batch')
  assert.notEqual(batchKeyOf143(a), batchKeyOf143(item(3, { shaderSourceId: 'shader-b' })))
  assert.notEqual(batchKeyOf143(a), batchKeyOf143(item(4, { renderStateKey: 'state-b' })))
})

test('batch planner merges only compatible continuous native-order items', () => {
  const result = planRenderBatches143([item(1), item(2), item(3, { shaderSourceId: 'shader-b' })])
  assert.equal(result.correctness, 'pass')
  assert.equal(result.noRegression, 'not-measured')
  assert.equal(result.batchCount, 2)
  assert.equal(result.batches[0].items.length, 2)
  assert.equal(result.meanBatchSize, 1.5)
  // 分组计划不代表实际 GL 计数。
  assert.equal(result.plannedProgramBinds, 2)
  assert.equal(result.programBinds, null)
})

test('transparent planner reports native-order regression instead of sorting it away', () => {
  const result = planRenderBatches143([item(2), item(1)])
  assert.equal(result.correctness, 'fail')
  assert.equal(result.noRegression, 'not-measured')
})

test('batch planner preserves framebuffer and pass boundaries', () => {
  const result = planRenderBatches143([item(1), item(2, { pass: 'opaque.forward', framebufferLayout: 'other' }), item(3, { passIndex: 2, pass: 'transparent.forward' })])
  assert.equal(result.noRegression, 'not-measured')
  assert.equal(result.inputCount, 3)
  assert.ok(result.batchCount >= 2)
})

test('planner leaves actual binds unmeasured and reports estimates separately', () => {
  const four = [item(1), item(2), item(3), item(4)]
  const grouped = planRenderBatches143(four)
  assert.equal(grouped.batchCount, 1)
  // 规划期间未执行任何 GL 调用。
  assert.equal(grouped.programBinds, null)
  assert.equal(grouped.programBindReduction, null)
  // 计划：一批只需 1 次 → 0.75，但它只是上限。
  assert.equal(grouped.plannedProgramBinds, 1)
  assert.equal(grouped.plannedProgramBindReduction, 0.75)
  // 没有生产调用点，所以不得报告为已达成。
  assert.equal(grouped.optimizationSuccess, 'planned-only')
  const split = planRenderBatches143(four.map((entry, index) => ({ ...entry, shaderSourceId: 'shader-' + index })))
  assert.equal(split.programBindReduction, null)
  assert.equal(split.plannedProgramBindReduction, 0)
  assert.equal(split.optimizationSuccess, 'not-achieved')
})
