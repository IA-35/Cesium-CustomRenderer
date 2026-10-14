// Phase 6: material / shader-program batching.
//
// A batch is a maximal run of consecutive RenderItems whose program, render state and
// binding layout are identical, so one program bind and one state bind can serve every
// item in it. Two rules keep that safe:
//
//   1. The key never contains per-object data (transform, colour, IBL factor). Those stay
//      per-item uniform updates; folding them into the key would make every object its own
//      batch and the batching would do nothing.
//   2. Items are only merged inside a continuous native-order run. Transparent items keep
//      Cesium's own ordering, so a batch may never reorder across a blend/depth boundary.
import { compareRenderItems143 } from './RenderItem143.js'

export const BATCH_KEY_FIELDS = Object.freeze([
  'pass', 'shaderSourceId', 'injectedVariant', 'renderStateId', 'framebufferLayout', 'textureLayout', 'featureFlags'
])

function text(value) { return value == null ? '' : String(value) }

// Derive the stable batch key. `shaderSourceId` falls back to the live program identity so a
// caller that does not precompute one still gets a correct (if less stable) key.
export function batchKeyOf143(item) {
  return [
    text(item.pass),
    text(item.shaderSourceId ?? item.shaderKey ?? item.command?.shaderProgram?.id),
    text(item.injectedVariant),
    text(item.renderStateKey ?? item.renderStateId ?? item.command?.renderState?.id),
    text(item.framebufferLayout ?? item.framebufferKey),
    text(item.textureLayout ?? item.textureLayoutKey),
    text(item.featureFlags)
  ].join('|')
}

export function planRenderBatches143(items = [], { pass = null } = {}) {
  const filtered = items.filter(item => !pass || item.pass === pass)
  const transparent = filtered.some(item => item.pass === 'transparent.forward' || item.sourcePass === 'translucent')
  // Transparent keeps the order Cesium established; opaque may be sorted to group programs.
  const ordered = transparent ? filtered.slice() : filtered.slice().sort(compareRenderItems143)
  const batches = []
  let current = null
  let previousOrder = null
  for (const item of ordered) {
    const key = batchKeyOf143(item)
    const continuous = current && current.key === key && (previousOrder === null || item.nativeOrderKey >= previousOrder)
    if (!continuous) {
      current = { key, items: [], firstNativeOrderKey: item.nativeOrderKey }
      batches.push(current)
    }
    current.items.push(item)
    current.lastNativeOrderKey = item.nativeOrderKey
    previousOrder = item.nativeOrderKey
  }
  const flattened = batches.flatMap(batch => batch.items)
  const orderStable = flattened.every((item, index) => index === 0 || item.nativeOrderKey >= flattened[index - 1].nativeOrderKey)
  const programBinds = batches.length
  const renderStateBinds = new Set(batches.map(batch => batch.key.split('|')[3])).size
  return Object.freeze({
    batches: Object.freeze(batches.map(batch => Object.freeze({ ...batch, items: Object.freeze(batch.items.slice()) }))),
    inputCount: ordered.length,
    batchCount: batches.length,
    meanBatchSize: batches.length ? ordered.length / batches.length : 0,
    programBinds,
    renderStateBinds,
    // Savings are stated against the unbatchable baseline: one bind per item.
    programBindReduction: ordered.length ? 1 - programBinds / ordered.length : 0,
    correctness: orderStable ? 'pass' : 'fail',
    noRegression: orderStable && flattened.length === ordered.length ? 'pass' : 'fail',
    optimizationSuccess: batches.length < ordered.length ? 'pass' : 'not-achieved'
  })
}

export default planRenderBatches143
