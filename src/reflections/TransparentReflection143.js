import { registerHdrEffect } from '../environment/HdrCoordinator143.js'
import { transparentReflectionSources } from './transparentReflectionShader143.js'
import { isSubPixelOffset } from '../antialiasing/jitter143.js'
import UniformBuffer143, { withUniformBlocks } from '../buffers/UniformBuffer143.js'
import { acquireCameraUniforms } from '../buffers/CameraUniforms143.js'

class TransparentScopeError extends Error {}

const resolveShader = `
uniform sampler2D u_color;
uniform sampler2D u_delta;
uniform sampler2D u_accumulation;
uniform sampler2D u_revealage;
uniform bool u_oit;
uniform bool u_mrt;
in vec2 v_textureCoordinates;
void main() {
    vec4 color = texture(u_color, v_textureCoordinates);
    vec3 delta = texture(u_delta, v_textureCoordinates).rgb;
    float factor = 1.0;
    if (u_oit) {
        vec4 accumulation = texture(u_accumulation, v_textureCoordinates);
        float revealage = texture(u_revealage, v_textureCoordinates).r;
        float denominator = u_mrt ? revealage : accumulation.a;
        float transparency = u_mrt ? accumulation.a : revealage;
        factor = (1.0 - transparency) / clamp(denominator, 1.0e-4, 5.0e4);
    }
    out_FragColor = vec4(color.rgb + delta * factor, color.a);
}`

export default class TransparentReflection143 {
  constructor(C, scene, getMaterials, getOptions) {
    if (!/^1\.143(?:\.0)?$/.test(C.VERSION)) throw new Error('TransparentReflection143 requires Cesium 1.143')
    Object.assign(this, { C, scene, getMaterials, getOptions, enabled: false, destroyed: false, failed: false })
    this.missing = ['webgl2', 'depthTexture', 'floatingPointTexture', 'colorBufferFloat', 'floatBlend'].filter(key => !scene.context[key])
    this.supported = !this.missing.length
    this.reason = 'Disabled'
    this.error = null
    this.programs = new Map()
    this.states = new Map()
    this.stats = { frames: 0, draws: 0, bypasses: 0 }
    this.projection = new C.Matrix4()
    this.inverseProjection = new C.Matrix4()
  }

  _sceneDestroyed() { return !!(this.scene.isDestroyed && this.scene.isDestroyed()) }

  _scopeReason() {
    const scene = this.scene
    if (this.destroyed || this._sceneDestroyed()) return 'Destroyed'
    if (!this.supported) return `Missing ${this.missing.join(', ')}`
    if (!this.enabled) return this.failed ? 'Transparent reflection failed; disable before retrying' : 'Disabled'
    if (scene.context._gl.isContextLost()) return 'Context lost'
    if (!scene.highDynamicRange) return 'Requires HDR'
    const frustum = scene.camera.frustum, passes = scene.frameState.passes
    // Temporal anti-aliasing jitters the frustum by less than a pixel every frame. That is
    // still a symmetric camera for this pass, so only reject offsets beyond that budget.
    if (!(frustum instanceof this.C.PerspectiveFrustum) ||
        !isSubPixelOffset(frustum, { width: scene.drawingBufferWidth, height: scene.drawingBufferHeight })) {
      return 'Requires symmetric perspective camera'
    }
    if (!passes.render || passes.pick || passes.depth) return 'Requires color render frame'
    const source = this.getMaterials(), textures = source && source.getTextures()
    if (!textures || !source.getOpaqueColorDiagnostics().valid) return 'No current opaque color'
    if (['eyeDepth', 'normalRoughMetal', 'emissiveFlags', 'transparency', 'reflectionSpecular', 'reflectionResponse', 'opaqueColor'].some(key => !textures[key])) return 'No current reflection material inputs'
    const levels = source.getDepthPyramidLevels()
    if (!levels || !levels.length || levels.some(level => !level.texture)) return 'No current Hi-Z'
    const oit = scene._view.oit
    if (scene._environmentState.useOIT && (!oit || !oit._accumulationTexture || !oit._revealageTexture)) return 'No current OIT textures'
    if (!scene._view.frustumCommandsList || !scene._view.frustumCommandsList.length) return 'No current frusta'
    return null
  }

  setEnabled(value) {
    if (this.destroyed || this._sceneDestroyed()) return
    if (!value) { this._release(); this.failed = false; this.reason = 'Disabled' }
    else if (!this.enabled && !this.failed && this.supported) {
      try {
        this.error = null
        const gl = this.scene.context._gl
        if (this.scene.context.webgl2 && ['createBuffer', 'deleteBuffer', 'bindBuffer', 'bufferData', 'bufferSubData', 'getParameter',
          'getUniformBlockIndex', 'getProgramParameter', 'uniformBlockBinding', 'bindBufferBase', 'bindBufferRange',
          'getIndexedParameter', 'getActiveUniformBlockParameter'].every(key => typeof gl[key] === 'function')) {
          this.cameraUniforms = acquireCameraUniforms(this.C, this.scene)
          this.reflectionUniforms = new UniformBuffer143(gl, 16)
        }
        this.detach = registerHdrEffect(this.scene, 6, (...args) => this._execute(...args))
        this.enabled = true
        this.reason = 'Not rendered'
      } catch (error) {
        this.error = error.message
        this._release()
        this.failed = true
        this.reason = 'Transparent reflection failed; disable before retrying'
      }
    }
    this.scene.requestRender()
  }

  _uniforms() {
    const option = (key, value) => () => this.getOptions()[key] ?? value
    const uniforms = { u_projection: () => this.projection, u_inverseProjection: () => this.inverseProjection,
      u_near: () => this.scene.camera.frustum.near, u_maxLevel: () => Math.min(5, this.levels.length),
      u_distance: option('screenSpaceReflectionDistance', 150), u_thickness: option('screenSpaceReflectionThickness', .5),
      u_strength: option('screenSpaceReflectionStrength', 1) }
    for (const [name, key] of Object.entries({ depth: 'eyeDepth', material: 'normalRoughMetal', flags: 'emissiveFlags',
      transparency: 'transparency', specular: 'reflectionSpecular', response: 'reflectionResponse', sourceColor: 'opaqueColor' })) {
      uniforms[`u_${name}`] = () => this.materials[key]
    }
    for (let i = 0; i < 5; i++) uniforms[`u_hiz${i}`] = () => this.levels[Math.min(i, this.levels.length - 1)].texture
    return uniforms
  }

  _prepare(original) {
    const C = this.C, scene = this.scene, frame = scene.frameState.frameNumber
    if (scene.debugCommandFilter && !scene.debugCommandFilter(original)) return null
    let command = original
    if (scene.frameState.useLogDepth && command.derivedCommands && command.derivedCommands.logDepth) command = command.derivedCommands.logDepth.command
    if (scene.highDynamicRange && command.derivedCommands && command.derivedCommands.hdr) command = command.derivedCommands.hdr.command
    const map = command.uniformMap || {}, source = command.shaderProgram
    if (!source || !command.renderState || (map.u_isEdgePass && map.u_isEdgePass()) || (map.model_silhouettePass && map.model_silhouettePass())) throw new TransparentScopeError('Unsupported transparent shader/edge/silhouette')
    const stateKey = `${this.mode}:${command.renderState.id}`
    let state = this.states.get(stateKey)
    if (!state) {
      const options = C.RenderState.getState(command.renderState), stencil = options.stencilTest
      const B = C.BlendFunction, additive = this.mode === 'oit'
      const depth = options.depthTest, blend = options.blending
      if (!depth.enabled || ![C.DepthFunction.LESS, C.DepthFunction.LESS_OR_EQUAL].includes(depth.func) || options.depthMask !== false) throw new TransparentScopeError('Unsupported transparent depth test/write state')
      if (Object.values(options.colorMask).some(value => value === false)) throw new TransparentScopeError('Masked transparent color channels not supported')
      // OIT replaces blending itself. Sorted replay must reproduce native RGB
      // alpha blending; the source alpha attachment factors do not affect RGB.
      if (!additive && (!blend.enabled || blend.equationRgb !== C.BlendEquation.ADD ||
        blend.functionSourceRgb !== B.SOURCE_ALPHA || blend.functionDestinationRgb !== B.ONE_MINUS_SOURCE_ALPHA)) throw new TransparentScopeError('Unsupported sorted transparent RGB blending')
      if (stencil.enabled && (stencil.frontFunction !== C.StencilFunction.ALWAYS || stencil.backFunction !== C.StencilFunction.ALWAYS)) throw new TransparentScopeError('Complex transparent stencil not supported')
      options.depthTest = { enabled: false }
      options.depthMask = false
      options.stencilTest = { enabled: false }
      options.stencilMask = 0
      options.colorMask = { red: true, green: true, blue: true, alpha: true }
      options.blending = { enabled: true, equationRgb: C.BlendEquation.ADD, equationAlpha: C.BlendEquation.ADD,
        functionSourceRgb: additive ? B.ONE : B.SOURCE_ALPHA, functionDestinationRgb: additive ? B.ONE : B.ONE_MINUS_SOURCE_ALPHA,
        functionSourceAlpha: B.ONE, functionDestinationAlpha: additive ? B.ONE : B.ONE_MINUS_SOURCE_ALPHA }
      state = { options, value: C.RenderState.fromCache(options) }
      this.states.set(stateKey, state)
    }
    state.frame = frame
    const key = `${this.mode}:${source.id}`
    let record = this.programs.get(key)
    if (!record) {
      const sources = transparentReflectionSources(C, source, { mode: this.mode })
      if (!sources) throw new TransparentScopeError('Unsupported transparent shader interface')
      if (this.cameraUniforms) sources.fragmentShaderSource.defines.push('CAMPUS_REFLECTION_UBO')
      record = { program: C.ShaderProgram.fromCache({ context: scene.context, ...sources, attributeLocations: source._attributeLocations }) }
      this.programs.set(key, record)
    }
    record.frame = frame
    const derived = C.DrawCommand.shallowClone(command)
    Object.assign(derived, { shaderProgram: record.program, renderState: state.value,
      uniformMap: { ...map, ...this._uniforms(), campus_transparentStrictDepth: () => command.renderState.depthTest.func === C.DepthFunction.LESS },
      castShadows: false, receiveShadows: false })
    return derived
  }

  _allocate(width, height) {
    this._releaseTarget()
    const C = this.C, context = this.scene.context
    const target = this.target = { width, height }
    const sampler = new C.Sampler({ minificationFilter: C.TextureMinificationFilter.NEAREST, magnificationFilter: C.TextureMagnificationFilter.NEAREST })
    for (const name of ['delta', 'output']) {
      target[name] = new C.Texture({ context, width, height, pixelFormat: C.PixelFormat.RGBA, pixelDatatype: C.PixelDatatype.FLOAT, sampler })
      target[`${name}Framebuffer`] = new C.Framebuffer({ context, colorTextures: [target[name]], destroyAttachments: false })
      if (target[`${name}Framebuffer`].status !== context._gl.FRAMEBUFFER_COMPLETE) throw new Error('Transparent reflection framebuffer is incomplete')
    }
    target.passState = new C.PassState(context)
    target.passState.viewport = new C.BoundingRectangle(0, 0, width, height)
    target.passState.framebuffer = target.deltaFramebuffer
    target.clear = new C.ClearCommand({ color: C.Color.TRANSPARENT, framebuffer: target.deltaFramebuffer })
    target.stateOptions = { viewport: target.passState.viewport, depthTest: { enabled: false }, depthMask: false, blending: { enabled: false } }
    target.resolve = context.createViewportQuadCommand(resolveShader, { owner: this, framebuffer: target.outputFramebuffer,
      renderState: C.RenderState.fromCache(target.stateOptions), uniformMap: {
        u_color: () => this.inputColor, u_delta: () => this.target.delta, u_oit: () => this.mode === 'oit',
        u_mrt: () => !!(this.scene._view.oit && this.scene._view.oit._translucentMRTSupport),
        u_accumulation: () => this.mode === 'oit' ? this.scene._view.oit._accumulationTexture : this.target.delta,
        u_revealage: () => this.mode === 'oit' ? this.scene._view.oit._revealageTexture : this.target.delta } })
  }

  _execute(context, color) {
    this.outputFrame = undefined
    this.stats.draws = 0
    const reason = this._scopeReason()
    if (reason) { this.reason = reason; this.stats.bypasses++; return color }
    const C = this.C, scene = this.scene, uniforms = context.uniformState, gl = context._gl
    const viewport = C.BoundingRectangle.clone(uniforms.viewport), previousPass = uniforms.pass
    const read = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING), draw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING), framebuffer = context._currentFramebuffer
    try {
      this.mode = scene._environmentState.useOIT ? 'oit' : 'sorted'
      this.materials = this.getMaterials().getTextures()
      this.levels = this.getMaterials().getDepthPyramidLevels()
      this.inputColor = color
      C.Matrix4.clone(scene.camera.frustum.projectionMatrix, this.projection)
      C.Matrix4.inverse(this.projection, this.inverseProjection)
      // Validate every visible layer before drawing any delta: skipped front layers
      // would otherwise expose reflections accumulated behind them in sorted mode.
      const bins = [...scene._view.frustumCommandsList].reverse().map(bin => ({ bin,
        commands: (bin.commands[C.Pass.TRANSLUCENT] || []).slice(0, bin.indices[C.Pass.TRANSLUCENT] || 0).map(command => this._prepare(command)).filter(Boolean) }))
      const width = scene.drawingBufferWidth, height = scene.drawingBufferHeight
      if (!width || !height) { this.reason = 'Empty drawing buffer'; return color }
      if (!this.target || this.target.width !== width || this.target.height !== height) this._allocate(width, height)
      const target = this.target
      if (color === target.output || color === target.delta) throw new TransparentScopeError('Transparent reflection input/output feedback')
      uniforms.updateCamera(scene.camera)
      uniforms.viewport = target.passState.viewport
      target.clear.execute(context, target.passState)
      const frustum = scene.camera.frustum.clone()
      const replay = () => {
        for (const { bin, commands } of bins) {
          frustum.near = bin.near; frustum.far = bin.far
          uniforms.updateFrustum(frustum)
          uniforms.updatePass(C.Pass.TRANSLUCENT)
          for (const command of commands) {
            command.framebuffer = target.deltaFramebuffer
            command.execute(context, target.passState)
            this.stats.draws++
          }
        }
      }
      if (this.cameraUniforms) {
        const settings = this.getOptions()
        this.cameraUniforms.update()
        this.reflectionUniforms.update(new Float32Array([settings.screenSpaceReflectionDistance ?? 150,
          settings.screenSpaceReflectionThickness ?? .5, settings.screenSpaceReflectionStrength ?? 1, Math.min(5, this.levels.length)]))
        withUniformBlocks(gl, bins.flatMap(({ commands }) => commands.map(command => command.shaderProgram)), [
          { name: 'CampusCamera', buffer: this.cameraUniforms.buffer },
          { name: 'CampusReflection', buffer: this.reflectionUniforms }
        ], replay)
      } else replay()
      uniforms.updateCamera(scene.camera)
      uniforms.updateFrustum(scene.camera.frustum)
      target.resolve.execute(context, target.passState)
      this.outputFrame = scene.frameState.frameNumber
      this.stats.frames++
      this.reason = null
      return target.output
    } catch (error) {
      if (error instanceof TransparentScopeError) this.reason = error.message
      else {
        this.error = error.message
        this._release()
        this.failed = true
        this.reason = 'Transparent reflection failed; disable before retrying'
      }
      return color
    } finally {
      uniforms.updateCamera(scene.camera)
      uniforms.updateFrustum(scene.camera.frustum)
      uniforms.updatePass(previousPass)
      uniforms.viewport = viewport
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read)
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, draw)
      context._currentFramebuffer = framebuffer
      if (this.outputFrame === undefined) this.stats.bypasses++
      this._prune()
    }
  }

  _prune() {
    const cutoff = this.scene.frameState.frameNumber - 120
    for (const [key, record] of this.programs) if (record.frame < cutoff) {
      if (!record.program.isDestroyed()) record.program.destroy()
      this.programs.delete(key)
    }
    for (const [key, record] of this.states) if (record.frame < cutoff) {
      this.C.RenderState.removeFromCache(record.options)
      this.states.delete(key)
    }
  }

  getDeltaTexture() {
    if (this._scopeReason() || this.outputFrame === undefined || this.outputFrame !== this.scene.frameState.frameNumber || !this.target ||
      this.target.width !== this.scene.drawingBufferWidth || this.target.height !== this.scene.drawingBufferHeight) return null
    return this.target.delta.isDestroyed() ? null : this.target.delta
  }

  getDiagnostics() {
    const textures = this.target ? [...new Set([this.target.delta, this.target.output])].filter(texture => texture && !texture.isDestroyed()) : []
    return { enabled: this.enabled, supported: this.supported, valid: !!this.getDeltaTexture(), failed: this.failed,
      error: this.error, reason: this._scopeReason() || this.reason, mode: this.mode, stats: { ...this.stats },
      bytes: textures.reduce((sum, texture) => sum + texture.sizeInBytes, 0),
      uniformBuffers: { camera: this.cameraUniforms ? this.cameraUniforms.getDiagnostics() : null,
        reflection: this.reflectionUniforms ? this.reflectionUniforms.getDiagnostics() : null },
      allocationScope: 'owned RGBA32F delta and resolve textures; excludes borrowed MRT/Hi-Z/OIT/source HDR' }
  }

  _releaseTarget() {
    const target = this.target
    if (!target) return
    if (target.resolve && !target.resolve.shaderProgram.isDestroyed()) target.resolve.shaderProgram.destroy()
    if (target.stateOptions) this.C.RenderState.removeFromCache(target.stateOptions)
    for (const key of ['deltaFramebuffer', 'outputFramebuffer', 'delta', 'output']) if (target[key] && !target[key].isDestroyed()) target[key].destroy()
    this.target = undefined
  }

  _release() {
    this.enabled = false
    this.outputFrame = undefined
    if (this.detach) this.detach()
    this.detach = undefined
    this._releaseTarget()
    for (const record of this.programs.values()) if (!record.program.isDestroyed()) record.program.destroy()
    for (const record of this.states.values()) this.C.RenderState.removeFromCache(record.options)
    this.programs.clear(); this.states.clear()
    this.materials = this.levels = this.inputColor = undefined
    if (this.reflectionUniforms) this.reflectionUniforms.destroy()
    if (this.cameraUniforms) this.cameraUniforms.release()
    this.reflectionUniforms = this.cameraUniforms = undefined
  }

  isDestroyed() { return this.destroyed }
  destroy() { if (!this.destroyed) { this._release(); this.destroyed = true } }
}
