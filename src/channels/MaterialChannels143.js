import MaterialTarget143, { materialTargetSupport } from './MaterialTarget143.js'
import { materialSources } from './materialShader143.js'
import DepthPyramid143 from './DepthPyramid143.js'

class TransparencyScopeError extends Error {}

function requireAvailableDepth(program) {
  const sourceText = [...program.vertexShaderSource.sources, ...program.fragmentShaderSource.sources].join('\n')
  if (/\b(czm_globeDepthTexture|czm_globeDepthTextureDimensions|depthTexture)\b/.test(sourceText)) throw new TransparencyScopeError('Shader depends on native depth not yet produced')
}

// Unknown opaque surfaces must overwrite far material values, not merely depth.
// Keep their original discard and gl_FragDepth logic, but mark all material data invalid.
export function invalidMaterialSources(C, program, reflection = false, opaqueColor = false, albedo = false, nativeDepthAvailable = false) {
  reflection = reflection || opaqueColor
  if(!nativeDepthAvailable)requireAvailableDepth(program)
  const fs = program.fragmentShaderSource.clone()
  if (fs.sources.some(source => /layout\s*\(\s*location\s*=\s*[1-9]/.test(source))) {
    throw new Error('Unsupported opaque MRT shader')
  }
  fs.defines.push('CESIUM_REDIRECTED_COLOR_OUTPUT')
  fs.sources = fs.sources.map(source => C.ShaderSource.replaceMain(source, 'campus_invalid_main'))
  fs.sources.push(`
layout(location = 1) out vec4 campus_materialEmissiveFlags;
layout(location = 2) out float campus_materialDepth;
layout(location = 3) out float campus_transparentCoverage;
${reflection ? 'layout(location = 4) out vec4 campus_reflectionSpecularOutput;\nlayout(location = 5) out vec4 campus_reflectionResponse;' : ''}
${opaqueColor ? 'layout(location = 6) out vec4 campus_opaqueColor;' : ''}
${albedo ? `layout(location = ${4 + (reflection ? 2 : 0) + (opaqueColor ? 1 : 0)}) out vec4 campus_albedoOcclusion;` : ''}
void main() {
  campus_invalid_main();
  out_FragColor = vec4(0.0);
  campus_materialEmissiveFlags = vec4(0.0);
  campus_materialDepth = -1.0;
  campus_transparentCoverage = 0.0;
  ${reflection ? 'campus_reflectionSpecularOutput = vec4(0.0);\n  campus_reflectionResponse = vec4(0.0);' : ''}
  ${opaqueColor ? 'campus_opaqueColor = vec4(0.0);' : ''}
  ${albedo ? 'campus_albedoOcclusion = vec4(0.0);' : ''}
}`)
  return { vertexShaderSource: program.vertexShaderSource, fragmentShaderSource: fs }
}

// Binary conservative coverage: preserve fragment discard and depth, but neither
// blend into color nor write depth. Even zero-alpha fragments may over-mask safely.
export function transparencySources(C, program, nativeDepthAvailable = false) {
  if(!nativeDepthAvailable)requireAvailableDepth(program)
  const fs = program.fragmentShaderSource.clone()
  if (fs.sources.some(source => /layout\s*\(\s*location\s*=\s*[1-9]/.test(source))) throw new TransparencyScopeError('Unsupported transparent MRT shader')
  fs.defines.push('CESIUM_REDIRECTED_COLOR_OUTPUT')
  fs.sources = fs.sources.map(source => C.ShaderSource.replaceMain(source, 'campus_transparency_main'))
  fs.sources.push(`void main() { campus_transparency_main(); out_FragColor = vec4(1.0); }`)
  return { vertexShaderSource: program.vertexShaderSource, fragmentShaderSource: fs }
}

// The scene has already selected and binned commands before COMPUTE execution.
export function replayMaterialFrusta(C, scene, target, draw) {
  const context = scene.context, uniforms = context.uniformState, camera = scene.camera
  const viewport = C.BoundingRectangle.clone(uniforms.viewport), previousPass = uniforms.pass
  const frustum = camera.frustum.clone()
  const bins = scene._view.frustumCommandsList
  const environment = scene._environmentState || {}
  const perform = (bin, pass, transparent = false) => {
    uniforms.updatePass(pass)
    for (let i = 0; i < (bin.indices[pass] || 0); i++) draw(bin.commands[pass][i], transparent)
  }
  try {
    uniforms.updateCamera(camera)
    uniforms.viewport = target.passState.viewport
    target.clearAll.execute(context, target.passState)
    for (let index = bins.length - 1; index >= 0; index--) {
      const bin = bins[index]
      frustum.near = index ? bin.near * scene.opaqueFrustumNearOffset : bin.near
      frustum.far = bin.far
      uniforms.updateFrustum(frustum)
      target.clearDepth.execute(context, target.passState)
      perform(bin, C.Pass.GLOBE)
      if (environment.clearGlobeDepth) {
        target.clearDepth.execute(context, target.passState)
        if (environment.useDepthPlane && scene._depthPlane && scene._depthPlane._command) draw(scene._depthPlane._command)
      }
      perform(bin, C.Pass.CESIUM_3D_TILE)
      perform(bin, C.Pass.OPAQUE)
      // Native translucent rendering restores the true near plane while retaining
      // opaque depth; using the opaque offset can incorrectly reject coverage.
      frustum.near = bin.near
      uniforms.updateFrustum(frustum)
      perform(bin, C.Pass.TRANSLUCENT, true)
    }
  } finally {
    uniforms.updateCamera(camera)
    uniforms.updateFrustum(camera.frustum)
    uniforms.updatePass(previousPass)
    uniforms.viewport = viewport
  }
}

export default class MaterialChannels143 {
  constructor(C, scene) {
    if (!/^1\.143(?:\.0)?$/.test(C.VERSION)) throw new Error('MaterialChannels143 requires Cesium 1.143')
    this.C = C
    this.scene = scene
    this.support = materialTargetSupport(scene.context)
    this.enabled = false
    this.destroyed = false
    this.failed = false
    this.error = null
    this.reason = 'Disabled'
    this.outputFrame = undefined
    this.programs = new Map()
    this.states = new Map()
    this.stats = { frames: 0, draws: 0, invalidators: 0, transparentDraws: 0, frustumCount: 0 }
    this.depthPyramidEnabled = false
    this.reflectionRequested = false
    this.reflectionEnabled = false
    this.reflectionSupport = materialTargetSupport(scene.context, true)
    this.reflectionError = null
    this.opaqueColorRequested = false
    this.opaqueColorEnabled = false
    this.opaqueColorSupport = materialTargetSupport(scene.context, true, true)
    this.opaqueColorError = null
    this.albedoRequested = false
    this.albedoEnabled = false
    this.albedoSupport = materialTargetSupport(scene.context, false, false, true)
    this.albedoError = null
  }

  _sceneDestroyed() { return !!(this.scene.isDestroyed && this.scene.isDestroyed()) }

  _scopeReason() {
    const C = this.C, scene = this.scene
    if (this.destroyed || this._sceneDestroyed()) return 'Destroyed'
    if (!this.support.supported) return this.support.reason
    if (scene.context._gl.isContextLost()) return 'Context lost'
    if (!this.enabled) return this.failed ? 'Material pass failed; disable before retrying' : 'Disabled'
    if (scene.mode !== C.SceneMode.SCENE3D) return 'Requires 3D scene'
    if (!(scene.camera.frustum instanceof C.PerspectiveFrustum) && !(scene.camera.frustum instanceof C.PerspectiveOffCenterFrustum)) return 'Requires perspective camera'
    const passes = scene.frameState.passes
    if (!passes.render || passes.pick || passes.depth) return 'Requires color render frame'
    if (scene._globeTranslucencyState && scene._globeTranslucencyState.translucent) return 'Translucent globe not supported'
    if (scene._environmentState && scene._environmentState.useWebVR) return 'WebVR material replay not supported'
    if (scene._environmentState && scene._environmentState.useInvertClassification) return 'Invert classification not supported'
    return null
  }

  setEnabled(value) {
    if (this.destroyed || this._sceneDestroyed()) return
    if (!value) {
      this._release()
      this.failed = false
      this.reason = 'Disabled'
    } else if (!this.enabled && !this.failed && this.support.supported) {
      this.error = null
      this.enabled = true
      this.reason = 'Not rendered'
      this.proxy = { update: state => this._update(state), isDestroyed: () => this.destroyed, destroy() {} }
      this.scene.primitives.add(this.proxy)
      this.removePreUpdate = this.scene.preUpdate.addEventListener(() => {
        if (this.enabled) this.scene.primitives.raiseToTop(this.proxy)
      })
    }
    this.scene.requestRender()
  }

  _update(frameState) {
    this.outputFrame = undefined
    if (this.depthPyramid) this.depthPyramid.invalidate()
    if (!this.enabled || !frameState.passes.render) return
    frameState.commandList.push({ pass: this.C.Pass.COMPUTE, execute: () => this._render() })
  }

  _draw(original, transparent = false) {
    const C = this.C, scene = this.scene
    if (scene.debugCommandFilter && !scene.debugCommandFilter(original)) return
    let command = original
    if (scene.frameState.useLogDepth && command.derivedCommands && command.derivedCommands.logDepth) command = command.derivedCommands.logDepth.command
    if (scene.highDynamicRange && command.derivedCommands && command.derivedCommands.hdr) command = command.derivedCommands.hdr.command
    if (!command.shaderProgram) throw new Error('Unsupported opaque command without shader')
    const map = command.uniformMap || {}
    if ((map.u_isEdgePass && map.u_isEdgePass()) || (map.model_silhouettePass && map.model_silhouettePass())) {
      if (transparent) throw new TransparencyScopeError('Transparent silhouette/edge coverage not supported')
      return
    }
    const source = command.shaderProgram, frame = scene.frameState.frameNumber
    const layout = `${this.reflectionEnabled ? 'r' : '-'}${this.opaqueColorEnabled ? 'o' : '-'}${this.albedoEnabled ? 'a' : '-'}`
    const programKey = transparent ? `transparent:${source.id}` : layout === '---' ? source.id : `material:${layout}:${source.id}`
    let record = this.programs.get(programKey)
    if (!record) {
      requireAvailableDepth(source)
      const material = !transparent && materialSources(C, source, this.reflectionEnabled, this.opaqueColorEnabled, this.albedoEnabled)
      const sources = transparent ? transparencySources(C, source) : material || invalidMaterialSources(C, source, this.reflectionEnabled, this.opaqueColorEnabled, this.albedoEnabled)
      record = { program: C.ShaderProgram.fromCache({ context: scene.context, ...sources,
        attributeLocations: source._attributeLocations }), material: !!material }
      this.programs.set(programKey, record)
    }
    record.frame = frame
    if (record.material && Object.values(command.renderState.colorMask).every(value => value === false)) throw new Error('Depth-only model replay not supported')
    const stateKey = transparent ? `transparent:${command.renderState.id}` : command.renderState.id
    let state = this.states.get(stateKey)
    if (!state) {
      const options = C.RenderState.getState(command.renderState)
      const stencil = options.stencilTest
      if (stencil.enabled && (stencil.frontFunction !== C.StencilFunction.ALWAYS || stencil.backFunction !== C.StencilFunction.ALWAYS)) {
        throw new Error('Complex stencil/skip-LOD material replay not supported')
      }
      options.blending = { enabled: false }
      if (transparent) {
        options.depthMask = false
        options.stencilMask = 0
      }
      options.colorMask = { red: true, green: true, blue: true, alpha: true }
      state = { value: C.RenderState.fromCache(options), options, frame }
      this.states.set(stateKey, state)
    }
    state.frame = frame
    const derived = C.DrawCommand.shallowClone(command)
    derived.shaderProgram = record.program
    derived.renderState = state.value
    derived.framebuffer = transparent ? this.target.transparencyFramebuffer : this.target.framebuffer
    derived.castShadows = false
    derived.receiveShadows = false
    scene.context.uniformState.updatePass(command.pass)
    derived.execute(scene.context, transparent ? this.target.transparencyPassState : this.target.passState)
    this.stats.draws++
    if (transparent) this.stats.transparentDraws++
    else if (!record.material) this.stats.invalidators++
  }

  _render() {
    this.outputFrame = undefined
    if (this.depthPyramid) this.depthPyramid.invalidate()
    const reason = this._scopeReason()
    if (reason) { this.reason = reason; return }
    const C = this.C, scene = this.scene
    const bins = scene._view && scene._view.frustumCommandsList
    if (!bins || !bins.length) { this.reason = 'No current frusta'; return }
    for (const bin of bins) {
      if ([C.Pass.TERRAIN_CLASSIFICATION, C.Pass.CESIUM_3D_TILE_CLASSIFICATION, C.Pass.CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW,
        C.Pass.VOXELS, C.Pass.GAUSSIAN_SPLATS, C.Pass.CESIUM_3D_TILE_EDGES, C.Pass.CESIUM_3D_TILE_EDGES_DIRECT]
        .some(pass => bin.indices[pass] > 0)) { this.reason = 'Classification/edge/voxel replay not supported'; return }
    }
    try {
      const width = scene.drawingBufferWidth, height = scene.drawingBufferHeight
      if (!width || !height) { this.reason = 'Empty drawing buffer'; return }
      if (!this.target || this.target.width !== width || this.target.height !== height) {
        if (this.target) this.target.destroy()
        this.target = undefined
        while (!this.target) {
          try {
            this.target = new MaterialTarget143(C, scene.context, width, height, this.reflectionEnabled, this.opaqueColorEnabled, this.albedoEnabled)
          } catch (error) {
            // Drop optional attachments independently: albedo first, then 7 -> 6
            // -> 4, preserving existing consumers wherever possible.
            if (this.albedoEnabled) {
              this.albedoError = error.message
              this.albedoEnabled = false
            } else if (this.opaqueColorEnabled) {
              this.opaqueColorError = error.message
              this.opaqueColorEnabled = false
            } else if (this.reflectionEnabled) {
              this.reflectionError = error.message
              this.reflectionEnabled = false
            } else throw error
            this._invalidateLayout()
          }
        }
      }
      Object.assign(this.stats, { draws: 0, invalidators: 0, transparentDraws: 0, frustumCount: bins.length })
      replayMaterialFrusta(C, scene, this.target, (command, transparent) => this._draw(command, transparent))
      this.outputFrame = scene.frameState.frameNumber
      this.reason = null
      this.stats.frames++
      if (this.depthPyramidEnabled) {
        if (!this.depthPyramid) this.depthPyramid = new DepthPyramid143(C, scene)
        this.depthPyramid.update(this.target.eyeDepth, this.outputFrame, this.reflectionEnabled ? this.target.transparency : null)
      }
      this._prune()
    } catch (error) {
      if (error instanceof TransparencyScopeError) {
        this.reason = error.message
        this._prune()
        return
      }
      this.error = error.message
      this.failed = true
      this._release()
      this.reason = 'Material pass failed; disable before retrying'
    }
  }

  _prune() {
    const cutoff = this.scene.frameState.frameNumber - 120
    for (const [id, record] of this.programs) if (record.frame < cutoff) {
      if (!record.program.isDestroyed()) record.program.destroy()
      this.programs.delete(id)
    }
    for (const [id, record] of this.states) if (record.frame < cutoff) {
      this.C.RenderState.removeFromCache(record.options)
      this.states.delete(id)
    }
  }

  getTextures() {
    if (this._scopeReason() || !this.target || this.outputFrame !== this.scene.frameState.frameNumber ||
      this.target.width !== this.scene.drawingBufferWidth || this.target.height !== this.scene.drawingBufferHeight) return null
    return { normalRoughMetal: this.target.normalRoughMetal, emissiveFlags: this.target.emissiveFlags, eyeDepth: this.target.eyeDepth,
      transparency: this.target.transparency, ...(this.target.reflectionSpecular ? {
        reflectionSpecular: this.target.reflectionSpecular, reflectionResponse: this.target.reflectionResponse
      } : {}), ...(this.target.opaqueColor ? { opaqueColor: this.target.opaqueColor } : {}),
      ...(this.target.albedoOcclusion ? { albedoOcclusion: this.target.albedoOcclusion } : {}) }
  }

  getDiagnostics() {
    return { enabled: this.enabled, supported: this.support.supported, valid: !!this.getTextures(),
      reason: this._scopeReason() || this.reason, error: this.error, stats: { ...this.stats },
      bytes: this.target ? this.target.bytes : 0, allocationScope: 'owned MRT textures including depth-stencil; excludes driver overhead',
      format: 'RGBA8 normal/roughness/metallic + RGBA16F emissive/flags + R32F eye-depth + R8 transparency',
      opaqueOnly: true, unsupportedSurfacesHaveInvalidDepth: true,
      materialLayoutVersion: 2,
      albedoContractVersion: 1,
      reflectionContractVersion: 1,
      opaqueColorContractVersion: 1,
      depthContractVersion: 2,
      transparencyContract: 'R8 binary conservative visible forward-fragment coverage; main transparency/OIT unchanged',
      depthContract: 'positive=known eye metres; zero=background; negative=unknown opaque occluder' }
  }

  setDepthPyramidEnabled(value) {
    if (this.destroyed) return
    this.depthPyramidEnabled = value === true
    if (!this.depthPyramidEnabled && this.depthPyramid) this.depthPyramid.release()
    if (!this._sceneDestroyed()) this.scene.requestRender()
  }

  _invalidateLayout() {
    this.outputFrame = undefined
    if (this.depthPyramid) this.depthPyramid.invalidate()
    if (this.target) this.target.destroy()
    this.target = undefined
    for (const record of this.programs.values()) if (!record.program.isDestroyed()) record.program.destroy()
    this.programs.clear()
  }

  setReflectionEnabled(value) {
    if (this.destroyed || this._sceneDestroyed()) return
    this.reflectionRequested = value === true
    if (!this.reflectionRequested) this.reflectionError = null
    this.reflectionSupport = materialTargetSupport(this.scene.context, true)
    const enabled = this.reflectionRequested && this.reflectionSupport.supported && !this.reflectionError
    if (enabled !== this.reflectionEnabled) {
      this.reflectionEnabled = enabled
      this._invalidateLayout()
    }
    this._syncOpaqueColor()
    this._syncAlbedo()
    this.scene.requestRender()
  }

  _syncOpaqueColor() {
    this.opaqueColorSupport = materialTargetSupport(this.scene.context, true, true)
    const enabled = !!(this.opaqueColorRequested && this.reflectionEnabled && this.opaqueColorSupport.supported && !this.opaqueColorError)
    if (enabled !== this.opaqueColorEnabled) {
      this.opaqueColorEnabled = enabled
      this._invalidateLayout()
    }
  }

  setOpaqueColorEnabled(value) {
    if (this.destroyed || this._sceneDestroyed()) return
    this.opaqueColorRequested = value === true
    if (!this.opaqueColorRequested) this.opaqueColorError = null
    this._syncOpaqueColor()
    this._syncAlbedo()
    this.scene.requestRender()
  }

  _syncAlbedo() {
    this.albedoSupport = materialTargetSupport(this.scene.context, this.reflectionEnabled, this.opaqueColorEnabled, true)
    const enabled = !!(this.albedoRequested && this.albedoSupport.supported && !this.albedoError)
    if (enabled !== this.albedoEnabled) {
      this.albedoEnabled = enabled
      this._invalidateLayout()
    }
  }

  setAlbedoEnabled(value) {
    if (this.destroyed || this._sceneDestroyed()) return
    this.albedoRequested = value === true
    if (!this.albedoRequested) this.albedoError = null
    this._syncAlbedo()
    this.scene.requestRender()
  }

  getAlbedoDiagnostics() {
    const support = this.albedoSupport || { supported: false, reason: 'Not requested' }
    const textures = this.albedoEnabled && this.getTextures()
    const reason = !this.albedoRequested ? 'Disabled' : this.albedoError
      ? 'Albedo target failed; disable before retrying' : !support.supported ? support.reason : this._scopeReason() || this.reason
    return { requested: !!this.albedoRequested, enabled: this.enabled && !!this.albedoEnabled,
      supported: support.supported, valid: !!(textures && textures.albedoOcclusion), reason,
      error: this.albedoError || null, albedoContractVersion: 1,
      bytes: this.target && this.albedoEnabled ? 8 * this.target.width * this.target.height : 0 }
  }

  getOpaqueColorDiagnostics() {
    const support = this.opaqueColorSupport || { supported: false, reason: 'Not requested' }
    const textures = this.opaqueColorEnabled && this.getTextures()
    const reason = !this.opaqueColorRequested ? 'Disabled' : this.opaqueColorError
      ? 'Opaque color target failed; disable before retrying' : !support.supported ? support.reason
        : !this.reflectionEnabled ? 'Requires enabled reflection channels' : this._scopeReason() || this.reason
    return { requested: !!this.opaqueColorRequested, enabled: this.enabled && !!this.opaqueColorEnabled,
      supported: support.supported, valid: !!(textures && textures.opaqueColor), reason,
      error: this.opaqueColorError || null, opaqueColorContractVersion: 1,
      bytes: this.target && this.opaqueColorEnabled ? 8 * this.target.width * this.target.height : 0 }
  }

  getReflectionDiagnostics() {
    const support = this.reflectionSupport || { supported: false, reason: 'Not requested' }
    const textures = this.reflectionEnabled && this.getTextures()
    const reason = !this.reflectionRequested ? 'Disabled' : this.reflectionError
      ? 'Reflection target failed; disable before retrying' : !support.supported ? support.reason : this._scopeReason() || this.reason
    return { requested: !!this.reflectionRequested, enabled: this.enabled && !!this.reflectionEnabled,
      supported: support.supported, valid: !!(textures && textures.reflectionSpecular && textures.reflectionResponse),
      reason, error: this.reflectionError || null, reflectionContractVersion: 1,
      bytes: this.target && this.reflectionEnabled ? 16 * this.target.width * this.target.height : 0 }
  }

  getDepthPyramidDiagnostics() {
    const actual = this.depthPyramid ? this.depthPyramid.getDiagnostics() : { valid: false, bytes: 0, reason: 'Not rendered' }
    const reason = !this.depthPyramidEnabled ? 'Disabled' : this._scopeReason()
    return { ...actual, enabled: this.enabled && this.depthPyramidEnabled,
      ...(reason ? { valid: false, reason } : {}) }
  }

  getDepthPyramidLevels() {
    return this.depthPyramidEnabled && this.getTextures() && this.depthPyramid ? this.depthPyramid.getLevels() : null
  }

  _release() {
    this.outputFrame = undefined
    if (this.depthPyramid) this.depthPyramid.release()
    this.enabled = false
    if (this.removePreUpdate) this.removePreUpdate()
    this.removePreUpdate = undefined
    if (this.proxy && !this._sceneDestroyed()) this.scene.primitives.remove(this.proxy)
    this.proxy = undefined
    for (const record of this.programs.values()) if (!record.program.isDestroyed()) record.program.destroy()
    this.programs.clear()
    for (const record of this.states.values()) this.C.RenderState.removeFromCache(record.options)
    this.states.clear()
    if (this.target) this.target.destroy()
    this.target = undefined
  }

  isDestroyed() { return this.destroyed }
  destroy() {
    if (this.destroyed) return
    this._release()
    if (this.depthPyramid) this.depthPyramid.destroy()
    this.destroyed = true
    if (!this._sceneDestroyed()) this.scene.requestRender()
  }
}
