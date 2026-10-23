// Analysis of consecutive commands only. Execution and measured GL counters live elsewhere.
import { framebufferKeyOf143 } from './RenderItem143.js'

export const BATCH_KEY_FIELDS = Object.freeze([
  'pass', 'sourcePass', 'frustumIndex', 'passIndex', 'framebufferKey', 'shaderSourceId',
  'injectedVariant', 'renderStateId', 'framebufferLayout', 'textureLayout', 'featureFlags'
])

function text(value) { return value == null ? '' : String(value) }
const targetKey = item => item.framebufferKey || (item.command
  ? framebufferKeyOf143(item.command) : text(item.framebufferLayout))

// Derive the stable batch key. `shaderSourceId` falls back to the live program identity so a
// caller that does not precompute one still gets a correct (if less stable) key.
export function batchKeyOf143(item) {
  return JSON.stringify([
    text(item.pass), text(item.sourcePass), item.frustumIndex ?? 0, item.passIndex ?? 0,
    targetKey(item),
    text(item.shaderSourceId || item.shaderKey || item.command?.shaderProgram?.id),
    text(item.injectedVariant),
    text(item.renderStateKey ?? item.renderStateId ?? item.command?.renderState?.id),
    text(item.framebufferLayout),
    text(item.textureLayout || item.textureLayoutKey),
    text(item.featureFlags)
  ])
}

export function planRenderBatches143(items = [], { pass = null } = {}) {
  const filtered = items.filter(item => !pass || item.pass === pass)
  const ordered = filtered
  const batches = []
  let current = null
  let previousOrder = null
  for (const item of ordered) {
    const key = batchKeyOf143(item)
    const continuous = current && !targetKey(item).startsWith('unresolved-') && current.key === key
      && (previousOrder === null || item.nativeOrderKey >= previousOrder)
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
  const plannedProgramBinds = batches.length
  const plannedStateBinds = batches.length
  // A plan has no access to executed draws or GL state transitions.
  const programBinds = null, renderStateBinds = null
  return Object.freeze({
    batches: Object.freeze(batches.map(batch => Object.freeze({ ...batch, items: Object.freeze(batch.items.slice()) }))),
    inputCount: ordered.length,
    batchCount: batches.length,
    meanBatchSize: batches.length ? ordered.length / batches.length : 0,
    // 未采样，不能用条目数冒充实际调用次数。
    programBinds,
    renderStateBinds,
    // 计划中的绑定次数上限，只有接上真正的批提交路径才会变成实际值。
    plannedProgramBinds,
    plannedStateBinds,
    programBindReduction: null,
    plannedProgramBindReduction: ordered.length ? 1 - plannedProgramBinds / ordered.length : 0,
    correctness: orderStable ? 'pass' : 'fail',
    noRegression: 'not-measured',
    optimizationSuccess: plannedProgramBinds < ordered.length ? 'planned-only' : 'not-achieved'
  })
}

export default planRenderBatches143
