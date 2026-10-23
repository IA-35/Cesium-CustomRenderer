import RenderItemExecutor143 from '../renderer/RenderItemExecutor143.js'
import { motionSources143 } from './motionShaders143.js'
import { projectOcclusionBounds } from '../visibility/OcclusionCulling143.js'

export function motionTransform143(C, currentView, currentModel, previousView, previousModel) {
  return { currentModelView: C.Matrix4.multiply(currentView, currentModel, new C.Matrix4()),
    previousModelView: C.Matrix4.multiply(previousView, previousModel, new C.Matrix4()) }
}

// VelocityNode's transform history, adapted to Cesium's actually submitted rigid
// GLTF primitive commands. Existing scene color/depth are never rewritten here.
export default class TaaMotion143 {
  constructor(C, scene, rhi = null) {
    Object.assign(this, { C, scene, rhi, active: false, records: new WeakMap(), primitiveKeys: new WeakMap(), programs: new Map(), states: new Map(), aliases: new Map() })
    this.executor = new RenderItemExecutor143(C, { label: 'TRAA r186 motion' })
    this.submitted = new Set()
    this.previousSubmitted = new Set()
    this.pendingMasks = []
    this.pendingDraws = []
    this.stats = { supported: 0, unsupported: 0, draws: 0, errors: 0, newSurfaces: 0, appearanceChanges: 0, previousFootprints: 0 }
  }
  primitiveKey(command) {
    let key = this.primitiveKeys.get(command)
    if (key) return key
    // Cesium may rebuild HDR/log-depth draw wrappers after asynchronous material
    // preparation. Their runtime primitive remains the same physical surface.
    for (const node of command.owner?._sceneGraph?._runtimeNodes || []) for (const primitive of node?.runtimePrimitives || []) {
      const native = primitive.drawCommand?._command
      if (native && (native === command || (native.modelMatrix === command.modelMatrix && native.vertexArray === command.vertexArray &&
          native.count === command.count && native.offset === command.offset))) {
        key = primitive; break
      }
    }
    key ||= command
    this.primitiveKeys.set(command, key)
    return key
  }
  snapshot(command, frame) {
    const key = this.primitiveKey(command), C = this.C
    let value = this.records.get(key)
    if (value?.frame === frame) return value
    if (!value) {
      value = { current: new C.Matrix4(), previous: new C.Matrix4() }
      this.records.set(key, value)
    }
    value.valid = value.frame === frame - 1
    const model = C.Model && command.owner instanceof C.Model ? command.owner : undefined
    const color = model?.color, blendMode = model?.colorBlendMode, blendAmount = model?.colorBlendAmount
    value.appearanceChanged = value.valid && (!C.Color.equals(color, value.color) ||
      blendMode !== value.blendMode || blendAmount !== value.blendAmount)
    value.color = C.Color.clone(color, value.color)
    value.blendMode = blendMode; value.blendAmount = blendAmount
    const reusable = value.previous
    value.previous = value.current
    value.current = C.Matrix4.clone(command.modelMatrix || C.Matrix4.IDENTITY, reusable)
    value.moved = value.valid && !C.Matrix4.equals(value.current, value.previous)
    value.previousMotionMasked = value.motionMasked === true
    value.motionMasked = false
    const reusableBounds = value.previousBounds
    value.previousBounds = value.bounds
    value.bounds = command.boundingVolume instanceof C.OrientedBoundingBox
      ? C.BoundingSphere.fromOrientedBoundingBox(command.boundingVolume, reusableBounds)
      : C.BoundingSphere.clone(command.boundingVolume, reusableBounds)
    if (!value.valid) C.Matrix4.clone(value.current, value.previous)
    value.frame = frame
    return value
  }
  attach() {
    const dispatcher = this.scene.context._ccrDrawDispatcher
    if (!dispatcher) { this.reason = 'No draw dispatcher'; return }
    this.detach = dispatcher.addHandler(event => {
      if (!this.active || !this.isSceneColor(event.command, event.passState)) return 'continue'
      event.aroundDraw(invoke => {
        const result = invoke()
        try { this.capture(event) } catch (error) {
          this.failed = true; this.active = false; this.reason = error.message; this.stats.errors++; this.releaseTarget()
        }
        return result
      })
      return 'continue'
    }, { name: 'traa-r186-motion', priority: -30 })
  }
  isSceneColor(command, passState) {
    const { scene, C } = this, passes = scene.frameState.passes
    if (!passes.render || passes.pick || passes.depth || command.pass !== C.Pass.OPAQUE) return false
    const target = command.framebuffer || passState?.framebuffer, view = scene._view
    return target && (target === view?.sceneFramebuffer?._colorFramebuffer?.framebuffer || target === view?.globeDepth?.colorFramebufferManager?.framebuffer)
  }
  begin(active, currentView, currentProjection, previousView, previousProjection, historyValid) {
    this.active = !!active && !!this.detach && !this.failed
    this.frame = this.scene.frameState.frameNumber; this.historyValid = historyValid; this.seen = new WeakSet()
    this.stats = { supported: 0, unsupported: 0, draws: 0, errors: 0, newSurfaces: 0, appearanceChanges: 0, previousFootprints: 0 }
    // Public picks are not colour frames. Only explicit history invalidation
    // drops snapshots; the sequence advances when a colour capture is prepared.
    if (!this.active) return
    this.colorFrame = (this.colorFrame || 0) + 1
    const reusable = this.previousSubmitted
    this.previousSubmitted = this.submitted
    this.submitted = reusable
    this.submitted.clear()
    this.changed = false
    this.unsupportedChanged = false
    this.pendingMasks.length = 0
    this.pendingDraws.length = 0
    const C = this.C
    this.currentView = C.Matrix4.clone(currentView, this.currentView); this.currentProjection = C.Matrix4.clone(currentProjection, this.currentProjection)
    this.previousView = C.Matrix4.clone(previousView, this.previousView); this.previousProjection = C.Matrix4.clone(previousProjection, this.previousProjection)
    if (this.texture && (this.texture.width !== this.scene.drawingBufferWidth || this.texture.height !== this.scene.drawingBufferHeight)) this.releaseTarget()
    for (const [source, record] of this.programs) if (record.frame < this.frame - 120) { record.program?.destroy(); this.programs.delete(source) }
    for (const [key, record] of this.states) if (record.frame < this.frame - 120) {
      C.RenderState.removeFromCache(record.options)
      if (record.previousOptions) C.RenderState.removeFromCache(record.previousOptions)
      this.states.delete(key)
    }
    for (const [native, alias] of this.aliases) if (native.isDestroyed?.()) { alias.destroy(); this.aliases.delete(native) }
  }
  preserveTarget(fn) {
    const context = this.scene.context, gl = context._gl
    const read = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING), draw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING), cached = context._currentFramebuffer
    try { return fn() } finally {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, draw); context._currentFramebuffer = cached
    }
  }
  allocate() {
    if (this.texture) return
    const { C, scene, rhi } = this, context = scene.context
    const options = { context, width: scene.drawingBufferWidth, height: scene.drawingBufferHeight,
      pixelFormat: C.PixelFormat.RGBA, pixelDatatype: C.PixelDatatype.FLOAT,
      sampler: new C.Sampler({ minificationFilter: C.TextureMinificationFilter.NEAREST, magnificationFilter: C.TextureMagnificationFilter.NEAREST }) }
    if (rhi) { this.colorResource = rhi.createTexture(options); this.texture = this.colorResource.texture
      this.fbResource = rhi.createFramebuffer([this.texture]); this.framebuffer = this.fbResource.framebuffer }
    else { this.texture = new C.Texture(options); this.framebuffer = new C.Framebuffer({ context, colorTextures: [this.texture], destroyAttachments: false }) }
    if (this.framebuffer.status !== context._gl.FRAMEBUFFER_COMPLETE) throw new Error('TRAA motion framebuffer incomplete')
    this.clear = new C.ClearCommand({ framebuffer: this.framebuffer, color: C.Color.TRANSPARENT })
  }
  alias(native) {
    let value = this.aliases.get(native)
    if (!value) {
      const depth = native.depthStencilTexture ? { depthStencilTexture: native.depthStencilTexture } : native.depthTexture ? { depthTexture: native.depthTexture } : null
      if (!depth) throw new Error('TRAA requires native depth texture')
      value = new this.C.Framebuffer({ context: this.scene.context, colorTextures: [this.texture], ...depth, destroyAttachments: false })
      this.aliases.set(native, value)
      if (value.status !== this.scene.context._gl.FRAMEBUFFER_COMPLETE) throw new Error('TRAA native depth alias incomplete')
    }
    return value
  }
  capture(event) {
    const { C, scene } = this, original = event.command
    if (this.seen.has(original)) return
    this.seen.add(original)
    const key = this.primitiveKey(original), history = this.snapshot(original, this.colorFrame)
    this.submitted.add(key)
    if (!this.previousSubmitted.has(key) || history.moved || history.appearanceChanged) this.changed = true
    if (history.appearanceChanged) this.stats.appearanceChanges++
    const source = event.overrides[0] ?? original.shaderProgram, uniforms = event.overrides[1] ?? original.uniformMap, owner = original.owner
    const state = original.renderState, stencil = state?.stencilTest
    if (!(C.Model && owner instanceof C.Model) || owner.type !== 'GLTF' || owner.content || original.instanceCount > 0 ||
        state?.blending?.enabled || !state?.depthTest?.enabled || !state.depthMask ||
        (stencil?.enabled && (stencil.frontFunction !== C.StencilFunction.ALWAYS || stencil.backFunction !== C.StencilFunction.ALWAYS))) {
      this.captureUnsupported(history); return
    }
    let program = this.programs.get(source)
    if (!program) { program = { sources: motionSources143(C, source), frame: this.frame }; this.programs.set(source, program) }
    program.frame = this.frame
    if (!program.sources) { this.captureUnsupported(history); return }
    this.stats.supported++
    history.motionMasked = this.historyValid && (!history.valid || history.moved || history.appearanceChanged)
    if (!history.valid) this.stats.newSurfaces++
    if (!history.moved && !history.appearanceChanged && (history.valid || !this.historyValid)) return
    if (!program.program) program.program = C.ShaderProgram.fromCache({ context: scene.context, ...program.sources, attributeLocations: source._attributeLocations })
    let record = this.states.get(state)
    if (!record) {
      const options = C.RenderState.getState(state)
      options.depthMask = false; options.stencilMask = 0; options.blending = { enabled: false }
      options.depthTest = { enabled: true, func: C.DepthFunction.LESS_OR_EQUAL }; options.colorMask = { red: true, green: true, blue: true, alpha: true }
      record = { value: C.RenderState.fromCache(options), options }; this.states.set(state, record)
    }
    record.frame = this.frame
    const matrices = motionTransform143(C, this.currentView, history.current, this.previousView, history.previous)
    const previousFootprint = history.valid && history.moved && !history.previousMotionMasked && history.previousBounds &&
      C.Matrix4.equalsEpsilon(this.currentView, this.previousView, 1e-7)
    const uniformMap = { ...uniforms, ccr_currentModelView: () => matrices.currentModelView,
      ccr_previousModelView: () => matrices.previousModelView, ccr_currentProjection: () => this.currentProjection,
      ccr_previousProjection: () => this.previousProjection, ccr_previousValid: () => history.valid && !history.appearanceChanged }
    const target = original.framebuffer || event.passState.framebuffer
    const passState = { ...event.passState, viewport: C.BoundingRectangle.clone(event.passState.viewport) }
    // Submit once after opaque depth is complete instead of switching targets per primitive.
    this.pendingDraws.push(() => {
      if (previousFootprint) {
        // A stepped simulation repeatedly restarts motion. Reject the old silhouette,
        // not its bounding rectangle, so nearby road pixels keep their accumulated AA.
        if (!record.previousValue) {
          record.previousOptions = { ...record.options, colorMask: { red: false, green: false, blue: false, alpha: true } }
          record.previousValue = C.RenderState.fromCache(record.previousOptions)
        }
        const previousModelView = C.Matrix4.multiply(this.currentView, history.previous, new C.Matrix4())
        this.executor.execute(original, scene.context, passState, {
          shaderProgram: program.program, modelMatrix: history.previous,
          uniformMap: { ...uniformMap, ccr_currentModelView: () => previousModelView, ccr_previousValid: () => false },
          renderState: record.previousValue, framebuffer: this.alias(target)
        })
        this.stats.draws++; this.stats.previousFootprints++
      }
      this.executor.execute(original, scene.context, passState, { shaderProgram: program.program, uniformMap,
        renderState: record.value, framebuffer: this.alias(target) })
      this.stats.draws++
    })
  }
  get textureForResolve() { return this.active && this.stats.draws > 0 ? this.texture : undefined }
  captureUnsupported(history) {
    this.stats.unsupported++
    if (history.valid && !history.moved && !history.appearanceChanged) return
    if (history.bounds) this.pendingMasks.push(history.bounds)
    else this.unsupportedChanged = true
    if (history.valid && history.moved && history.previousBounds) this.pendingMasks.push(history.previousBounds)
  }
  finish() {
    if (!this.active || this.finishedFrame === this.colorFrame) return
    this.finishedFrame = this.colorFrame
    if (this.pendingDraws.length) {
      const us = this.scene.context.uniformState, previousPass = us.pass
      try {
        this.preserveTarget(() => {
          this.allocate(); this.clear.execute(this.scene.context)
          us.updatePass(this.C.Pass.OPAQUE)
          for (const draw of this.pendingDraws) draw()
        })
      } finally { this.pendingDraws.length = 0; us.updatePass(previousPass) }
    }
    if (!this.historyValid) { this.pendingMasks.length = 0; return }
    for (const key of this.previousSubmitted) if (!this.submitted.has(key)) {
      const record = this.records.get(key)
      if (record?.motionMasked) continue
      if (record?.bounds) this.pendingMasks.push(record.bounds)
      else this.unsupportedChanged = true
    }
    if (!this.pendingMasks.length) return
    this.preserveTarget(() => {
      this.allocate()
      if (this.stats.draws === 0) this.clear.execute(this.scene.context)
      for (const bounds of this.pendingMasks) this.rejectPreviousFootprint(bounds)
    })
    this.pendingMasks.length = 0
  }
  rejectPreviousFootprint(sphere) {
    const { C, scene } = this, context = scene.context, width = this.texture.width, height = this.texture.height
    const projected = projectOcclusionBounds(C, scene.camera, sphere, width, height)
    const rect = projected?.rect || new C.Cartesian4(-1, -1, 1, 1)
    if (!this.previousMask) {
      this.previousMaskState = { depthTest: { enabled: false }, depthMask: false,
        colorMask: { red: false, green: false, blue: false, alpha: true } }
      this.previousMask = context.createViewportQuadCommand('void main(){out_FragColor=vec4(0.0,0.0,0.0,-1.0);}',
        { renderState: C.RenderState.fromCache(this.previousMaskState) })
      this.previousMaskPass = new C.PassState(context)
    }
    // Conservative bounds also cover thin geometry missed by this jitter phase.
    const x = Math.max(0, Math.floor((rect.x + 1) * width * .5)), y = Math.max(0, Math.floor((rect.y + 1) * height * .5))
    const right = Math.min(width, Math.ceil((rect.z + 1) * width * .5)), top = Math.min(height, Math.ceil((rect.w + 1) * height * .5))
    const pass = this.previousMaskPass
    pass.framebuffer = this.framebuffer; pass.viewport = new C.BoundingRectangle(0, 0, width, height)
    pass.scissorTest = { enabled: true, rectangle: new C.BoundingRectangle(x, y, right - x, top - y) }
    this.previousMask.framebuffer = this.framebuffer
    this.previousMask.execute(context, pass)
    this.stats.draws++; this.stats.previousFootprints++
  }
  get stationary() { return this.active && !this.changed && this.submitted.size === this.previousSubmitted.size }
  get coverageStable() {
    return this.active && !this.unsupportedChanged
  }
  reset() { this.records = new WeakMap(); this.primitiveKeys = new WeakMap(); this.colorFrame = 0; this.finishedFrame = undefined; this.historyValid = false; this.pendingMasks.length = 0; this.pendingDraws.length = 0; this.submitted.clear(); this.previousSubmitted.clear(); this.releaseTarget() }
  releaseTarget() {
    for (const alias of this.aliases.values()) alias.destroy()
    this.aliases.clear()
    if (this.fbResource) this.fbResource.release(); else this.framebuffer?.destroy()
    if (this.colorResource) this.colorResource.release(); else this.texture?.destroy()
    this.fbResource = this.colorResource = this.framebuffer = this.texture = this.clear = undefined
  }
  getDiagnostics() { return { active: this.active, failed: !!this.failed, reason: this.reason || null, ...this.stats, bytes: this.texture?.sizeInBytes || 0,
    encoding: 'RGBA32F currentNDC-previousNDC, currentEyeDepth, previousEyeDepth; w<0=new surface',
    scope: 'standalone opaque rigid GLTF primitive matrices; deforming/instanced/transparent content has no object velocity' } }
  destroy() {
    this.active = false; this.detach?.(); this.detach = undefined; this.reset()
    for (const record of this.programs.values()) record.program?.destroy()
    this.programs.clear()
    for (const record of this.states.values()) {
      this.C.RenderState.removeFromCache(record.options)
      if (record.previousOptions) this.C.RenderState.removeFromCache(record.previousOptions)
    }
    this.states.clear()
    this.previousMask?.shaderProgram.destroy()
    if (this.previousMaskState) this.C.RenderState.removeFromCache(this.previousMaskState)
    this.previousMask = this.previousMaskPass = this.previousMaskState = undefined
  }
}
