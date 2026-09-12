import { registerHdrEffect } from '../environment/HdrCoordinator143.js'
import { taaResolveShader, taaDepthShader } from './taaShaders143.js'
import TaaJitter143 from './TaaJitter143.js'

let nextId = 0

const clamp = (value, low, high) => Math.max(low, Math.min(high, value))

// The resolve's uniform block: current-frame weight for a static sample, current-frame
// weight once the reprojected motion reaches the threshold, that threshold in pixels, and
// the relative depth tolerance that separates a moved surface from a revealed one.
export function taaBlendWeights(settings = {}) {
  return [clamp(settings.taaHistoryBlend ?? 0.03, 0.02, 0.9),
    clamp(settings.taaMotionBlend ?? 0.5, 0.05, 1),
    clamp(settings.taaVelocityThreshold ?? 12, 1, 64),
    clamp(settings.taaDepthTolerance ?? 0.1, 0, 0.5)]
}

// Temporal anti-aliasing for the Cesium 1.143 HDR chain.
//
// Each frame is rendered with a sub-pixel offset and resolved against the previous frame
// reprojected through the camera's own matrices. The history is two ping-pong colour
// targets so the resolve never reads the texture it writes, plus one eye-depth target:
// Cesium reuses a single depth buffer per frame, so the previous frame's depth has to be
// stored to tell a moved surface apart from a revealed one.
//
// Motion comes from depth rather than a velocity buffer, so only static geometry
// reprojects exactly. A reprojected/current depth mismatch, a reprojection outside the
// frame, and a 3x3 neighbourhood clamp of the current colour all reject stale history
// instead of smearing it. This is not Unreal's TSR: it does not upsample, has no velocity
// or reactive mask, and needs no compute, subgroup or stencil support.
export default class TaaPass143 {
  constructor(C, scene, getOptions) {
    if (!/^1\.143(?:\.0)?$/.test(C.VERSION)) throw new Error('TaaPass143 requires Cesium 1.143')
    Object.assign(this, { C, scene, getOptions, enabled: false, destroyed: false, failed: false })
    const context = scene.context
    this.missing = ['webgl2', 'depthTexture', 'floatingPointTexture', 'colorBufferFloat'].filter(name => !context || !context[name])
    if (context && !(context.halfFloatingPointTexture && context.colorBufferHalfFloat) && !context.colorBufferFloat) {
      this.missing.push('halfFloatingPointTexture/colorBufferFloat')
    }
    this.supported = this.missing.length === 0
    this.error = null
    this.reason = 'Disabled'
    this.healthy = false
    this.output = undefined
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
    this.blend = new Float32Array(4)
    this.blendUniform = new C.Cartesian4()
    this.jitterUv = new C.Cartesian2()
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
    const halfFloat = !!(context.halfFloatingPointTexture && context.colorBufferHalfFloat)
    const datatype = halfFloat ? C.PixelDatatype.HALF_FLOAT : C.PixelDatatype.FLOAT
    const depthUniforms = {
      u_jitterUv: () => this.jitterUv,
      u_surfaceDepth: () => this.surfaceDepth() || fallback(),
      u_hasSurfaceDepth: () => !!this.surfaceDepth()
    }
    const uniforms = {
      ...depthUniforms,
      u_historyColor: () => this.historyColor || fallback(),
      u_historyDepth: () => this.historyDepth || fallback(),
      u_prevViewFromCurrent: () => this.prevViewFromCurrent,
      u_prevProjection: () => this.previousProjection,
      u_taaBlend: () => C.Cartesian4.fromArray(this.blend, 0, this.blendUniform),
      u_staticFrames: () => this.staticFrames,
      u_historyValid: () => this.historyValid ? 1 : 0
    }
    const makeResolve = suffix => new C.PostProcessStage({
      name: `${name}_resolve_${suffix}`, fragmentShader: taaResolveShader, uniforms,
      textureScale: 1, pixelFormat: C.PixelFormat.RGBA, pixelDatatype: datatype,
      // NEAREST on purpose: sampleMode reaches the HDR chain's shared colour texture, which
      // every other effect consumes, and the resolve reads its input with texelFetch anyway.
      // The history's own filtering is set in _synchronizeHistorySamplers.
      sampleMode: C.PostProcessStageSampleMode.NEAREST, clearColor: new C.Color(0, 0, 0, 0)
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
    if (!scene.preUpdate || typeof scene.preUpdate.addEventListener !== 'function') return false
    this.jitterListener = () => this._applyJitter()
    scene.preUpdate.addEventListener(this.jitterListener)
    this.attached = true
    return true
  }

  // Jitter is only advanced while the resolve keeps up. An offset without a matching
  // resolve would show up as a permanently shifted image, so the offset is released
  // whenever the pass bypasses.
  _applyJitter() {
    if (!this.enabled || this.failed || !this.jitter) return
    this._applyFallback()
    const samples = this.getOptions().taaJitterSamples || 8
    if (this.jitter.samples !== samples) { this.jitter.samples = samples; this.resetHistory() }
    if (!this.healthy) { this.jitter.restore(); return }
    this.jitter.apply()
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
        if (!this._attachJitter()) throw new Error('Scene pre-update event is unavailable')
        this.detach = registerHdrEffect(this.scene, 25, (...args) => this._execute(...args))
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
      return color
    }
    const viewport = this.C.BoundingRectangle.clone(context.uniformState.viewport)
    try {
      const scene = this.scene, frame = scene.frameState
      const size = `${color.width}x${color.height}`
      if (size !== this.historySize) {
        // A resized canvas invalidates every stored texel; restart the sequence too so the
        // first accumulated frame does not reuse a sample the history never saw.
        this.historySize = size
        this.resetHistory()
      }
      this.C.Matrix4.clone(scene.camera.viewMatrix, this.view)
      this.C.Matrix4.clone(scene.camera.frustum.projectionMatrix, this.projection)
      const pixel = this.jitter && this.jitter.holding ? this.jitter.pixel : { x: 0, y: 0 }
      this.jitterUv.x = pixel.x / color.width
      this.jitterUv.y = pixel.y / color.height
      // Store the projection of the stable history grid, preserving any caller offset.
      this.projection[8] += 2 * this.jitterUv.x
      this.projection[9] += 2 * this.jitterUv.y

      const destination = this.frames[this.active]
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
      const change = this.prevViewFromCurrent
      this.staticFrames = this.historyValid && this.C.Matrix4.equalsEpsilon(change, this.C.Matrix4.IDENTITY, 1e-7)
        ? this.staticFrames + 1 : 0
      if (this.historyValid && (change[0] + change[5] + change[10] < 2.9 ||
          Math.hypot(change[12], change[13], change[14]) > 500)) this.resetHistory()

      const settings = this.getOptions()
      this.blend.set(taaBlendWeights(settings))
      this.blend[0] = Math.max(this.blend[0], 1 / (this.historyAge + 1))

      destination.collection.update(context, frame.useLogDepth, false)
      destination.collection.clear(context)
      if (!destination.collection.ready) { this.historyValid = false; this.reason = 'Not ready'; return color }
      destination.collection.execute(context, color, depth, id)
      const output = destination.collection.outputTexture
      if (!output) { this.historyValid = false; this.reason = 'No output'; return color }

      // The depth history is written after the resolve so the resolve still reads the
      // previous frame's depth, and the shared depth target can be reused every frame.
      this.depth.collection.update(context, frame.useLogDepth, false)
      this.depth.collection.clear(context)
      if (this.depth.collection.ready) this.depth.collection.execute(context, color, depth, id)

      const previous = this.previousView
      this.previousView = this.view
      this.view = previous
      const previousProjection = this.previousProjection
      this.previousProjection = this.projection
      this.projection = previousProjection

      this.active = 1 - this.active
      this.historyValid = true
      this.historyAge++
      this._fallback(false)
      this.healthy = true
      this.output = output
      this.outputFrame = frame.frameNumber
      this.reason = null
      this.stats.frames++
      return output
    } catch (error) {
      this._fail(error)
      return color
    } finally {
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
    const sampler = texture => texture && texture.sampler
      ? { minificationFilter: texture.sampler.minificationFilter,
        magnificationFilter: texture.sampler.magnificationFilter }
      : null
    return {
      enabled: this.enabled, supported: this.supported, valid: !!this.output,
      reason: this._scopeReason() || this.reason, error: this.error, failed: this.failed,
      stats: { ...this.stats }, historyValid: this.historyValid, historySize: this.historySize,
      activeFrame: this.active, blend: [...this.blend], staticFrames: this.staticFrames,
      jitter: this.jitter ? this.jitter.getDiagnostics() : null,
      samplers: { historyColor: sampler(this.historyColor), historyDepth: sampler(this.historyDepth) },
      bytes: [...textures].reduce((sum, texture) => sum + texture.sizeInBytes, 0),
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
    const scene = this.scene
    if (this.attached && this.jitterListener && scene.preUpdate &&
        typeof scene.preUpdate.removeEventListener === 'function') {
      scene.preUpdate.removeEventListener(this.jitterListener)
    }
    this.attached = false
    this.jitterListener = undefined
    if (this.jitter) { this.jitter.destroy(); this.jitter = undefined }
    if (this.detach) this.detach()
    this.detach = undefined
    for (const frame of this.frames || []) {
      if (frame.collection && !frame.collection.isDestroyed()) frame.collection.destroy()
    }
    this.frames = undefined
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
