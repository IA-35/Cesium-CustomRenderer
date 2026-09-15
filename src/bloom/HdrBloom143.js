import { registerHdrEffect } from '../environment/HdrCoordinator143.js'
import { prefilterShader, downsampleShader, upsampleShader, bloomResolveShader } from './bloomShaders143.js'

let nextId = 0

export default class HdrBloom143 {
  constructor(C, scene, getOptions) {
    if (!/^1\.143(?:\.0)?$/.test(C.VERSION)) throw new Error('HdrBloom143 requires Cesium 1.143')
    Object.assign(this, { C, scene, getOptions, enabled: false, destroyed: false, failed: false, error: null, reason: 'Disabled' })
    this.supported = ['webgl2', 'floatingPointTexture', 'colorBufferFloat'].every(key => scene.context && scene.context[key])
    this.stats = { frames: 0, bypasses: 0 }
  }

  _dead() { return this.destroyed || !!(this.scene.isDestroyed && this.scene.isDestroyed()) }

  _createStages() {
    const C = this.C, name = `hdr_bloom_${++nextId}`
    this.levels = this.getOptions().hdrBloomLevels ?? 5
    const make = (suffix, shader, scale, uniforms) => new C.PostProcessStage({
      name: `${name}_${suffix}`, fragmentShader: shader, uniforms, textureScale: scale,
      pixelFormat: C.PixelFormat.RGBA, pixelDatatype: C.PixelDatatype.FLOAT,
      sampleMode: C.PostProcessStageSampleMode.NEAREST, clearColor: C.Color.BLACK })
    const option = (key, fallback) => () => this.getOptions()[key] ?? fallback
    const downs = [], stages = []
    for (let i = 0; i < this.levels; i++) {
      const stage = make(`down_${i}`, i ? downsampleShader : prefilterShader, 0.5 ** (i + 1), {
        u_source: i ? downs[i - 1].name : () => this.inputColor || this.scene.context.defaultTexture,
        ...(i ? {} : { u_threshold: option('hdrBloomThreshold', 1), u_knee: option('hdrBloomKnee', .5) })
      })
      downs.push(stage); stages.push(stage)
    }
    let low = downs[downs.length - 1]
    for (let i = downs.length - 2; i >= 0; i--) {
      low = make(`up_${i}`, upsampleShader, 0.5 ** (i + 1), { u_source: low.name, u_high: downs[i].name })
      stages.push(low)
    }
    stages.push(make('resolve', bloomResolveShader, 1, { u_source: low.name,
      u_original: () => this.inputColor || this.scene.context.defaultTexture, u_strength: option('hdrBloomStrength', .15) }))
    this.stages = stages
    this.composite = new C.PostProcessStageComposite({ name, stages, inputPreviousStageTexture: false })
    this.collection = new C.PostProcessStageCollection()
    this.collection.fxaa.enabled = false
    this.collection.bloom.enabled = false
    this.collection.ambientOcclusion.enabled = false
    this.collection.add(this.composite)
  }

  setEnabled(value) {
    if (this._dead()) return
    if (value && this.enabled && this.levels !== (this.getOptions().hdrBloomLevels ?? 5)) this._release()
    if (!value) {
      this._release(); this.failed = false; this.reason = 'Disabled'
    } else if (!this.enabled && !this.failed && this.supported) {
      try {
        this.error = null
        this._createStages()
        // Reflections 5/6 -> AO 10 -> environment 20 -> bloom 22 -> TAA 25 -> native tonemap.
        this.detach = registerHdrEffect(this.scene, 22, (...args) => this._execute(...args))
        this.enabled = true; this.reason = 'Not rendered'
      } catch (error) { this._fail(error) }
    }
    this.scene.requestRender()
  }

  _scopeReason() {
    if (this._dead()) return 'Destroyed'
    if (!this.supported) return 'Requires WebGL2 float color targets'
    if (!this.enabled) return this.failed ? 'Bloom failed; disable before retrying' : 'Disabled'
    if (this.scene.context._gl.isContextLost()) return 'Context lost'
    if (!this.scene.highDynamicRange) return 'Requires HDR'
    if (this.scene.postProcessStages.bloom.enabled) return 'Native Bloom active'
    return null
  }

  _execute(context, color, depth, id) {
    this.outputFrame = undefined
    const reason = this._scopeReason()
    if (reason || this.getOptions().hdrBloomStrength === 0) {
      this.reason = reason || 'Zero strength'; this.stats.bypasses++; return color
    }
    const viewport = this.C.BoundingRectangle.clone(context.uniformState.viewport)
    try {
      this.inputColor = color
      this.collection.update(context, this.scene.frameState.useLogDepth, false)
      this.collection.clear(context)
      if (!this.collection.ready || !this.composite.ready) { this.reason = 'Not ready'; return color }
      this.collection.execute(context, color, depth, id)
      if (!this.collection.outputTexture) { this.reason = 'No output'; return color }
      this.outputFrame = this.scene.frameState.frameNumber
      this.stats.frames++; this.reason = null
      return this.collection.outputTexture
    } catch (error) { this._fail(error); return color }
    finally { context.uniformState.viewport = viewport }
  }

  getDiagnostics() {
    const textures = new Set((this.stages || []).map(stage => stage.ready && stage.outputTexture).filter(Boolean))
    return { enabled: this.enabled, supported: this.supported, failed: this.failed, error: this.error,
      valid: !this._scopeReason() && this.outputFrame !== undefined && this.outputFrame === this.scene.frameState.frameNumber,
      reason: this._scopeReason() || this.reason, levels: this.levels || 0, stats: { ...this.stats },
      bytes: [...textures].reduce((sum, texture) => sum + texture.sizeInBytes, 0), scope: 'linear HDR bloom before TAA and native tone mapping' }
  }

  _fail(error) { this.error = error.message; this._release(); this.failed = true; this.reason = 'Bloom failed; disable before retrying' }
  _release() {
    this.enabled = false; this.outputFrame = undefined
    if (this.detach) this.detach()
    this.detach = undefined
    if (this.collection && !this.collection.isDestroyed()) this.collection.destroy()
    this.collection = undefined; this.composite = undefined; this.stages = undefined; this.inputColor = undefined
  }
  isDestroyed() { return this.destroyed }
  destroy() { if (!this.destroyed) { this._release(); this.destroyed = true } }
}
