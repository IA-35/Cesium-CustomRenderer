// CCR renderer contract for a collected Cesium command.
// RenderItem is immutable metadata; execution belongs to RenderItemExecutor143.
function text(value) { return value == null ? '' : String(value) }
function number(value, fallback = 0) { return Number.isFinite(value) ? value : fallback }
const framebufferIds = new WeakMap()
let nextFramebufferId = 0

export function framebufferKeyOf143(command, passState) {
  const target = command.framebuffer ?? passState?.framebuffer
  if (target) {
    if (!framebufferIds.has(target)) framebufferIds.set(target, `framebuffer-${++nextFramebufferId}`)
    return framebufferIds.get(target)
  }
  // Collection precedes target selection. Unknown targets cannot establish a shared batch.
  if (!passState) {
    if (!framebufferIds.has(command)) framebufferIds.set(command, `unresolved-${++nextFramebufferId}`)
    return framebufferIds.get(command)
  }
  return 'default-framebuffer'
}

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
    sourcePass: text(options.sourcePass ?? command.pass ?? pass),
    materialKey: text(options.materialKey),
    pipelineKey: text(options.pipelineKey),
    renderStateKey: text(options.renderStateKey ?? command.renderState?.id),
    framebufferKey: text(options.framebufferKey || framebufferKeyOf143(command, options.passState)),
    // Phase 6 batch key inputs. Deliberately identity/state only: no transform, colour or
    // IBL factor, because those differ per object and would defeat batching entirely.
    shaderSourceId: text(options.shaderSourceId ?? command.shaderProgram?.id),
    injectedVariant: options.injectedVariant,
    framebufferLayout: options.framebufferLayout,
    textureLayout: options.textureLayout,
    featureFlags: options.featureFlags,
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
