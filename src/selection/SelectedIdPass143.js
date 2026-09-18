// Reuse the native silhouette and its pick shaders. Only the redundant opaque
// occluder redraw is replaced, by copying the depth already rendered this frame.
export function selectedOwners(C, selected) {
  const models = new Set(), tilesets = new Set()
  for (const item of selected) {
    if (item instanceof C.Model) models.add(item)
    else if (item instanceof C.Cesium3DTileset) tilesets.add(item)
    else if (item instanceof C.Cesium3DTileFeature && item.content?._model) models.add(item.content._model)
    else return null
  }
  return selected.length ? { models, tilesets } : null
}

export function keepIdCommand(C, command, owners) {
  if (!owners || command.pass === C.Pass.TRANSLUCENT || command.renderState?.depthMask !== true ||
      command.renderState?.depthTest?.enabled !== true) return true
  const owner = command.owner
  return owners.models.has(owner) || owners.tilesets.has(owner?.content?.tileset)
}

function collectSelected(stage, selected) {
  if (!stage || stage.enabled === false) return
  if (stage.selected) selected.push(...stage.selected)
  if (typeof stage.length === 'number') for (let i = 0; i < stage.length; i++) collectSelected(stage.get(i), selected)
}

export default class SelectedIdPass143 {
  constructor(C, scene, active = () => true) {
    this.C = C; this.scene = scene; this.active = active; this.enabled = true
    this.stats = { skipped: 0, drawn: 0, copies: 0, reason: 'not requested' }
    const context = scene.context, previous = context.draw, pass = this
    this.previous = previous
    this.hook = function(command, passState, ...args) {
      if (!scene._environmentState?.usePostProcessSelected) {
        pass.owners = null
        return previous.call(this, command, passState, ...args)
      }
      if (pass.dead || !pass.enabled || !active() || !scene.frameState.passes.render ||
          scene.frameState.passes.pick || scene.frameState.passes.pickVoxel) return previous.call(this, command, passState, ...args)
      const id = scene._view?.sceneFramebuffer?.idFramebuffer
      if (!id || (command.framebuffer || passState?.framebuffer) !== id) return previous.call(this, command, passState, ...args)
      if (pass.frame !== scene.frameState.frameNumber) pass.prepare(id)
      if (pass.owners && !keepIdCommand(C, command, pass.owners)) { pass.stats.skipped++; return }
      pass.stats.drawn++
      return previous.call(this, command, passState, ...args)
    }
    context.draw = this.hook
  }

  prepare(id) {
    const s = this.scene, state = s._environmentState, context = s.context, view = s._view
    this.frame = s.frameState.frameNumber; this.owners = null
    this.stats.skipped = 0; this.stats.drawn = 0
    this.stats.reason = 'native fallback: depth scope'
    if (!context.webgl2 || s.mode !== this.C.SceneMode.SCENE3D || view.frustumCommandsList.length !== 1 ||
        s.msaaSamples !== 1 || s.useWebVR || s.debugCommandFilter || state.clearGlobeDepth || state.useInvertClassification ||
        s._globeTranslucencyState?.translucent) return
    const selected = []; collectSelected(s.postProcessStages, selected)
    const owners = selectedOwners(this.C, selected)
    if (!owners) { this.stats.reason = 'native fallback: selection type'; return }
    const source = state.useGlobeDepthFramebuffer ? view.globeDepth?.framebuffer : view.sceneFramebuffer.framebuffer
    const depth = source?.depthStencilTexture, target = id.depthStencilTexture
    if (!depth || !target || source === id || depth.width !== target.width || depth.height !== target.height ||
        depth.pixelFormat !== target.pixelFormat || depth.pixelDatatype !== target.pixelDatatype) return
    const gl = context._gl, read = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING), draw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)
    const scissor = gl.isEnabled(gl.SCISSOR_TEST)
    try {
      gl.disable(gl.SCISSOR_TEST)
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, source._framebuffer)
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, id._framebuffer)
      gl.blitFramebuffer(0, 0, depth.width, depth.height, 0, 0, depth.width, depth.height, gl.DEPTH_BUFFER_BIT, gl.NEAREST)
    } finally {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, draw)
      if (scissor) gl.enable(gl.SCISSOR_TEST)
    }
    this.owners = owners; this.stats.reason = null; this.stats.copies++
  }

  destroy() {
    if (this.dead) return
    this.dead = true; this.owners = null
    if (this.scene.context.draw === this.hook) this.scene.context.draw = this.previous
  }

  getDiagnostics() {
    const current = this.frame === this.scene.frameState?.frameNumber
    const reason = this.dead ? 'destroyed' : !this.enabled || !this.active() ? 'inactive'
      : !current ? 'no ID pass this frame' : this.stats.reason
    return { ...this.stats, frameNumber: this.frame, active: reason === null, reason }
  }
}
