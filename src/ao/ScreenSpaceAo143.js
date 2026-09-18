import { registerHdrEffect } from '../environment/HdrCoordinator143.js'
import { aoShader, bilateralShader, resolveShader } from './aoShaders143.js'
import { hbaoShader } from './hbaoShader143.js'
import {installPooledStageCache} from '../pipeline/PooledStageCache143.js'
import {acquireCameraUniforms} from '../buffers/CameraUniforms143.js'
import {uniformBuffersSupported,withUniformBlocks} from '../buffers/UniformBuffer143.js'

let nextId = 0

export default class ScreenSpaceAo143 {
  constructor(C, scene, getMaterials, getOptions) {
    if (!/^1\.143(?:\.0)?$/.test(C.VERSION)) throw new Error('ScreenSpaceAo143 requires Cesium 1.143')
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
    if (!this.enabled) return this.failed ? 'AO failed; disable before retrying' : 'Disabled'
    if (this.scene.context._gl.isContextLost()) return 'Context lost'
    if (!this.scene.highDynamicRange) return 'Requires HDR'
    if (!(this.scene.camera.frustum instanceof this.C.PerspectiveFrustum)) return 'Requires symmetric perspective camera'
    if (this.scene.postProcessStages.ambientOcclusion.enabled) return 'Native AO active'
    const source = this.getMaterials()
    if (!source || !source.getTextures()) return 'No current material depth'
    if (!source.getDepthPyramidLevels()) return 'No current Hi-Z depth'
    if (!source.getTextures().transparency) return 'No current transparency coverage'
    return null
  }

  _createStages() {
    const C = this.C, scene = this.scene, name = `screen_ao_${++nextId}`
    this.poolRequested=this.getOptions().renderTargetPoolEnabled!==false
    if(uniformBuffersSupported(scene.context))this.cameraUniforms=acquireCameraUniforms(C,scene)
    this.inverseProjection = new C.Matrix4()
    const fallback = () => scene.context.defaultTexture
    const option = (name, value) => () => this.getOptions()[name] ?? value
    const uniforms = {
      u_depth: () => this.materials ? this.materials.eyeDepth : fallback(),
      u_material: () => this.materials ? this.materials.normalRoughMetal : fallback(),
      u_flags: () => this.materials ? this.materials.emissiveFlags : fallback(),
      u_transparency: () => this.materials ? this.materials.transparency : fallback(),
      u_hiz: () => this.hiz || fallback(),
      u_inverseProjection: () => this.inverseProjection,
      u_radius: option('screenSpaceAoRadius', 3), u_strength: option('screenSpaceAoStrength', 1),
      u_bias: option('screenSpaceAoBias', .08)
    }
    const make = (suffix, fragmentShader, extras = {}, scale = .5, datatype = C.PixelDatatype.UNSIGNED_BYTE) => new C.PostProcessStage({
      name: `${name}_${suffix}`, fragmentShader:(this.cameraUniforms?'#define CCR_CAMERA_UBO\n':'')+fragmentShader, uniforms: { ...uniforms, ...extras }, textureScale: scale,
      pixelFormat: C.PixelFormat.RGBA, pixelDatatype: datatype, sampleMode: C.PostProcessStageSampleMode.NEAREST,
      clearColor: new C.Color(1, 0, 0, 1)
    })
    this.algorithm = this.getOptions().screenSpaceAoAlgorithm === 'hbao' ? 'hbao' : 'ssao'
    const raw = make('raw', this.algorithm === 'hbao' ? hbaoShader : aoShader)
    const horizontal = make('horizontal', bilateralShader, { u_visibility: raw.name, u_axis: new C.Cartesian2(1, 0) })
    const vertical = make('vertical', bilateralShader, { u_visibility: horizontal.name, u_axis: new C.Cartesian2(0, 1) })
    const resolve = make('resolve', resolveShader, { u_visibility: vertical.name }, 1, C.PixelDatatype.FLOAT)
    this.stages = { raw, horizontal, vertical, resolve }
    this.composite = new C.PostProcessStageComposite({ name, stages: [raw, horizontal, vertical, resolve], inputPreviousStageTexture: false })
    this.collection = new C.PostProcessStageCollection()
    this.collection.fxaa.enabled = false
    this.collection.bloom.enabled = false
    this.collection.ambientOcclusion.enabled = false
    this.collection.add(this.composite)
    if(this.getOptions().renderTargetPoolEnabled!==false)this.pooled=installPooledStageCache(C,scene,this.collection,Object.values(this.stages),'ao',[vertical.name])
  }

  setEnabled(value) {
    if (this.destroyed || this._sceneDestroyed()) return
    const algorithm = this.getOptions().screenSpaceAoAlgorithm === 'hbao' ? 'hbao' : 'ssao'
    if (value && this.enabled && (this.algorithm !== algorithm||this.poolRequested!==(this.getOptions().renderTargetPoolEnabled!==false))) this._release()
    if (!value) {
      this._release()
      this.failed = false
      this.reason = 'Disabled'
    } else if (!this.enabled && !this.failed && this.supported) {
      try {
        this.error = null
        this._createStages()
        this.detach = registerHdrEffect(this.scene, 10, (...args) => this.getMaterials()?.compactActive ? args[1] : this._execute(...args))
        this.enabled = true
        this.reason = 'Not rendered'
      } catch (error) { this._fail(error) }
    }
    this.scene.requestRender()
  }

  prepareVisibility(context, color) { return this._execute(context, color, undefined, undefined) }

  _execute(context, color, depth, id) {
    this.outputFrame = undefined
    const reason = this._scopeReason()
    if (reason) { this.pooled?.releaseFrame();this.reason = reason; this.stats.bypasses++; return color }
    const viewport = this.C.BoundingRectangle.clone(context.uniformState.viewport)
    try {
      const owner = this.getMaterials()
      this.materials = owner.getTextures()
      this.hiz = owner.getDepthPyramidLevels()[0].texture
      this.C.Matrix4.inverse(this.scene.camera.frustum.projectionMatrix, this.inverseProjection)
      this.pooled?.begin(color)
      this.collection.update(context, this.scene.frameState.useLogDepth, false)
      this.collection.clear(context)
      if (!this.collection.ready || !this.composite.ready) { this.reason = 'Not ready';this.pooled?.releaseFrame(); return color }
      this._validateTargets(context)
      const execute=()=>this.collection.execute(context, color, depth, id)
      if(this.cameraUniforms){this.cameraUniforms.update();withUniformBlocks(context._gl,Object.values(this.stages).map(stage=>stage._command.shaderProgram),[{name:'CampusCamera',buffer:this.cameraUniforms.buffer}],execute)}
      else execute()
      if (!this.collection.outputTexture) { this.reason = 'No output'; return color }
      this.outputFrame = this.scene.frameState.frameNumber
      this.reason = null
      this.stats.frames++
      return this.collection.outputTexture
    } catch (error) {
      this._fail(error)
      return color
    } finally { this.pooled?.end();context.uniformState.viewport = viewport }
  }

  _validateTargets(context) {
    const targets = [...new Set(Object.values(this.stages).map(stage => stage._textureCache.getFramebuffer(stage.name)))]
    if (targets.some(target => !target)) throw new Error('AO framebuffer is not ready')
    const pending = targets.filter(target => !this.validatedTargets.has(target))
    if (!pending.length) return
    const gl = context._gl, read = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING), draw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)
    try {
      for (const target of pending) {
        if (target.status !== gl.FRAMEBUFFER_COMPLETE) throw new Error('AO framebuffer is incomplete')
        this.validatedTargets.add(target)
      }
    } finally { gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, draw) }
  }

  getVisibilityTexture() {
    if (this._scopeReason() || this.outputFrame !== this.scene.frameState.frameNumber || !this.stages) return null
    const texture = this.stages.vertical.outputTexture
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
    return { enabled: this.enabled, supported: this.supported, valid: !!this.getVisibilityTexture(), algorithm: this.algorithm || 'ssao',
      reason: this._scopeReason() || this.reason, error: this.error, failed: this.failed, stats: { ...this.stats },
      bytes: this.pooled?this.pooled.getDiagnostics().bytes:[...textures].reduce((sum, texture) => sum + texture.sizeInBytes, 0),pooled:this.pooled?.getDiagnostics(),cameraUniforms:this.cameraUniforms?.getDiagnostics(),
      scope: this.getMaterials()?.compactActive ? 'indirect lighting visibility; legacy color modulation bypassed'
        : 'screen-space non-emissive HDR modulation; not isolated indirect lighting',
      allocationScope: 'distinct active AO collection textures, excludes materials/Hi-Z/source HDR' }
  }

  _fail(error) {
    this.error = error.message
    this._release()
    this.failed = true
    this.reason = 'AO failed; disable before retrying'
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
    this.hiz = undefined
    this.pooled = null
    this.cameraUniforms?.release();this.cameraUniforms=null
    this.validatedTargets = new WeakSet()
  }

  isDestroyed() { return this.destroyed }
  destroy() {
    if (this.destroyed) return
    this._release()
    this.destroyed = true
  }
}
