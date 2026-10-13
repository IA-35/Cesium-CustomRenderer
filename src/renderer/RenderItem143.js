// CCR renderer contract for a collected Cesium command.
// RenderItem is metadata; it does not own Cesium's command or scene objects.
export function createRenderItem143(command, { pass = 'native.forward', materialKey = '', pipelineKey = '', sortKey = 0, frameState = null } = {}) {
  if (!command) throw new Error('RenderItem143 requires a Cesium command')
  return Object.freeze({
    command,
    pass,
    materialKey: String(materialKey),
    pipelineKey: String(pipelineKey),
    sortKey: Number.isFinite(sortKey) ? sortKey : 0,
    frameNumber: frameState?.frameNumber ?? null,
    source: 'cesium.draw-command',
  })
}

export function compareRenderItems143(a, b) {
  return a.sortKey - b.sortKey || a.pipelineKey.localeCompare(b.pipelineKey) || a.materialKey.localeCompare(b.materialKey)
}

export function sortRenderItems143(items) {
  return [...items].sort(compareRenderItems143)
}
