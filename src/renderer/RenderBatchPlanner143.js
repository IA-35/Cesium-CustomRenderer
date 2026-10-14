import { compareRenderItems143 } from './RenderItem143.js'

export function planRenderBatches143(items = [], { pass = null } = {}) {
  const filtered = items.filter(item => !pass || item.pass === pass)
  const transparent = filtered.some(item => item.pass === 'transparent.forward' || item.sourcePass === 'translucent')
  const ordered = transparent ? filtered.slice() : filtered.slice().sort(compareRenderItems143)
  const batches = []
  let current = null
  let previousOrder = null
  for (const item of ordered) {
    const key = [item.pass, item.frustumIndex, item.passIndex, item.framebufferKey, item.pipelineKey, item.materialKey].join('|')
    const continuous = current && current.key === key && (previousOrder === null || item.nativeOrderKey >= previousOrder)
    if (!continuous) {
      current = { key, items: [] }
      batches.push(current)
    }
    current.items.push(item)
    previousOrder = item.nativeOrderKey
  }
  const flattened = batches.flatMap(batch => batch.items)
  const orderStable = flattened.every((item, index) => index === 0 || item.nativeOrderKey >= flattened[index - 1].nativeOrderKey)
  return Object.freeze({
    batches: Object.freeze(batches.map(batch => Object.freeze({ ...batch, items: Object.freeze(batch.items.slice()) }))),
    inputCount: ordered.length,
    batchCount: batches.length,
    correctness: orderStable ? 'pass' : 'fail',
    noRegression: orderStable && flattened.length === ordered.length ? 'pass' : 'fail',
    optimizationSuccess: batches.length < ordered.length ? 'pass' : 'not-achieved'
  })
}

export default planRenderBatches143
