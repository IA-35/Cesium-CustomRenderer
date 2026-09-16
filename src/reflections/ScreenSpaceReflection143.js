import { registerHdrEffect } from '../environment/HdrCoordinator143.js'
import { traceShader, resolveShader } from './ssrShaders143.js'
import { isSubPixelOffset } from '../antialiasing/jitter143.js'
import UniformBuffer143, { withUniformBlocks } from '../buffers/UniformBuffer143.js'
import { acquireCameraUniforms } from '../buffers/CameraUniforms143.js'

let nextId = 0

export default class ScreenSpaceReflection143 {
  constructor(C, scene, getMaterials, getOptions) {
    if (!/^1\.143(?:\.0)?$/.test(C.VERSION)) throw new Error('ScreenSpaceReflection143 requires Cesium 1.143')
    Object.assign(this, { C, scene, getMaterials, getOptions, enabled: false, destroyed: false, failed: false })
    this.missing = ['webgl2', 'depthTexture', 'floatingPointTexture', 'colorBufferFloat'].filter(name => !scene.context || !scene.context[name])
    this.supported = this.missing.length === 0
    this.error = null
    this.reason = 'Disabled'
    this.outputFrame = undefined
    this.stats = { frames: 0, bypasses: 0 }
    this.validatedTargets = new WeakSet()
  }

  _sceneDestroyed() { return !!(this.scene.isDestroyed && this.scene.isDestroyed()) }

  _scopeReason() {
    if (this.destroyed || this._sceneDestroyed()) return 'Destroyed'
    if (!this.supported) return `Missing ${this.missing.join(', ')}`
    if (!this.enabled) return this.failed ? 'SSR failed; disable before retrying' : 'Disabled'
    if (this.scene.context._gl.isContextLost()) return 'Context lost'
    if (!this.scene.highDynamicRange) return 'Requires HDR'
    const frustum = this.scene.camera.frustum
    // Temporal anti-aliasing jitters the frustum by less than a pixel every frame. That is
    // still a symmetric camera for this pass, so only reject offsets beyond that budget.
    if (!(frustum instanceof this.C.PerspectiveFrustum) ||
        !isSubPixelOffset(frustum, { width: this.scene.drawingBufferWidth, height: this.scene.drawingBufferHeight })) {
      return 'Requires symmetric perspective camera'
    }
    const source = this.getMaterials()
    const textures = source && source.getTextures()
    if (!textures) return 'No current material depth'
    if (!textures.eyeDepth || !textures.normalRoughMetal || !textures.emissiveFlags) return 'No current material inputs'
    if (!textures.transparency) return 'No current transparency coverage'
    if (!textures.reflectionSpecular || !textures.reflectionResponse || !source.getReflectionDiagnostics().valid) return 'No current reflection material inputs'
    const levels = source.getDepthPyramidLevels()
    if (!levels || !levels.length || levels.some(level => !level.texture)) return 'No current Hi-Z depth'
    return null
  }

  _createStages() {
    const C = this.C, scene = this.scene, name = `screen_reflection_${++nextId}`
    const gl = scene.context._gl
    if (scene.context.webgl2 && ['createBuffer', 'deleteBuffer', 'bindBuffer', 'bufferData', 'bufferSubData', 'getParameter',
      'getUniformBlockIndex', 'getProgramParameter', 'uniformBlockBinding', 'bindBufferBase', 'bindBufferRange',
      'getIndexedParameter', 'getActiveUniformBlockParameter'].every(key => typeof gl[key] === 'function')) {
      this.cameraUniforms = acquireCameraUniforms(C, scene)
      this.reflectionUniforms = new UniformBuffer143(gl, 16)
    }
    this.projection = new C.Matrix4()
    this.inverseProjection = new C.Matrix4()
    const fallback = () => scene.context.defaultTexture
    const option = (name, value) => () => this.getOptions()[name] ?? value
    const uniforms = {
      u_depth: () => this.materials ? this.materials.eyeDepth : fallback(),
      u_material: () => this.materials ? this.materials.normalRoughMetal : fallback(),
      u_flags: () => this.materials ? this.materials.emissiveFlags : fallback(),
      u_transparency: () => this.materials ? this.materials.transparency : fallback(),
      u_specular: () => this.materials ? this.materials.reflectionSpecular : fallback(),
      u_response: () => this.materials ? this.materials.reflectionResponse : fallback(),
      u_inverseProjection: () => this.inverseProjection,
      u_strength: option('screenSpaceReflectionStrength', 1)
    }
    const traceUniforms = { u_projection: () => this.projection,
      u_near: () => scene.camera.frustum.near,
      u_distance: option('screenSpaceReflectionDistance', 150),
      u_thickness: option('screenSpaceReflectionThickness', .5),
      u_maxLevel: () => this.levels ? Math.min(5, this.levels.length) : 0 }
    for (let i = 0; i < 5; i++) {
      traceUniforms[`u_hiz${i}`] = () => this.levels ? this.levels[Math.min(i, this.levels.length - 1)].texture : fallback()
    }
    const make = (suffix, fragmentShader, extras, scale, datatype) => new C.PostProcessStage({
      name: `${name}_${suffix}`, fragmentShader: (this.cameraUniforms ? '#define CAMPUS_REFLECTION_UBO\n' : '') + fragmentShader,
      uniforms: { ...uniforms, ...extras }, textureScale: scale,
      pixelFormat: C.PixelFormat.RGBA, pixelDatatype: datatype, sampleMode: C.PostProcessStageSampleMode.NEAREST,
      clearColor: new C.Color(0, 0, 0, 0)
    })
    const halfFloat = scene.context.halfFloatingPointTexture && scene.context.colorBufferHalfFloat
    const trace = make('trace', traceShader, traceUniforms, .5, halfFloat ? C.PixelDatatype.HALF_FLOAT : C.PixelDatatype.FLOAT)
    const resolve = make('resolve', resolveShader, { u_reflection: trace.name }, 1, C.PixelDatatype.FLOAT)
    this.stages = { trace, resolve }
    this.composite = new C.PostProcessStageComposite({ name, stages: [trace, resolve], inputPreviousStageTexture: false })
    this.collection = new C.PostProcessStageCollection()
    this.collection.fxaa.enabled = false
    this.collection.bloom.enabled = false
    this.collection.ambientOcclusion.enabled = false
    this.collection.add(this.composite)
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
        this._createStages()
        this.detach = registerHdrEffect(this.scene, 5, (...args) => this.getMaterials()?.compactActive ? args[1] : this._execute(...args))
        this.enabled = true
        this.reason = 'Not rendered'
      } catch (error) { this._fail(error) }
    }
    this.scene.requestRender()
  }

  _execute(context, color, depth, id) {
    this.outputFrame = undefined
    const reason = this._scopeReason()
    if (reason) { this.reason = reason; this.stats.bypasses++; return color }
    const viewport = this.C.BoundingRectangle.clone(context.uniformState.viewport)
    try {
      const owner = this.getMaterials()
      this.materials = owner.getTextures()
      this.levels = owner.getDepthPyramidLevels()
      this.C.Matrix4.clone(this.scene.camera.frustum.projectionMatrix, this.projection)
      this.C.Matrix4.inverse(this.projection, this.inverseProjection)
      this.collection.update(context, this.scene.frameState.useLogDepth, false)
      this.collection.clear(context)
      if (!this.collection.ready || !this.composite.ready) { this.reason = 'Not ready'; return color }
      this._validateTargets(context)
      const execute = () => this.collection.execute(context, color, depth, id)
      if (this.cameraUniforms) {
        const settings = this.getOptions()
        this.cameraUniforms.update()
        this.reflectionUniforms.update(new Float32Array([settings.screenSpaceReflectionDistance ?? 150,
          settings.screenSpaceReflectionThickness ?? .5, settings.screenSpaceReflectionStrength ?? 1, Math.min(5, this.levels.length)]))
        withUniformBlocks(context._gl, Object.values(this.stages).map(stage => stage._command.shaderProgram), [
          { name: 'CampusCamera', buffer: this.cameraUniforms.buffer },
          { name: 'CampusReflection', buffer: this.reflectionUniforms }
        ], execute)
      } else execute()
      if (!this.collection.outputTexture || !this.stages.trace.outputTexture) { this.reason = 'No output'; return color }
      this.outputFrame = this.scene.frameState.frameNumber
      this.reason = null
      this.stats.frames++
      return this.collection.outputTexture
    } catch (error) {
      this._fail(error)
      return color
    } finally {
      context.uniformState.viewport = viewport
      if (this.outputFrame === undefined) this.stats.bypasses++
    }
  }
  prepareOpaque(context,color){return this._execute(context,color)}

  _validateTargets(context) {
    const targets = [...new Set(Object.values(this.stages).map(stage => stage._textureCache.getFramebuffer(stage.name)))]
    if (targets.some(target => !target)) throw new Error('SSR framebuffer is not ready')
    const pending = targets.filter(target => !this.validatedTargets.has(target))
    if (!pending.length) return
    const gl = context._gl, read = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING), draw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)
    try {
      for (const target of pending) {
        if (target.status !== gl.FRAMEBUFFER_COMPLETE) throw new Error('SSR framebuffer is incomplete')
        this.validatedTargets.add(target)
      }
    } finally { gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, draw) }
  }

  getReflectionTexture() {
    if (this._scopeReason() || this.outputFrame !== this.scene.frameState.frameNumber || !this.stages) return null
    const texture = this.stages.trace.outputTexture
    return texture && !texture.isDestroyed() ? texture : null
  }

  getDiagnostics() {
    const textures = new Set()
    if (this.collection && !this.collection.isDestroyed()) {
      for (const stage of Object.values(this.stages)) {
        const texture = stage.ready && stage.outputTexture
        if (texture && !texture.isDestroyed()) textures.add(texture)
      }
    }
    return { enabled: this.enabled, supported: this.supported, valid: !!this.getReflectionTexture(),
      reason: this._scopeReason() || this.reason, error: this.error, failed: this.failed, stats: { ...this.stats },
      bytes: [...textures].reduce((sum, texture) => sum + texture.sizeInBytes, 0),
      uniformBuffers: { camera: this.cameraUniforms ? this.cameraUniforms.getDiagnostics() : null,
        reflection: this.reflectionUniforms ? this.reflectionUniforms.getDiagnostics() : null },
      lightingSource: this.getMaterials()?.getReflectionDiagnostics?.().source || 'native-replay',
      scope: this.getMaterials()?.compactActive ? 'replace deferred environment specular before OIT composition'
        : 'screen-space reflection replacing supported native specular before AO and environment',
      allocationScope: 'distinct active SSR collection textures, excludes materials/Hi-Z/source HDR' }
  }

  _fail(error) {
    this.error = error.message
    this._release()
    this.failed = true
    this.reason = 'SSR failed; disable before retrying'
  }

  _release() {
    this.enabled = false
    this.outputFrame = undefined
    if (this.detach) this.detach()
    this.detach = undefined
    if (this.collection && !this.collection.isDestroyed()) this.collection.destroy()
    this.collection = undefined
    this.composite = undefined
    this.stages = undefined
    this.materials = undefined
    this.levels = undefined
    if (this.reflectionUniforms) this.reflectionUniforms.destroy()
    if (this.cameraUniforms) this.cameraUniforms.release()
    this.reflectionUniforms = this.cameraUniforms = undefined
    this.validatedTargets = new WeakSet()
  }

  isDestroyed() { return this.destroyed }
  destroy() {
    if (this.destroyed) return
    this._release()
    this.destroyed = true
  }
}
