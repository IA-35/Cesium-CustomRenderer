// Reuse the native silhouette and its pick shaders. Only the redundant opaque
// occluder redraw is replaced, by copying the depth already rendered this frame.
export function attachSelectedStageCache(collection) {
  const records = new Map(), previous = collection.update
  const hadOwn = Object.prototype.hasOwnProperty.call(collection, 'update')
  let active = true
  const visit = stage => {
    if (!stage) return // Collection.remove leaves a hole until its next update.
    if (typeof stage.length === 'number') {
      for (let i = 0; i < stage.length; i++) visit(stage.get(i))
      return
    }
    if (records.has(stage)) return
    const record = { update: stage.update, hadOwn: Object.prototype.hasOwnProperty.call(stage, 'update') }
    record.hook = function(...args) {
      if (!active) return record.update.apply(this, args)
      const parent = this._parentSelected, length = this._parentSelectedLength, command = this._command
      // Cesium 1.143 compares the parent array itself with its cached numeric length.
      // Supply its expected sentinel only when the uploaded selection is still identical.
      const stable = parent && command && this._selectedIdTexture && parent === this._parentSelectedShadow &&
        parent.length === length && record.parent === parent && record.items?.length === parent.length &&
        parent.every((item, i) => {
          const saved = record.items[i], ids = item.pickIds
          return item === saved.item && item.pickId === saved.id && (ids
            ? ids.length === saved.ids?.length && ids.every((id, j) => id === saved.ids[j])
            : !saved.ids)
        })
      if (stable) this._parentSelectedLength = parent
      try {
        const result = record.update.apply(this, args)
        // createDrawCommand replaces the quad without releasing its old cache reference.
        if (command && this._command && command !== this._command) command.shaderProgram.destroy()
        if (!stable) {
          record.parent = parent
          record.items = parent?.map(item => ({ item, id: item.pickId, ids: item.pickIds?.slice() }))
        }
        return result
      } finally {
        if (this._parentSelectedLength === parent) this._parentSelectedLength = length
      }
    }
    stage.update = record.hook
    records.set(stage, record)
  }
  const restore = (stage, record) => {
    if (stage.update !== record.hook) return
    if (record.hadOwn) stage.update = record.update
    else delete stage.update
  }
  const update = function(...args) {
    if (active) {
      for (const [stage, record] of records) if (stage.isDestroyed?.()) {
        restore(stage, record); records.delete(stage)
      }
      visit(collection)
    }
    return previous.apply(this, args)
  }
  collection.update = update
  return () => {
    active = false
    if (collection.update === update) {
      if (hadOwn) collection.update = previous
      else delete collection.update
    }
    for (const [stage, record] of records) restore(stage, record)
    records.clear()
  }
}

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
    this.restoreStageCache = attachSelectedStageCache(scene.postProcessStages)
    const context = scene.context, dispatcher = context._ccrDrawDispatcher, previous = context.draw, pass = this
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
    if (dispatcher) this.dispatcherOff = dispatcher.addHandler(event => {
      const command=event.command,passState=event.passState
      if (!scene._environmentState?.usePostProcessSelected) { pass.owners=null; return 'continue' }
      if (pass.dead||!pass.enabled||!active()||!scene.frameState.passes.render||scene.frameState.passes.pick||scene.frameState.passes.pickVoxel) return 'continue'
      // 有调度器快照时直接比目标种类，只在每帧第一次 ID 绘制时才去取 idFramebuffer。
      if (event.target!==undefined){ if (event.target!=='selectedId') return 'continue' }
      else { const id=scene._view?.sceneFramebuffer?.idFramebuffer; if (!id||(command.framebuffer||passState?.framebuffer)!==id) return 'continue' }
      if (pass.frame!==scene.frameState.frameNumber)pass.prepare(scene._view.sceneFramebuffer.idFramebuffer)
      if (pass.owners&&!keepIdCommand(C,command,pass.owners)){pass.stats.skipped++;return 'skip'}
      pass.stats.drawn++;return 'continue'
    },{name:'selected-id',priority:-10,targets:['selectedId'],frame:{render:true,pick:false,pickVoxel:false}})
    else context.draw = this.hook
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
    this.dead = true; this.owners = null; this.dispatcherOff?.(); this.dispatcherOff = null
    this.restoreStageCache()
    if (this.scene.context.draw === this.hook) this.scene.context.draw = this.previous
  }

  getDiagnostics() {
    const current = this.frame === this.scene.frameState?.frameNumber
    const reason = this.dead ? 'destroyed' : !this.enabled || !this.active() ? 'inactive'
      : !current ? 'no ID pass this frame' : this.stats.reason
    return { ...this.stats, frameNumber: this.frame, active: reason === null, reason }
  }
}
