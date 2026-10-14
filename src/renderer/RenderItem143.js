// CCR renderer contract for a collected Cesium command.
// RenderItem is immutable metadata; execution belongs to RenderItemExecutor143.
function text(value) { return value == null ? '' : String(value) }
function number(value, fallback = 0) { return Number.isFinite(value) ? value : fallback }

export function createRenderItem143(command, options = {}) {
  if (!command) throw new Error('RenderItem143 requires a Cesium command')
  const pass = text(options.pass || 'native.forward')
  const transparent = pass === 'transparent.forward' || options.transparent === true
  const frustumIndex = number(options.frustumIndex)
  const commandIndex = number(options.commandIndex)
  const passIndex = number(options.passIndex)
  const nativeOrderKey = options.nativeOrderKey ?? ((frustumIndex * 0x100000000) + (passIndex * 0x100000) + commandIndex)
  return Object.freeze({
    command,
    pass,
    sourcePass: text(options.sourcePass || command.pass || pass),
    materialKey: text(options.materialKey),
    pipelineKey: text(options.pipelineKey),
    renderStateKey: text(options.renderStateKey || command.renderState?.id),
    framebufferKey: text(options.framebufferKey || command.framebuffer?.id),
    sortKey: number(options.sortKey),
    orderKey: options.orderKey ?? nativeOrderKey,
    nativeOrderKey,
    frustumIndex,
    passIndex,
    commandIndex,
    oitMaterialIndex: options.oitMaterialIndex ?? null,
    frameNumber: options.frameState?.frameNumber ?? null,
    source: 'cesium.draw-command',
  })
}

export function compareRenderItems143(a, b) {
  const aTransparent = a.pass === 'transparent.forward' || a.sourcePass === 'translucent'
  const bTransparent = b.pass === 'transparent.forward' || b.sourcePass === 'translucent'
  if (aTransparent !== bTransparent) return aTransparent ? 1 : -1
  if (aTransparent && bTransparent) return a.nativeOrderKey - b.nativeOrderKey || a.commandIndex - b.commandIndex || a.sortKey - b.sortKey
  return a.sortKey - b.sortKey || a.pipelineKey.localeCompare(b.pipelineKey) || a.materialKey.localeCompare(b.materialKey) || a.nativeOrderKey - b.nativeOrderKey
}

export function sortRenderItems143(items) { return [...items].sort(compareRenderItems143) }
