import { normalizeOptions, normalizeColorGrading, defaultFilters } from './presets.js'
import createColorGrading from './stages/colorGrading.js'
import configureShadowBias from './shadowBias143.js'
import createCampusShadowMap from './shadowMap143.js'
import DirectionalShadowPass from './shadows/DirectionalShadowPass.js'
import EnvironmentRenderer from './environment/EnvironmentRenderer.js'
import SmaaPass143 from './antialiasing/SmaaPass143.js'
import FxaaPass143 from './antialiasing/FxaaPass143.js'
import TaaPass143 from './antialiasing/TaaPass143.js'
import ScreenSpaceGeometry143 from './channels/ScreenSpaceGeometry143.js'
import MaterialChannels143 from './channels/MaterialChannels143.js'
import ScreenSpaceAo143 from './ao/ScreenSpaceAo143.js'
import HdrBloom143 from './bloom/HdrBloom143.js'
import DeferredLighting143 from './lighting/DeferredLighting143.js'
import TransparentForward143 from './pipeline/TransparentForward143.js'
import ScreenSpaceReflection143 from './reflections/ScreenSpaceReflection143.js'
import TransparentReflection143 from './reflections/TransparentReflection143.js'
import { installOitCompatibility143 } from './reflections/OitCompatibility143.js'
import PerformanceGovernor143 from './performance/PerformanceGovernor143.js'
import { selectMsaaSamples, renderResolution, readMsaaAttachments, resolveMsaaPolicy } from './antialiasing/settings143.js'

// Registry supports business tools without placing renderer objects in Vue data.
const pipelines = new WeakMap()
export const getVisualPipeline = viewer => pipelines.get(viewer)

export default class VisualPipeline {
  constructor({ Cesium, viewer, options = {} }) {
    if (!/^1\.143(?:\.0)?$/.test(Cesium.VERSION)) {
      throw new Error(`VisualPipeline requires static Cesium 1.143; found ${Cesium.VERSION}`)
    }
    if (pipelines.has(viewer)) throw new Error('Viewer already has a VisualPipeline')
    this.Cesium = Cesium
    this.viewer = viewer
    this.options = normalizeOptions(options)
    this.enabled = false
    this.destroyed = false
    this.suspensions = new Set()
    this.changes = []
    this.color = createColorGrading(Cesium, () => this.options, () => this.enabled && !this.suspensions.size)
    const stages = viewer.scene.postProcessStages
    this.color.enabled = false
    stages.add(this.color)
    pipelines.set(viewer, this)
    try {
      this.releaseOitCompatibility = installOitCompatibility143(Cesium, viewer.scene)
      this.setEnabled(true)
    } catch (error) {
      this.destroy()
      throw error
    }
  }

  // Restore only values still owned by this module; never remove foreign stages.
  write(object, key, value) {
    let entry = this.changes.find(item => item.object === object && item.key === key)
    if (!entry) {
      entry = { object, key, before: object[key] }
      this.changes.push(entry)
    }
    object[key] = value
    entry.applied = object[key]
  }

  restore() {
    if (this.transparentForward) this.transparentForward.setEnabled(false)
    if (this.deferredLighting) this.deferredLighting.setEnabled(false)
    if (this.fxaa) this.fxaa.setEnabled(false)
    if (this.hdrBloom) this.hdrBloom.setEnabled(false)
    if (this.transparentReflections) this.transparentReflections.setEnabled(false)
    if (this.screenSpaceReflections) this.screenSpaceReflections.setEnabled(false)
    if (this.screenSpaceAO) this.screenSpaceAO.setEnabled(false)
    if (this.materialChannels) this.materialChannels.setEnabled(false)
    if (this.geometry) this.geometry.setEnabled(false)
    if (this.environmentRenderer) this.environmentRenderer.setEnabled(false)
    if (this.taa) this.taa.setEnabled(false)
    if (this.smaa) this.smaa.setEnabled(false)
    if (this.customShadow) this.customShadow.setEnabled(false)
    this.changes.slice().reverse().forEach(({ object, key, before, applied }) => {
      if (object[key] === applied) {
        object[key] = before
        if (object === this.viewer.scene && key === 'shadowMap') before.dirty = true
      }
    })
    this.changes = []
    if (this.shadowMap) this.shadowMap.dirty = true
    // Cesium 1.143 runs post-processing when the collection contains any stage,
    // even if all are disabled. Keep an identity copy while suspended/disabled
    // so a bare Viewer still has an output texture when native HDR is restored off.
    this.color.enabled = true
  }

  apply() {
    if (this.destroyed || !this.enabled || this.suspensions.size) return
    const C = this.Cesium
    const v = this.viewer
    const s = v.scene
    const p = s.postProcessStages
    const o = this.options
    if (!this.environmentRenderer || !this.environmentRenderer.enabled) {
      this.write(s, 'light', this.light || (this.light = new C.SunLight({ intensity: 1.5 })))
    }
    this.write(s.globe, 'enableLighting', true)
    if (o.shadowMode === 'custom') {
      this.write(v.shadowMap, 'enabled', false)
      if (!this.customShadow) this.customShadow = new DirectionalShadowPass(C, v, () => this.options)
      this.customShadow.setEnabled(o.shadows)
    } else {
      if (!this.shadowMap) this.shadowMap = createCampusShadowMap(C, v, o)
      this.write(s, 'shadowMap', this.shadowMap)
      this.write(this.shadowMap, 'enabled', o.shadows)
      this.write(v.shadowMap, 'size', o.shadowSize)
      this.write(v.shadowMap, 'maximumDistance', o.shadowDistance)
      this.write(v.shadowMap, 'softShadows', true)
      configureShadowBias(this)
    }
    this.write(s, 'highDynamicRange', true)
    this.write(p, 'tonemapper', C.Tonemapper.ACES)
    this.write(p, 'exposure', o.exposure)
    this.write(p.ambientOcclusion, 'enabled', o.ambientOcclusion && !o.screenSpaceAoEnabled && C.PostProcessStageLibrary.isAmbientOcclusionSupported(s))
    // Optional AO is unfiltered in this Cesium release; keep it off by default.
    // Avoid the previous oversized radius and undersampling if explicitly enabled.
    this.write(p.ambientOcclusion.uniforms, 'intensity', 0.7)
    this.write(p.ambientOcclusion.uniforms, 'directionCount', 8)
    this.write(p.ambientOcclusion.uniforms, 'stepCount', 16)
    this.write(p.ambientOcclusion.uniforms, 'lengthCap', 0.15)
    this.write(p.ambientOcclusion.uniforms, 'bias', 0.2)
    this.write(p.bloom, 'enabled', o.bloom && !o.hdrBloomEnabled)
    // Post-process AA owns coverage, so a redundant multisample request is reduced
    // to a single sample unless the caller opted into the combination explicitly.
    const msaaPolicy = resolveMsaaPolicy(o)
    this.msaa = { ...selectMsaaSamples(s, msaaPolicy.effective), requested: msaaPolicy.requested,
      combined: msaaPolicy.combined, policy: msaaPolicy.reason }
    this.write(s, 'msaaSamples', this.msaa.selected)
    if (o.antialiasing !== 'fxaa' && this.fxaa) this.fxaa.setEnabled(false)
    if (o.antialiasing === 'smaa' && s.context && s.context.webgl2) {
      if (!this.smaa) this.smaa = new SmaaPass143(C, s)
      this.smaa.setQuality(o.spatialAaQuality)
      this.smaa.setEnabled(true)
    } else {
      if (this.smaa) this.smaa.setEnabled(false)
      if (o.antialiasing === 'fxaa' && s.context && s.context.webgl2) {
        if (!this.fxaa) this.fxaa = new FxaaPass143(C, s)
        this.fxaa.setQuality(o.spatialAaQuality)
        this.fxaa.setEnabled(true)
      } else if (o.antialiasing !== 'taa' || !this.taa || !this.taa.enabled) {
        this.write(p.fxaa, 'enabled', o.antialiasing === 'fxaa' || o.antialiasing === 'smaa')
      }
    }
    // Temporal AA resolves the HDR chain itself, so it is mutually exclusive with both
    // multisampling and the spatial post-process stage above.
    if (o.antialiasing === 'taa' && s.context && s.context.webgl2) {
      if (!this.taa) this.taa = new TaaPass143(C, s, () => this.options)
      this.taa.setEnabled(true)
    } else if (this.taa) this.taa.setEnabled(false)
    this.write(v, 'resolutionScale', o.resolutionScale)
    this.write(v, 'useBrowserRecommendedResolution', o.resolutionMode === 'css')
    if (v.canvas && v.canvas.style) this.write(v.canvas.style, 'imageRendering', 'auto')
    if (v.resize) v.resize()
    this.color.enabled = true
    if (o.environment) {
      if (!this.environmentRenderer) this.environmentRenderer = new EnvironmentRenderer(C, v, () => this.options, () => this.customShadow)
      if (this.campusOrigin && !this.environmentRenderer.origin) this.environmentRenderer.setOrigin(this.campusOrigin)
      this.environmentRenderer.setEnabled(true)
    } else if (this.environmentRenderer) this.environmentRenderer.setEnabled(false)
    this.applyGeometry()
    this.applyLighting()
    this.applyMaterialChannels()
    this.applyScreenSpaceReflections()
    this.applyTransparentReflections()
    this.applyScreenSpaceAO()
    this.applyHdrBloom()
    s.requestRender()
  }

  /**
   * B02: deferred lighting. Deliberately experimental and off by default -- the plan only allows it
   * to become a candidate default after B03 closes the opaque/transparent loop, and MSAA coverage is
   * not taken over. It owns its compact material producer without changing explicit channel options.
   */
  applyLighting() {
    if (this.destroyed || !this.enabled || this.suspensions.size) {
      if (this.deferredLighting) this.deferredLighting.setEnabled(false)
      return
    }
    const o = this.options
    const requested = o.lightingMode === 'deferred'
    if (requested && !this.deferredLighting) {
      this.deferredLighting = new DeferredLighting143({
        Cesium: this.Cesium,
        scene: this.viewer.scene,
        getOptions: () => this.options,
        prepareAo: color => {
          if (!this.screenSpaceAO?.enabled) return null
          this.screenSpaceAO.prepareVisibility(this.viewer.scene.context, color)
          return this.screenSpaceAO.getVisibilityTexture()
        },
        getShadowVisibility: () => this._deferredShadowVisibility(),
        onGeometryAvailability: () => this.applyMaterialChannels(),
        prepareReflections: color => this.screenSpaceReflections?.enabled ? this.screenSpaceReflections.prepareOpaque(this.viewer.scene.context,color) : color,
      })
    }
    if (this.deferredLighting) {
      if (o.lightingDebugMode !== undefined) this.deferredLighting.setDebugMode(o.lightingDebugMode)
      if (o.lightingAoStrength !== undefined) this.deferredLighting.set({ aoStrength: o.lightingAoStrength })
      this.deferredLighting.setTerms({
        direct: o.lightingDirect !== false,
        indirect: o.lightingIndirect !== false,
        emissive: o.lightingEmissive !== false,
        shadow: o.lightingShadow !== false,
        ao: o.lightingAo !== false,
      })
      this.deferredLighting.setEnabled(requested)
    }
    this.applyTransparentForward(requested)
  }

  /**
   * B03: translucent surfaces must use the same CCR lighting terms as the opaque pass.
   *
   * Measured before this existed: with every CCR term disabled the opaque backdrop went to [0,0,0]
   * while the glass layer's contribution stayed bit-identical, i.e. glass was lit by native Cesium and
   * ignored CCR completely. This shares the opaque pass's shadow input so the two agree, and stays
   * off whenever deferred opaque lighting is not itself active -- a second, independent lighting model
   * for translucency is exactly what the plan forbids.
   */
  applyTransparentForward(deferredRequested) {
    if (this.destroyed || !this.enabled || this.suspensions.size) {
      if (this.transparentForward) this.transparentForward.setEnabled(false)
      return
    }
    const requested = deferredRequested !== false && this.options.lightingMode === 'deferred'
    if (requested && !this.transparentForward) {
      this.transparentForward = new TransparentForward143({
        Cesium: this.Cesium,
        scene: this.viewer.scene,
        getShadowVisibility: () => this._deferredShadowVisibility(),
        getOptions: () => this.options,
        // Must NOT be getLightingDiagnostics(): that getter itself reports the transparent-forward
        // diagnostics, so passing it here creates a cycle
        // (diagnostics -> scopeReason -> diagnostics -> ...) that throws inside the frame bridge and
        // silently disables the per-command callback.
        //
        // Also deliberately not `activeMode === 'deferred'`: that requires the deferred pass to have
        // already rendered *this* frame, but translucent commands are derived before the opaque pass
        // runs, so it would reject every real per-command call. "Live, attached and not failed" is the
        // correct ordering-safe predicate.
        isDeferredActive: () => {
          const live = this.deferredLighting
          if (!live) return false
          const diagnostics = live.getDiagnostics()
          return diagnostics.enabled === true && diagnostics.failed !== true && diagnostics.attached === true &&
            this.viewer.scene.msaaSamples <= 1 && this.options.antialiasing !== 'taa' &&
            this.viewer.scene.highDynamicRange && this.viewer.scene.mode === this.Cesium.SceneMode.SCENE3D
        },
      })
    }
    if (this.transparentForward) this.transparentForward.setEnabled(requested)
  }

  /**
   * Shadow inputs for the deferred pass, in the form its shader expects.
   *
   * Returns null when no custom shadow is active; the shader then treats `campus_shadowParams.w < 0.5`
   * as "no shadows this frame" and uses full visibility, rather than sampling an unbound texture.
   */
  _deferredShadowVisibility() {
    const shadow = this.customShadow
    if (!shadow?.enabled || !shadow.ready || !shadow.target) return null
    const C = this.Cesium
    return { texture: shadow.target.depth, matrix: shadow.light.receiverMatrix(this.viewer.camera),
      params: new C.Cartesian4(1 / shadow.target.size, shadow.light.texelWorld, shadow.light.depthSpan, 1) }
  }

  getActiveMaterialChannels() {
    const compact = this.deferredLighting?.materials
    return compact?.getTextures() ? compact : this.materialChannels
  }

  applyGeometry() {
    if (this.destroyed || !this.enabled || this.suspensions.size) return
    const o = this.options
    if (o.geometryEnabled && !this.geometry) this.geometry = new ScreenSpaceGeometry143(this.Cesium, this.viewer.scene)
    if (this.geometry) {
      this.geometry.setDebugMode(o.geometryDebugMode)
      this.geometry.setEnabled(o.geometryEnabled)
    }
  }

  setCampusOrigin(origin) {
    if (this.destroyed || !origin) return
    this.campusOrigin = this.Cesium.Cartesian3.clone(origin)
    if (this.environmentRenderer) this.environmentRenderer.setOrigin(origin)
    this.viewer.scene.requestRender()
  }

  getOptions() { return { ...this.options } }
  getColorGrading() {
    return Object.fromEntries(Object.keys(defaultFilters).map(key => [key, this.options[key]]))
  }

  applyMaterialChannels() {
    if (this.destroyed || !this.enabled || this.suspensions.size) return
    const inline = this.options.lightingMode === 'deferred' && this.viewer.scene.msaaSamples <= 1 &&
      this.viewer.scene.orderIndependentTranslucency && this.options.antialiasing !== 'taa' &&
      !this.deferredLighting?.failed && this.deferredLighting?.geometryAvailable !== false
    const depthPyramidEnabled = this.options.depthPyramidEnabled || ((this.options.screenSpaceAoEnabled || this.options.screenSpaceReflectionEnabled) && !inline)
    const enabled = this.options.materialChannelsEnabled || this.options.albedoEnabled || depthPyramidEnabled
    if (enabled && !this.materialChannels) {
      this.materialChannels = new MaterialChannels143(this.Cesium, this.viewer.scene)
    }
    if (this.materialChannels) {
      if (this.materialChannels.setDepthPyramidEnabled) this.materialChannels.setDepthPyramidEnabled(depthPyramidEnabled)
      if (this.materialChannels.setReflectionEnabled) this.materialChannels.setReflectionEnabled(this.options.screenSpaceReflectionEnabled)
      if (this.materialChannels.setOpaqueColorEnabled) this.materialChannels.setOpaqueColorEnabled(this.options.screenSpaceReflectionEnabled && this.options.screenSpaceReflectionTransparent)
      if (this.materialChannels.setAlbedoEnabled) this.materialChannels.setAlbedoEnabled(this.options.albedoEnabled)
      this.materialChannels.setEnabled(enabled)
    }
  }
  applyHdrBloom(updateNative = false) {
    if (this.destroyed || !this.enabled || this.suspensions.size) return
    const o = this.options, native = this.viewer.scene.postProcessStages.bloom
    if (o.hdrBloomEnabled && !this.hdrBloom) this.hdrBloom = new HdrBloom143(this.Cesium, this.viewer.scene, () => this.options)
    if (this.hdrBloom) this.hdrBloom.setEnabled(o.hdrBloomEnabled)
    if (updateNative) {
      const owned = this.changes.find(change => change.object === native && change.key === 'enabled')
      if (o.hdrBloomEnabled || (owned && native.enabled === owned.applied)) this.write(native, 'enabled', o.bloom && !o.hdrBloomEnabled)
    }
  }
  setHdrBloom(settings = {}) {
    if (!this.destroyed) {
      const input = settings || {}, before = this.options.hdrBloomEnabled
      this.options = normalizeOptions({ hdrBloomEnabled: input.enabled, hdrBloomStrength: input.strength,
        hdrBloomThreshold: input.threshold, hdrBloomKnee: input.knee, hdrBloomLevels: input.levels }, this.options)
      this.applyHdrBloom(before !== this.options.hdrBloomEnabled)
    }
    const o = this.options
    return { enabled: o.hdrBloomEnabled, strength: o.hdrBloomStrength, threshold: o.hdrBloomThreshold, knee: o.hdrBloomKnee, levels: o.hdrBloomLevels }
  }
  getHdrBloomDiagnostics() {
    const o = this.options
    const requested = { enabled: o.hdrBloomEnabled, strength: o.hdrBloomStrength, threshold: o.hdrBloomThreshold, knee: o.hdrBloomKnee, levels: o.hdrBloomLevels }
    const active = !this.destroyed && this.enabled && !this.suspensions.size && requested.enabled
    return { ...(this.hdrBloom ? this.hdrBloom.getDiagnostics() : { enabled: false, valid: false, reason: 'Not requested' }),
      ...(!active ? { enabled: false, valid: false, reason: this.destroyed ? 'Destroyed' : requested.enabled ? 'Pipeline inactive' : 'Not requested' } : {}), requested }
  }
  applyScreenSpaceAO(updateNativeAO = false) {
    if (this.destroyed || !this.enabled || this.suspensions.size) return
    const o = this.options, scene = this.viewer.scene
    if (o.screenSpaceAoEnabled && !this.screenSpaceAO) {
      this.screenSpaceAO = new ScreenSpaceAo143(this.Cesium, scene, () => this.getActiveMaterialChannels(), () => this.options)
    }
    if (this.screenSpaceAO) this.screenSpaceAO.setEnabled(o.screenSpaceAoEnabled)
    if (updateNativeAO) {
      const nativeAO = scene.postProcessStages.ambientOcclusion
      const owned = this.changes.find(change => change.object === nativeAO && change.key === 'enabled')
      if (o.screenSpaceAoEnabled || (owned && owned.applied === false && nativeAO.enabled === owned.applied)) {
        const enabled = o.ambientOcclusion && !o.screenSpaceAoEnabled && this.Cesium.PostProcessStageLibrary.isAmbientOcclusionSupported(scene)
        if (nativeAO.enabled !== enabled) this.write(nativeAO, 'enabled', enabled)
      }
    }
  }
  applyScreenSpaceReflections() {
    if (this.destroyed || !this.enabled || this.suspensions.size) return
    if (this.options.screenSpaceReflectionEnabled && !this.screenSpaceReflections) {
      this.screenSpaceReflections = new ScreenSpaceReflection143(this.Cesium, this.viewer.scene, () => this.getActiveMaterialChannels(), () => this.options)
    }
    if (this.screenSpaceReflections) this.screenSpaceReflections.setEnabled(this.options.screenSpaceReflectionEnabled)
  }
  applyTransparentReflections() {
    if (this.destroyed || !this.enabled || this.suspensions.size) return
    const enabled = this.options.screenSpaceReflectionEnabled && this.options.screenSpaceReflectionTransparent
    if (enabled && !this.transparentReflections) {
      this.transparentReflections = new TransparentReflection143(this.Cesium, this.viewer.scene, () => this.getActiveMaterialChannels(), () => this.options)
    }
    if (this.transparentReflections) this.transparentReflections.setEnabled(enabled)
  }
  setColorGrading(options) {
    this.setOptions(normalizeColorGrading(options, this.getColorGrading()))
    return this.getColorGrading()
  }
  resetColorGrading() { return this.setColorGrading(defaultFilters) }
  getAntiAliasing() {
    const o = this.options
    return { mode: o.antialiasing, msaaSamples: o.msaaSamples, resolutionMode: o.resolutionMode, resolutionScale: o.resolutionScale }
  }
  setAntiAliasing(settings = {}) {
    const input = typeof settings === 'string' ? { mode: settings } : settings || {}
    this.setOptions({ antialiasing: input.mode, msaaSamples: input.msaaSamples, msaaCombine: input.msaaCombine,
      resolutionMode: input.resolutionMode, resolutionScale: input.resolutionScale, spatialAaQuality: input.quality })
    return this.getAntiAliasing()
  }
  // Switching modes recreates the resolve stages, which discards the history, so the
  // tuning keys are read when the pass is created. `taaJitterSamples` is one of them.
  setTaa(settings = {}) {
    if (!this.destroyed) {
      const input = settings || {}
      const antialiasing = input.enabled === true ? 'taa' : input.enabled === false ? 'smaa' : undefined
      this.setOptions({ antialiasing, taaJitterSamples: input.jitterSamples, taaHistoryBlend: input.historyBlend,
        taaMotionBlend: input.motionBlend, taaVelocityThreshold: input.velocityThreshold,
        taaDepthTolerance: input.depthTolerance })
    }
    return this.getTaaDiagnostics()
  }
  resetTaaHistory() {
    if (this.taa && !this.destroyed) this.taa.resetHistory()
    return this.getTaaDiagnostics()
  }
  getTaaDiagnostics() {
    const o = this.options
    const requested = { enabled: o.antialiasing === 'taa', jitterSamples: o.taaJitterSamples,
      historyBlend: o.taaHistoryBlend, motionBlend: o.taaMotionBlend,
      velocityThreshold: o.taaVelocityThreshold, depthTolerance: o.taaDepthTolerance }
    let reason = null
    if (this.destroyed) reason = 'Destroyed'
    else if (!requested.enabled) reason = 'Not requested'
    else if (this.suspensions.size) reason = 'Suspended'
    else if (!this.enabled) reason = 'Pipeline disabled'
    const actual = this.taa ? this.taa.getDiagnostics() : { enabled: false, valid: false }
    return { ...actual, ...(reason ? { enabled: false, valid: false, reason } : {}), requested }
  }
  setGeometry(settings = {}) {
    if (!this.destroyed) {
      const input = settings || {}
      this.options = normalizeOptions({ geometryEnabled: input.enabled, geometryDebugMode: input.debugMode }, this.options)
      this.applyGeometry()
    }
    return { enabled: this.options.geometryEnabled, debugMode: this.options.geometryDebugMode }
  }
  getGeometryDiagnostics() {
    const requested = { enabled: this.options.geometryEnabled, debugMode: this.options.geometryDebugMode }
    let reason = 'Not requested'
    if (requested.enabled && this.suspensions.size) reason = 'Suspended'
    else if (requested.enabled && !this.enabled) reason = 'Pipeline disabled'
    return { ...(this.geometry ? this.geometry.getDiagnostics() : {
      enabled: false, valid: false, reason
    }), requested }
  }
  setMaterialChannels(settings = {}) {
    if (!this.destroyed) {
      const input = settings || {}
      this.options = normalizeOptions({ materialChannelsEnabled: input.enabled }, this.options)
      this.applyMaterialChannels()
    }
    return { enabled: this.options.materialChannelsEnabled }
  }
  getMaterialDiagnostics() {
    const requested = { enabled: this.options.materialChannelsEnabled }
    let reason = null
    if (this.destroyed) reason = 'Destroyed'
    else if (!requested.enabled && !this.options.albedoEnabled && !this.options.depthPyramidEnabled && !this.options.screenSpaceAoEnabled && !this.options.screenSpaceReflectionEnabled) reason = 'Not requested'
    else if (this.suspensions.size) reason = 'Suspended'
    else if (!this.enabled) reason = 'Pipeline disabled'
    const actual = this.materialChannels ? this.materialChannels.getDiagnostics() : { enabled: false, valid: false }
    return { ...actual, ...(reason ? { enabled: false, valid: false, reason } : {}), requested }
  }
  setAlbedo(settings = {}) {
    if (!this.destroyed) {
      const input = settings || {}
      this.options = normalizeOptions({ albedoEnabled: input.enabled }, this.options)
      this.applyMaterialChannels()
    }
    return { enabled: this.options.albedoEnabled }
  }
  getAlbedoDiagnostics() {
    const requested = { enabled: this.options.albedoEnabled }
    let reason = null
    if (this.destroyed) reason = 'Destroyed'
    else if (!requested.enabled) reason = 'Not requested'
    else if (this.suspensions.size) reason = 'Suspended'
    else if (!this.enabled) reason = 'Pipeline disabled'
    const actual = this.materialChannels && this.materialChannels.getAlbedoDiagnostics
      ? this.materialChannels.getAlbedoDiagnostics() : { enabled: false, valid: false }
    return { ...actual, ...(reason ? { enabled: false, valid: false, reason } : {}), requested }
  }
  setDepthPyramid(settings = {}) {
    if (!this.destroyed) {
      const input = settings || {}
      this.options = normalizeOptions({ depthPyramidEnabled: input.enabled }, this.options)
      this.applyMaterialChannels()
    }
    return { enabled: this.options.depthPyramidEnabled }
  }
  getDepthPyramidDiagnostics() {
    const requested = { enabled: this.options.depthPyramidEnabled }
    let reason = null
    if (this.destroyed) reason = 'Destroyed'
    else if (!requested.enabled && !this.options.screenSpaceAoEnabled && !this.options.screenSpaceReflectionEnabled) reason = 'Not requested'
    else if (this.suspensions.size) reason = 'Suspended'
    else if (!this.enabled) reason = 'Pipeline disabled'
    const actual = this.materialChannels && this.materialChannels.getDepthPyramidDiagnostics
      ? this.materialChannels.getDepthPyramidDiagnostics() : { enabled: false, valid: false }
    return { ...actual, ...(reason ? { enabled: false, valid: false, reason } : {}), requested }
  }
  setScreenSpaceAO(settings = {}) {
    if (!this.destroyed) {
      const input = settings || {}
      const wasEnabled = this.options.screenSpaceAoEnabled
      this.options = normalizeOptions({ screenSpaceAoEnabled: input.enabled, screenSpaceAoRadius: input.radius,
        screenSpaceAoStrength: input.strength, screenSpaceAoBias: input.bias, screenSpaceAoAlgorithm: input.algorithm }, this.options)
      const updateNativeAO = wasEnabled !== this.options.screenSpaceAoEnabled
      if (!this.options.screenSpaceAoEnabled) this.applyScreenSpaceAO(updateNativeAO)
      this.applyMaterialChannels()
      if (this.options.screenSpaceAoEnabled) this.applyScreenSpaceAO(updateNativeAO)
    }
    const o = this.options
    return { enabled: o.screenSpaceAoEnabled, radius: o.screenSpaceAoRadius, strength: o.screenSpaceAoStrength, bias: o.screenSpaceAoBias, algorithm: o.screenSpaceAoAlgorithm }
  }
  getScreenSpaceAODiagnostics() {
    const o = this.options
    const requested = { enabled: o.screenSpaceAoEnabled, radius: o.screenSpaceAoRadius, strength: o.screenSpaceAoStrength, bias: o.screenSpaceAoBias, algorithm: o.screenSpaceAoAlgorithm }
    let reason = null
    if (this.destroyed) reason = 'Destroyed'
    else if (!requested.enabled) reason = 'Not requested'
    else if (this.suspensions.size) reason = 'Suspended'
    else if (!this.enabled) reason = 'Pipeline disabled'
    const actual = this.screenSpaceAO ? this.screenSpaceAO.getDiagnostics() : { enabled: false, valid: false }
    return { ...actual, ...(reason ? { enabled: false, valid: false, reason } : {}), requested }
  }
  setScreenSpaceReflections(settings = {}) {
    if (!this.destroyed) {
      const input = settings || {}
      this.options = normalizeOptions({ screenSpaceReflectionEnabled: input.enabled, screenSpaceReflectionDistance: input.distance,
        screenSpaceReflectionThickness: input.thickness, screenSpaceReflectionStrength: input.strength,
        screenSpaceReflectionTransparent: input.transparent }, this.options)
      const transparentEnabled = this.options.screenSpaceReflectionEnabled && this.options.screenSpaceReflectionTransparent
      if (!transparentEnabled) this.applyTransparentReflections()
      if (!this.options.screenSpaceReflectionEnabled) this.applyScreenSpaceReflections()
      this.applyMaterialChannels()
      if (this.options.screenSpaceReflectionEnabled) this.applyScreenSpaceReflections()
      if (transparentEnabled) this.applyTransparentReflections()
    }
    const o = this.options
    return { enabled: o.screenSpaceReflectionEnabled, distance: o.screenSpaceReflectionDistance,
      thickness: o.screenSpaceReflectionThickness, strength: o.screenSpaceReflectionStrength, transparent: o.screenSpaceReflectionTransparent }
  }
  getScreenSpaceReflectionDiagnostics() {
    const o = this.options
    const requested = { enabled: o.screenSpaceReflectionEnabled, distance: o.screenSpaceReflectionDistance,
      thickness: o.screenSpaceReflectionThickness, strength: o.screenSpaceReflectionStrength, transparent: o.screenSpaceReflectionTransparent }
    let reason = null
    if (this.destroyed) reason = 'Destroyed'
    else if (!requested.enabled) reason = 'Not requested'
    else if (this.suspensions.size) reason = 'Suspended'
    else if (!this.enabled) reason = 'Pipeline disabled'
    const actual = this.screenSpaceReflections ? this.screenSpaceReflections.getDiagnostics() : { enabled: false, valid: false }
    return { ...actual, ...(reason ? { enabled: false, valid: false, reason } : {}), requested }
  }
  getRenderDiagnostics() {
    const fxaa = this.viewer.scene.postProcessStages.fxaa.enabled
    return { enabled: this.enabled, suspended: this.suspensions.size > 0, colorGrading: this.getColorGrading(),
      antiAliasing: { ...this.getAntiAliasing(), quality: this.options.spatialAaQuality, msaa: this.msaa, configuredMsaaSamples: this.viewer.scene.msaaSamples,
        allocatedAttachments: readMsaaAttachments(this.viewer.scene),
        postProcess: this.taa && this.taa.enabled && this.taa.getDiagnostics().valid ? { effective: 'taa' }
          : this.smaa && this.smaa.enabled ? this.smaa.getDiagnostics()
          : this.fxaa && this.fxaa.enabled ? this.fxaa.getDiagnostics() : { effective: fxaa ? 'fxaa' : 'off' } },
      resolution: renderResolution(this.viewer), geometry: this.getGeometryDiagnostics(), materials: this.getMaterialDiagnostics(),
      albedo: this.getAlbedoDiagnostics(),
      lighting: this.getLightingDiagnostics(),
      taa: this.getTaaDiagnostics(),
      depthPyramid: this.getDepthPyramidDiagnostics(), screenSpaceAO: this.getScreenSpaceAODiagnostics(), hdrBloom: this.getHdrBloomDiagnostics(),
      screenSpaceReflections: this.getScreenSpaceReflectionDiagnostics(), transparentReflections: this.getTransparentReflectionDiagnostics(),
      performance: this.getPerformanceDiagnostics() }
  }
  getTransparentReflectionDiagnostics() {
    const requested = { enabled: this.options.screenSpaceReflectionTransparent }
    let reason = null
    if (this.destroyed) reason = 'Destroyed'
    else if (!requested.enabled) reason = 'Not requested'
    else if (!this.options.screenSpaceReflectionEnabled) reason = 'Screen-space reflections disabled'
    else if (this.suspensions.size) reason = 'Suspended'
    else if (!this.enabled) reason = 'Pipeline disabled'
    const actual = this.transparentReflections ? this.transparentReflections.getDiagnostics() : { enabled: false, valid: false }
    return { ...actual, ...(reason ? { enabled: false, valid: false, reason } : {}), requested }
  }
  invalidateShadows() {
    if (this.customShadow && !this.destroyed) this.customShadow.invalidate()
  }

  /**
   * B02 deferred lighting control. Experimental: `enhanced` (the default) keeps native forward
   * lighting and is never changed implicitly.
   *
   * @param {object} settings
   * @param {'enhanced'|'deferred'} [settings.mode]
   * @param {boolean} [settings.direct] sun term
   * @param {boolean} [settings.indirect] SH diffuse + prefiltered specular IBL
   * @param {boolean} [settings.emissive]
   * @param {boolean} [settings.shadow] attenuate the sun term only
   * @param {boolean} [settings.ao] attenuate the indirect term only
   * @param {number} [settings.aoStrength] 0..1 blend of the AO visibility
   * @param {number} [settings.debugMode] 0=off, 1=direct, 2=indirect, 3=emissive, 4=shadow, 5=AO, 6=material, 7=albedo
   */
  setLighting(settings = {}) {
    if (this.destroyed) return this.getLightingDiagnostics()
    const input = settings || {}
    const patch = { lightingMode: input.mode, lightingAoStrength: input.aoStrength, lightingDebugMode: input.debugMode }
    for (const key of ['Direct', 'Indirect', 'Emissive', 'Shadow', 'Ao']) patch['lighting' + key] = input[key.toLowerCase()]
    this.options = normalizeOptions(patch, this.options)
    this.applyLighting()
    this.applyMaterialChannels()
    this.applyScreenSpaceAO()
    return this.getLightingDiagnostics()
  }

  getLightingDiagnostics() {
    const requested = this.options.lightingMode === 'deferred' ? 'deferred' : 'enhanced'
    let reason = null
    if (this.destroyed) reason = 'Destroyed'
    else if (!this.enabled) reason = 'Pipeline disabled'
    else if (this.suspensions.size) reason = 'Suspended'
    else if (requested === 'enhanced') reason = 'Enhanced (native forward) lighting requested'
    if (this.deferredLighting) {
      const actual = this.deferredLighting.getDiagnostics()
      return {
        requested, ...actual, ...(reason ? { valid: false, reason, enabled: false } : {}),
        transparentForward: this.transparentForward
          ? this.transparentForward.getDiagnostics()
          : { enabled: false, valid: false, reason: 'Transparent forward was not created', partial: true },
      }
    }
    return {
      requested, enabled: false, attached: false, valid: false, failed: false,
      reason: reason || 'Deferred lighting was not created',
      error: null, partial: false, stats: null,
      terms: null, coverage: null,
      transparentForward: { enabled: false, valid: false, reason: 'Deferred lighting was not created', partial: true },
    }
  }

  // Runtime frame-budget control. Off by default so deterministic measurements can
  // keep a fixed configuration; enable it in the live application. Tuning keys are
  // read once when the governor is created, so changing them recreates it.
  setPerformance(settings = {}) {
    if (this.destroyed) return this.getPerformanceDiagnostics()
    const input = settings || {}
    if (input.enabled === false) {
      if (this.governor) this.governor.setEnabled(false)
      return this.getPerformanceDiagnostics()
    }
    const tuning = ['targetFps', 'targetFrameMs', 'minScale', 'sampleWindow', 'evaluateEvery', 'settleFrames']
      .some(key => input[key] !== undefined)
    if (this.governor && tuning) {
      this.governor.destroy()
      this.governor = null
    }
    if (!this.governor) this.governor = new PerformanceGovernor143(this, input)
    if (input.enabled !== false) this.governor.setEnabled(true)
    return this.getPerformanceDiagnostics()
  }
  getPerformanceDiagnostics() {
    if (this.destroyed) return { enabled: false, reason: 'Destroyed' }
    return this.governor ? this.governor.getDiagnostics() : { enabled: false, reason: 'Not requested' }
  }

  setOptions(options) {
    if (this.destroyed) return this.getOptions()
    const next = normalizeOptions(options, this.options)
    if (next.shadowMode !== this.options.shadowMode || next.environment !== this.options.environment ||
        next.antialiasing !== this.options.antialiasing) this.restore()
    if (this.shadowMap && next.shadowCascades !== this.options.shadowCascades) {
      this.restore()
      this.shadowMap.destroy()
      this.shadowMap = null
    }
    this.options = next
    this.apply()
    return this.getOptions()
  }

  setEnabled(enabled) {
    if (this.destroyed) return
    this.enabled = enabled === true
    if (!this.enabled) this.restore()
    else this.apply()
    this.viewer.scene.requestRender()
  }

  suspend(owner = 'default') {
    if (this.destroyed || this.suspensions.has(owner)) return
    if (!this.suspensions.size) this.restore()
    this.suspensions.add(owner)
    this.viewer.scene.requestRender()
  }

  resume(owner = 'default') {
    if (this.destroyed || !this.suspensions.delete(owner)) return
    this.apply()
  }

  destroy() {
    if (this.destroyed) return
    // Drop the governor first: it must stop listening before the scene is torn down.
    if (this.governor) { this.governor.detach(); this.governor = null }
    if (!this.viewer.isDestroyed()) {
      this.restore()
      const stages = this.viewer.scene.postProcessStages
      stages.remove(this.color)
      this.viewer.scene.requestRender()
    }
    pipelines.delete(this.viewer)
    // Deferred lighting owns a frame bridge, so it must be torn down before the scene is.
    if (this.transparentForward) this.transparentForward.destroy()
    if (this.deferredLighting) this.deferredLighting.destroy()
    if (this.transparentReflections) this.transparentReflections.destroy()
    if (this.screenSpaceReflections) this.screenSpaceReflections.destroy()
    if (this.screenSpaceAO) this.screenSpaceAO.destroy()
    if (this.hdrBloom) this.hdrBloom.destroy()
    if (this.materialChannels) this.materialChannels.destroy()
    if (this.geometry) this.geometry.destroy()
    if (this.taa) this.taa.destroy()
    if (this.smaa) this.smaa.destroy()
    if (this.fxaa) this.fxaa.destroy()
    if (this.environmentRenderer) this.environmentRenderer.destroy()
    if (this.customShadow) this.customShadow.destroy()
    if (this.shadowMap && !this.shadowMap.isDestroyed()) this.shadowMap.destroy()
    if (this.releaseOitCompatibility) this.releaseOitCompatibility()
    this.releaseOitCompatibility = undefined
    this.suspensions.clear()
    this.destroyed = true
  }
}
