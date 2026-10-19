import { registerHdrEffect } from '../environment/HdrCoordinator143.js'
import { taaResolveShader, taaDepthShader, taaDisplayShader } from './taaShaders143.js'
import TaaJitter143 from './TaaJitter143.js'
import { DEFAULT_JITTER_SAMPLES } from './jitter143.js'
import { attachTaaSelectionDepth } from './TaaSelectionDepth143.js'
import TaaOverlay143 from './TaaOverlay143.js'
import TaaMotion143 from './TaaMotion143.js'

let nextId = 0

const clamp = (value, low, high) => Math.max(low, Math.min(high, value))

// Deprecated source-level compatibility helpers. r186 does not call these or
// upload the old controls; getDiagnostics().legacyIgnored makes that explicit.
export function taaBlendWeights(settings = {}) {
  return [clamp(settings.taaHistoryBlend ?? 0.03, 0.02, 0.9),
    clamp(settings.taaMotionBlend ?? 0.5, 0.05, 1),
    clamp(settings.taaVelocityThreshold ?? 12, 1, 64),
    clamp(settings.taaDepthTolerance ?? 0.1, 0, 0.5)]
}

// Deprecated along with taaBlendWeights; runtime gamma follows the documented CCR curve.
export function taaVarianceGammas(settings = {}) {
  return [0, 0,
    clamp(settings.taaVarianceGammaStill ?? 1.5, 0.25, 4),
    clamp(settings.taaVarianceGammaMoving ?? 0.75, 0.1, 3)]
}

// Temporal anti-aliasing for the Cesium 1.143 HDR chain.
//
// Each frame is rendered with a sub-pixel offset and resolved against the previous frame
// reprojected through the camera's own matrices. The history is two ping-pong colour
// targets so the resolve never reads the texture it writes, plus one eye-depth target:
// Cesium reuses a single depth buffer per frame, so the previous frame's depth has to be
// stored to tell a moved surface apart from a revealed one.
//
// The resolve follows pinned Three.js r186 TRAANode/TAAUtils. Camera-relative
// matrices adapt Cesium ECEF/log depth; rigid GLTF input follows VelocityNode.
export default class TaaPass143 {
  constructor(C, scene, getOptions, rhi = null) {
    if (!/^1\.143(?:\.0)?$/.test(C.VERSION)) throw new Error('TaaPass143 requires Cesium 1.143')
    Object.assign(this, { C, scene, getOptions, rhi, enabled: false, destroyed: false, failed: false })
    const context = scene.context
    this.missing = ['webgl2', 'depthTexture', 'floatingPointTexture', 'colorBufferFloat'].filter(name => !context || !context[name])
    if (!context?.textureFloatLinear) this.missing.push('textureFloatLinear')
    this.supported = this.missing.length === 0
    this.error = null
    this.reason = 'Disabled'
    this.healthy = false
    this.output = undefined
    this.reconstructing = false
    this.outputFrame = undefined
    this.stats = { frames: 0, bypasses: 0, resets: 0 }
    this.historyValid = false
    this.historyAge = 0
    this.staticFrames = 0
    this.historySize = null
    this.active = 0
    this.view = new C.Matrix4()
    this.projection = new C.Matrix4()
    this.previousView = new C.Matrix4()
    this.previousProjection = new C.Matrix4()
    this.prevViewFromCurrent = new C.Matrix4()
    this.inverseView = new C.Matrix4()
    this.currentInverseRasterProjection = new C.Matrix4()
    this.previousInverseRasterProjection = new C.Matrix4()
    this.currentViewFromPreviousEye = new C.Matrix4()
    this.cameraNearFar = new C.Cartesian2(1, 1000)
    this.jitterUv = new C.Cartesian2()
    this.previousJitterUv = new C.Cartesian2()
    // PostProcessStage.execute assigns this._colorTexture.sampler = this._sampler, so a
    // stage's sampleMode rewrites the sampler of the texture handed *into* it and never
    // touches the stage's own output texture. The history colour is another stage's output,
    // which is why it needs its own sampler. Sampler has no destroy(): it is plain data.
    this.linearSampler = new C.Sampler({ minificationFilter: C.TextureMinificationFilter.LINEAR,
      magnificationFilter: C.TextureMagnificationFilter.LINEAR })
    this.nearestSampler = new C.Sampler({ minificationFilter: C.TextureMinificationFilter.NEAREST,
      magnificationFilter: C.TextureMagnificationFilter.NEAREST })
  }

  _sceneDestroyed() { return !!(this.scene.isDestroyed && this.scene.isDestroyed()) }

  _scopeReason() {
    if (this.destroyed || this._sceneDestroyed()) return 'Destroyed'
    if (!this.supported) return `Missing ${this.missing.join(', ')}`
    if (!this.enabled) return this.failed ? 'TAA failed; disable before retrying' : 'Disabled'
    if (this.scene.context._gl.isContextLost()) return 'Context lost'
    if (!this.scene.highDynamicRange) return 'Requires HDR'
    if ((this.scene.msaaSamples ?? 1) !== 1) return 'Requires MSAA=1'
    // Cesium runs the post-process chain for picking and depth-only passes as well. Blending
    // those into the history would corrupt it, so only the colour render pass may resolve.
    const passes = this.scene.frameState.passes
    if (!passes.render || passes.pick || passes.depth) return 'Requires color render frame'
    if (!(this.scene.camera.frustum instanceof this.C.PerspectiveFrustum)) return 'Requires a perspective camera'
    const frustums = this.scene._view && this.scene._view.frustumCommandsList
    if (frustums && frustums.length !== 1) return 'Requires single-frustum depth'
    if (this.getOptions().antialiasing !== 'taa') return 'Not the active anti-aliasing mode'
    return null
  }

  _createStages() {
    const C = this.C, scene = this.scene, name = `taa_${++nextId}`
    const context = scene.context
    const fallback = () => context.defaultTexture
    // Low-weight HDR accumulation needs float32: half-float rounding otherwise
    // changes the mean while thin edges converge.
    const datatype = C.PixelDatatype.FLOAT
    this.historyDatatype = datatype
    const depthUniforms = {
      u_surfaceDepth: () => this.surfaceDepth() || fallback(),
      u_hasSurfaceDepth: () => !!this.surfaceDepth(),
      u_jitterUv: () => this.jitterUv
    }
    const uniforms = {
      ...depthUniforms,
      u_historyColor: () => this.historyColor || fallback(),
      u_historyDepth: () => this.historyDepth || fallback(),
      u_previousJitterUv: () => this.previousJitterUv,
      u_acquisitionAge: () => this.staticFrames > 0 ? Math.min(this.historyAge, this.staticFrames) : this.historyAge,
      u_jitterSamples: () => this.jitter.samples,
      u_cameraStill: () => this.staticFrames > 0,
      u_currentInverseRasterProjection: () => this.currentInverseRasterProjection,
      u_previousInverseRasterProjection: () => this.previousInverseRasterProjection,
      u_currentProjection: () => this.projection,
      u_previousProjection: () => this.previousProjection,
      u_previousViewFromCurrentEye: () => this.prevViewFromCurrent,
      u_currentViewFromPreviousEye: () => this.currentViewFromPreviousEye,
      u_cameraNearFar: () => this.cameraNearFar,
      u_motionTexture: () => this.motion?.textureForResolve || fallback(),
      u_hasMotionTexture: () => !!this.motion?.textureForResolve,
      u_depthThreshold: () => this.getOptions().taaDepthThreshold ?? 0.0005,
      u_edgeDepthDiff: () => this.getOptions().taaEdgeDepthDiff ?? 0.001,
      u_maxVelocityLength: () => this.getOptions().taaMaxVelocityLength ?? 128,
      u_useSubpixelCorrection: () => this.getOptions().taaUseSubpixelCorrection !== false,
      u_historyValid: () => this.historyValid ? 1 : 0
    }
    const makeResolve = suffix => new C.PostProcessStage({
      name: `${name}_resolve_${suffix}`, fragmentShader: taaResolveShader, uniforms,
      textureScale: 1, pixelFormat: C.PixelFormat.RGBA, pixelDatatype: datatype,
      // Reconstruction explicitly fetches current/history texels. Keep the HDR
      // sampler contract and restore the incoming sampler after this effect.
      sampleMode: C.PostProcessStageSampleMode.LINEAR, clearColor: new C.Color(0, 0, 0, 0)
    })
    this.frames = ['a', 'b'].map((suffix, index) => ({ index, resolve: makeResolve(suffix) }))
    this.depth = {
      // Nearest filtering: a depth value must never be interpolated across a silhouette.
      pack: new C.PostProcessStage({
        name: `${name}_depth`, fragmentShader: taaDepthShader, uniforms: depthUniforms,
        textureScale: 1, pixelFormat: C.PixelFormat.RED, pixelDatatype: C.PixelDatatype.FLOAT,
        sampleMode: C.PostProcessStageSampleMode.NEAREST, clearColor: new C.Color(0, 0, 0, 0)
      })
    }
    for (const frame of this.frames) frame.collection = this._collection(name, frame.resolve)
    this.depth.collection = this._collection(name, this.depth.pack)
    // The normal pipeline reuses its existing RHI colour copy for display.
    // Direct users without an RHI need the same alpha restoration as one stage.
    if (!this.rhi) {
      const stage = new C.PostProcessStage({ name: `${name}_display`, fragmentShader: taaDisplayShader,
        uniforms: { u_alphaSource: () => this.alphaSource, u_jitterUv: () => this.jitterUv,
          u_reconstructColor: () => this.reconstructing },
        pixelFormat: C.PixelFormat.RGBA, pixelDatatype: datatype,
        sampleMode: C.PostProcessStageSampleMode.NEAREST })
      this.display = { stage, collection: this._collection(name, stage) }
    }
  }

  // The history colour has to interpolate between texels: the reprojection lands anywhere
  // inside the previous frame, so a nearest fetch snaps to one texel and loses the
  // sub-pixel placement the jitter exists to average. Re-asserted every frame because a
  // later native stage sets the sampler of whatever texture the chain is carrying.
  _synchronizeHistorySamplers() {
    if (this.historyColor && this.historyColor.sampler !== this.linearSampler) {
      this.historyColor.sampler = this.linearSampler
    }
    // Depth must never be interpolated across a silhouette.
    if (this.historyDepth && this.historyDepth.sampler !== this.nearestSampler) {
      this.historyDepth.sampler = this.nearestSampler
    }
  }

  surfaceDepth() {
    const { globe, context } = this.scene
    const texture = globe && globe.show && context.uniformState.globeDepthTexture
    return texture && !texture.isDestroyed() ? texture : undefined
  }

  declareGraph(graph) {
    this.graph = graph
    this.graphHistory = {
      colorA: graph.importResource('taa.history.colorA', { format: 'rgba32f', history: true }),
      colorB: graph.importResource('taa.history.colorB', { format: 'rgba32f', history: true }),
      depth: graph.importResource('taa.history.depth', { format: 'r32f', history: true })
    }
    return this.graphHistory
  }

  _releaseRhiHistory() {
    for (const entry of this.rhiHistory || []) { entry.colorFramebuffer?.release(); entry.color?.release() }
    this.rhiHistory = undefined; this.rhiHistorySize = null
    if (this.rhiCopyColor?.shaderProgram && !this.rhiCopyColor.shaderProgram.isDestroyed()) this.rhiCopyColor.shaderProgram.destroy()
    this.rhiCopyColor = undefined
  }

  _ensureRhiHistory(width, height, datatype) {
    if (!this.rhi) return false
    const size = `${width}x${height}:${datatype}`
    if (this.rhiHistorySize === size && this.rhiHistory) return true
    this._releaseRhiHistory()
    const C = this.C, context = this.scene.context
    try {
      // Native stages own accumulation; this retained RHI slot only restores display alpha.
      const entry = {}
      this.rhiHistory = [entry]
      entry.color = this.rhi.createTexture({ width, height, pixelFormat: C.PixelFormat.RGBA, pixelDatatype: datatype,
        sampler: this.linearSampler })
      entry.colorFramebuffer = this.rhi.createFramebuffer([entry.color.texture])
      const renderState = C.RenderState.fromCache({ viewport: new C.BoundingRectangle(0, 0, width, height), depthTest: { enabled: false }, depthMask: false })
      this.rhiCopyColor = context.createViewportQuadCommand(taaDisplayShader, { renderState })
      this.rhiHistorySize = size
      return true
    } catch (error) { this._releaseRhiHistory(); throw error }
  }

  _copyToRhi(context, source, target, command) {
    if (!source || !target || !command) return
    command.uniformMap = { colorTexture: () => source,
      u_alphaSource: () => this.alphaSource, u_jitterUv: () => this.jitterUv,
      u_reconstructColor: () => this.reconstructing }
    command.framebuffer = target.framebuffer
    const passState = new this.C.PassState(context)
    passState.framebuffer = target.framebuffer
    passState.viewport = new this.C.BoundingRectangle(0, 0, source.width, source.height)
    command.execute(context, passState)
  }

  _bindGraphHistory() {
    if (!this.graph?.activeFrame || !this.graphHistory) return
    this.graph.bindExternal(this.graphHistory.colorA, this.frames[0].resolve.outputTexture)
    this.graph.bindExternal(this.graphHistory.colorB, this.frames[1].resolve.outputTexture)
    this.graph.bindExternal(this.graphHistory.depth, this.depth.pack.outputTexture)
  }

  // A one-stage collection with `inputPreviousStageTexture: false` receives the chain's
  // incoming HDR colour, which is what the resolve has to blend against.
  _collection(name, stage) {
    const C = this.C
    const composite = new C.PostProcessStageComposite({ name: `${name}_${stage.name}_composite`,
      stages: [stage], inputPreviousStageTexture: false })
    const collection = new C.PostProcessStageCollection()
    collection.fxaa.enabled = false
    collection.bloom.enabled = false
    collection.ambientOcclusion.enabled = false
    collection.add(composite)
    return collection
  }

  _attachJitter() {
    const scene = this.scene
    if (!scene.preRender?.addEventListener || !scene.postRender?.addEventListener) return false
    this.jitterListener = () => this._applyJitter()
    this.restoreJitterListener = () => this.jitter?.restore()
    // Camera movement detection and public picking must never see raster jitter.
    scene.preRender.addEventListener(this.jitterListener)
    scene.postRender.addEventListener(this.restoreJitterListener)
    this.attached = true
    return true
  }

  // Jitter is only advanced while the resolve keeps up. An offset without a matching
  // resolve would show up as a permanently shifted image, so the offset is released
  // whenever the pass bypasses.
  _applyJitter() {
    if (!this.enabled || this.failed || !this.jitter) return
    this._applyFallback()
    const samples = this.getOptions().taaJitterSamples || DEFAULT_JITTER_SAMPLES
    if (this.jitter.samples !== samples) { this.jitter.samples = samples; this.resetHistory() }
    const defer = this.healthy && this.scene._view?.frustumCommandsList?.length === 1 && this.scene.msaaSamples === 1
    if (defer && this.overlay && !this.overlay.active) { this.historyValid=false;this.historyAge=0 }
    this.overlay?.begin(defer)
    if (!this.healthy) this.jitter.restore()
    else this.jitter.apply()
    if (this.motion && this.C) {
      const C = this.C, projection = C.Matrix4.clone(this.scene.camera.frustum.projectionMatrix, new C.Matrix4())
      const pixel = this.jitter.holding ? this.jitter.pixel : { x: 0, y: 0 }
      projection[8] += 2 * pixel.x / this.scene.drawingBufferWidth
      projection[9] += 2 * pixel.y / this.scene.drawingBufferHeight
      this.motion.begin(!this._scopeReason() && this.scene.msaaSamples === 1, this.scene.camera.viewMatrix,
        projection, this.previousView, this.previousProjection, this.historyValid)
    }
  }

  _fallback(enabled) {
    // Native stage targets are prepared before HDR effects execute. A mid-frame
    // enable can make native copy select an FXAA texture that was not allocated.
    this.pendingFallback = enabled
  }

  _applyFallback() {
    const record = this.fallback
    if (!record || record.released || this.pendingFallback === undefined) return
    if (record.stage.enabled !== record.applied) { record.released = true; return }
    record.stage.enabled = this.pendingFallback; record.applied = this.pendingFallback
    this.pendingFallback = undefined
  }

  setEnabled(value) {
    if (this.destroyed || this._sceneDestroyed()) return
    if (!value) {
      this._release()
      this.failed = false
      this.reason = 'Disabled'
    } else if (!this.enabled && !this.failed && this.supported) {
      try {
        this.error = null
        const fxaa = this.scene.postProcessStages.fxaa
        if (fxaa) this.fallback = { stage: fxaa, before: fxaa.enabled, applied: fxaa.enabled }
        this._createStages()
        this.jitter = new TaaJitter143(this.C, this.scene, { samples: this.getOptions().taaJitterSamples })
        this.jitter.setEnabled(true)
        this.overlay = new TaaOverlay143(this.C, this.scene, this.jitter)
        this.motion = new TaaMotion143(this.C, this.scene, this.rhi)
        this.motion.attach()
        if (!this._attachJitter()) throw new Error('Scene pre-render/post-render events are unavailable')
        this.detach = registerHdrEffect(this.scene, 25, (...args) => this._execute(...args))
        this.detachSelectionDepth = attachTaaSelectionDepth(this.scene, () =>
          this.healthy && this.jitter?.holding && this.outputFrame === this.scene.frameState.frameNumber && !this._scopeReason())
        this.enabled = true
        this.reason = 'Not rendered'
      } catch (error) { this._fail(error) }
    }
    this.scene.requestRender()
  }

  // Drops the history without touching the enabled state: the next frame resolves against
  // the current frame alone. Callers use this after an abrupt camera or scene change.
  resetHistory() {
    this.historyValid = false
    this.historyAge = 0
    this.staticFrames = 0
    this.healthy = false
    if (this.jitter) this.jitter.reset()
    this.motion?.reset()
    this.stats.resets++
  }

  _execute(context, color, depth, id) {
    this.output = undefined
    const reason = this._scopeReason()
    if (reason) {
      this.reason = reason
      if (reason !== 'Requires color render frame') {
        this.healthy = false; this.historyValid = false; this.historyAge = 0; this.staticFrames = 0; this._fallback(true)
      }
      this.stats.bypasses++
      return this.overlay?.composite(color) || color
    }
    const viewport = this.C.BoundingRectangle.clone(context.uniformState.viewport)
    const inputSampler = color.sampler
    try {
      this.alphaSource = color
      this.jitter?.bridge?.restoreColorProjection()
      const scene = this.scene, frame = scene.frameState
      const size = `${color.width}x${color.height}`
      if (size !== this.historySize) {
        // A resized canvas invalidates every stored texel; restart the sequence too so the
        // first accumulated frame does not reuse a sample the history never saw.
        this.historySize = size
        this.resetHistory()
      }
      this._ensureRhiHistory(color.width, color.height, this.historyDatatype)
       this.C.Matrix4.clone(scene.camera.viewMatrix, this.view)
      this.C.Matrix4.clone(scene.camera.frustum.projectionMatrix, this.projection)
      // Snapshot the actual color draw frustum, after undoing any stable ID pass.
      // Its near/far can differ from the root camera even in single-frustum mode.
      const us = context.uniformState
      if (us.projection) this.C.Matrix4.clone(us.projection, this.projection)
      if (us.inverseProjection) this.C.Matrix4.clone(us.inverseProjection, this.currentInverseRasterProjection)
      else this.C.Matrix4.inverse(this.projection, this.currentInverseRasterProjection)
      // Decode log depth with actual draw uniforms above; then map eye metres
      // to r186's ROOT camera depth domain (TRAANode._cameraNearFar), not the
      // tighter Cesium draw subfrustum which would change the fixed thresholds.
      this.cameraNearFar.x = scene.camera.frustum.near
      this.cameraNearFar.y = scene.camera.frustum.far
      const pixel = this.jitter && this.jitter.holding ? this.jitter.pixel : { x: 0, y: 0 }
      this.jitterUv.x = pixel.x / color.width
      this.jitterUv.y = pixel.y / color.height
      // Store the projection of the stable history grid, preserving any caller offset.
      this.projection[8] += 2 * this.jitterUv.x
      this.projection[9] += 2 * this.jitterUv.y
      if (!this.historyValid) {
        this.C.Matrix4.clone(this.view, this.previousView)
        this.C.Matrix4.clone(this.projection, this.previousProjection)
        this.C.Matrix4.clone(this.currentInverseRasterProjection, this.previousInverseRasterProjection)
        this.C.Cartesian2.clone(this.jitterUv, this.previousJitterUv)
      }

      const destination = this.frames[this.active]
      // Private native history includes acquisition metadata. The RHI colour copy
      // restores scene opacity for display; Graph binds the native histories directly.
       this.historyColor = this.frames[1 - this.active].resolve.outputTexture
      this.historyDepth = this.depth.pack.outputTexture
      if (!this.historyColor || !this.historyDepth) this.historyValid = false
      // Set before the resolve reads them, and after any stage that may have rewritten them.
      this._synchronizeHistorySamplers()

      // The reprojection never leaves eye space: previousView * inverse(currentView) maps
      // the current camera's eye coordinates straight into the previous frame's, which
      // avoids the precision loss of round-tripping through Earth-centred world space.
      this.C.Matrix4.inverse(this.view, this.inverseView)
      this.C.Matrix4.multiply(this.previousView, this.inverseView, this.prevViewFromCurrent)
      this.C.Matrix4.inverse(this.prevViewFromCurrent, this.currentViewFromPreviousEye)
      const change = this.prevViewFromCurrent
      this.staticFrames = this.historyValid && this.C.Matrix4.equalsEpsilon(change, this.C.Matrix4.IDENTITY, 1e-7)
        ? this.staticFrames + 1 : 0
      if (this.historyValid && (change[0] + change[5] + change[10] < 2.9 ||
          Math.hypot(change[12], change[13], change[14]) > 500)) this.resetHistory()

      // Reuse the display target before resolve: each current pixel is reconstructed once.
      const currentHistory = this.rhiHistory?.[0]
      let reconstructed
      this.reconstructing = true
      if (currentHistory) {
        this._copyToRhi(context, color, currentHistory.colorFramebuffer, this.rhiCopyColor)
        reconstructed = currentHistory.color.texture
      } else {
        this.display.collection.update(context, frame.useLogDepth, false)
        this.display.collection.clear(context)
        if (!this.display.collection.ready) { this.historyValid = false; this.reason = 'Reconstruction not ready'; return this.overlay?.composite(color) || color }
        this.display.collection.execute(context, color, depth, id)
        reconstructed = this.display.stage.outputTexture
      }
      this.reconstructing = false
      destination.collection.update(context, frame.useLogDepth, false)
      destination.collection.clear(context)
      if (!destination.collection.ready) { this.historyValid = false; this.reason = 'Not ready'; return this.overlay?.composite(color) || color }
      destination.collection.execute(context, reconstructed, depth, id)
      const output = destination.collection.outputTexture
      if (!output) { this.historyValid = false; this.reason = 'No output'; return this.overlay?.composite(color) || color }

      // The depth history is written after the resolve so the resolve still reads the
      // previous frame's depth, and the shared depth target can be reused every frame.
      this.depth.collection.update(context, frame.useLogDepth, false)
      this.depth.collection.clear(context)
      if (this.depth.collection.ready) this.depth.collection.execute(context, color, depth, id)

      let displayOutput
       if (currentHistory) {
         this._copyToRhi(context, output, currentHistory.colorFramebuffer, this.rhiCopyColor)
         displayOutput = currentHistory.color.texture
       } else {
         this.display.collection.update(context, frame.useLogDepth, false)
         this.display.collection.clear(context)
         if (!this.display.collection.ready) { this.historyValid = false; this.reason = 'Display not ready'; return this.overlay?.composite(color) || color }
         this.display.collection.execute(context, output, depth, id)
         displayOutput = this.display.stage.outputTexture
       }
       this._bindGraphHistory()
      const previous = this.previousView
      this.previousView = this.view
      this.view = previous
      const previousProjection = this.previousProjection
      this.previousProjection = this.projection
      this.projection = previousProjection
      const previousRaster = this.previousInverseRasterProjection
      this.previousInverseRasterProjection = this.currentInverseRasterProjection
      this.currentInverseRasterProjection = previousRaster
      this.C.Cartesian2.clone(this.jitterUv, this.previousJitterUv)

      this.active = 1 - this.active
      this.historyValid = true
      this.historyAge++
      this._fallback(false)
      this.healthy = true
      this.output = displayOutput
      this.outputFrame = frame.frameNumber
      this.reason = null
      this.stats.frames++
      return this.overlay?.composite(displayOutput) || displayOutput
    } catch (error) {
      this._fail(error)
      return color
    } finally {
      this.reconstructing = false
      color.sampler = inputSampler
      context.uniformState.viewport = viewport
      if (this.output === undefined) this.stats.bypasses++
    }
  }

  getDiagnostics() {
    const textures = new Set()
    const collect = stage => {
      const texture = stage && stage.ready && stage.outputTexture
      if (texture && !texture.isDestroyed()) textures.add(texture)
    }
    if (this.frames) this.frames.forEach(frame => collect(frame.resolve))
    if (this.depth) collect(this.depth.pack)
    if (this.display) collect(this.display.stage)
    const stageBytes = [...textures].reduce((sum, texture) => sum + (texture.sizeInBytes || 0), 0)
    const rhiTextures = new Set()
    for (const entry of this.rhiHistory || []) for (const resource of [entry.color]) {
      if (resource?.texture && !textures.has(resource.texture)) rhiTextures.add(resource.texture)
    }
    const rhiHistoryBytes = [...rhiTextures].reduce((sum, texture) => sum + (texture.sizeInBytes || 0), 0)
    const sampler = texture => texture && texture.sampler
      ? { minificationFilter: texture.sampler.minificationFilter,
        magnificationFilter: texture.sampler.magnificationFilter }
      : null
    return {
      enabled: this.enabled, supported: this.supported, valid: !!this.output,
      reason: this._scopeReason() || this.reason, error: this.error, failed: this.failed,
      stats: { ...this.stats }, historyValid: this.historyValid, historySize: this.historySize,
      activeFrame: this.active,
      algorithm: { name: 'Three.js r186 TRAA', commit: '9b4a2ac29c63ccb43fd51c5661f2f873ac2c39b8',
        adaptation: 'CCR stable-grid reconstruction / float32 history / acquisition / relative depth',
        depthThreshold: this.getOptions().taaDepthThreshold ?? 0.0005, edgeDepthDiff: this.getOptions().taaEdgeDepthDiff ?? 0.001,
        maxVelocityLength: this.getOptions().taaMaxVelocityLength ?? 128, useSubpixelCorrection: this.getOptions().taaUseSubpixelCorrection !== false },
      legacyIgnored: ['taaHistoryBlend', 'taaMotionBlend', 'taaVelocityThreshold', 'taaDepthTolerance', 'taaVarianceGammaStill', 'taaVarianceGammaMoving'],
      motion: this.motion?.getDiagnostics() || null,
      staticFrames: this.staticFrames,
      jitter: this.jitter ? this.jitter.getDiagnostics() : null,
      overlay: this.overlay?.getDiagnostics() || null,
      samplers: { historyColor: sampler(this.historyColor), historyDepth: sampler(this.historyDepth) },
      stageBytes, rhiHistoryBytes,
      bytes: stageBytes + rhiHistoryBytes + (this.motion?.getDiagnostics().bytes || 0) + (this.overlay?.getDiagnostics().bytes || 0),
      scope: 'temporal resolve of the HDR chain after every HDR effect and before tonemapping; replaces the spatial post-process stage'
    }
  }

  _fail(error) {
    this.error = error instanceof Error ? error.message : String(error)
    this._release()
    this.failed = true
    this.reason = 'TAA failed; disable before retrying'
  }

  _release() {
    this.enabled = false
    this.healthy = false
    this.historyValid = false
    this.historyAge = 0
    this.staticFrames = 0
    if (this.fallback && !this.fallback.released && this.fallback.stage.enabled === this.fallback.applied) {
      this.fallback.stage.enabled = this.fallback.before
    }
    this.fallback = undefined
    this.pendingFallback = undefined
    this.output = undefined
    this.outputFrame = undefined
    this.alphaSource = undefined
    const scene = this.scene
    if (this.attached) {
      scene.preRender.removeEventListener(this.jitterListener)
      scene.postRender.removeEventListener(this.restoreJitterListener)
    }
    this.attached = false
    this.jitterListener = undefined
    this.restoreJitterListener = undefined
    this.overlay?.destroy();this.overlay=undefined
    this.motion?.destroy();this.motion=undefined
    if (this.jitter) { this.jitter.destroy(); this.jitter = undefined }
    if (this.detachSelectionDepth) this.detachSelectionDepth()
    this.detachSelectionDepth = undefined
    if (this.detach) this.detach()
    this.detach = undefined
    this._releaseRhiHistory()
     for (const frame of this.frames || []) {
      if (frame.collection && !frame.collection.isDestroyed()) frame.collection.destroy()
    }
    this.frames = undefined
    if (this.display) { this.display.collection.destroy(); this.display = undefined }
    if (this.depth) {
      if (this.depth.collection && !this.depth.collection.isDestroyed()) this.depth.collection.destroy()
      this.depth = undefined
    }
    this.historyColor = this.historyDepth = undefined
    this.active = 0
    this.historySize = null
  }

  isDestroyed() { return this.destroyed }

  destroy() {
    if (this.destroyed) return
    this._release()
    this.destroyed = true
  }
}
