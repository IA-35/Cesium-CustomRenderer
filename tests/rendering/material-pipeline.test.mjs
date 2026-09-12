import test from 'node:test'
import assert from 'node:assert/strict'
import VisualPipeline from '../../src/VisualPipeline.js'
import { normalizeOptions } from '../../src/presets.js'
import * as rendering from '../../src/index.js'

function fixture() {
  const owned = []
  const stages = {
    tonemapper: 'old', exposure: 2,
    ambientOcclusion: { enabled: false, uniforms: {} }, bloom: { enabled: false }, fxaa: { enabled: false },
    add(stage) { owned.push(stage); return stage },
    remove(stage) { const index = owned.indexOf(stage); if (index < 0) return false; owned.splice(index, 1); return true }
  }
  const scene = { light: {}, globe: { enableLighting: false }, postProcessStages: stages,
    context: { webgl2: false }, requestRender() {}, highDynamicRange: false,
    primitives: { add() { assert.fail('unsupported material channel must not add a primitive') } },
    shadowMap: { size: 1024, maximumDistance: 1000, softShadows: false, enabled: false, _lightCamera: {} } }
  const viewer = { scene, resolutionScale: 0.75, useBrowserRecommendedResolution: false, isDestroyed: () => false }
  Object.defineProperty(viewer, 'shadowMap', { get: () => scene.shadowMap })
  const Cesium = {
    VERSION: '1.143.0', Tonemapper: { ACES: 'aces' },
    PostProcessStage: class { constructor(options) { Object.assign(this, options) } },
    SunLight: class {},
    ShadowMap: class {
      constructor(options) { Object.assign(this, options); this._primitiveBias = {}; this._lightCamera = options.lightCamera; this.dead = false }
      isDestroyed() { return this.dead }
      destroy() { this.dead = true }
    },
    PostProcessStageLibrary: { isAmbientOcclusionSupported: () => true }
  }
  return { viewer, Cesium, stages, owned, options: { shadowMode: 'native', environment: false } }
}

test('material channels default to no owner or resources and expose public exports', () => {
  const f = fixture(), pipeline = new VisualPipeline(f)
  assert.equal(pipeline.getOptions().materialChannelsEnabled, false)
  assert.equal(pipeline.materialChannels, undefined)
  assert.equal(f.owned.length, 1)
  const diagnostics = pipeline.getMaterialDiagnostics()
  assert.equal(diagnostics.enabled, false)
  assert.equal(diagnostics.valid, false)
  assert.equal(diagnostics.reason, 'Not requested')
  assert.deepEqual(diagnostics.requested, { enabled: false })
  assert.deepEqual(pipeline.getRenderDiagnostics().materials, diagnostics)
  assert.equal(typeof rendering.MaterialChannels143, 'function')
  assert.equal(rendering.MATERIAL_FLAGS.SURFACE, 1)
  pipeline.destroy()
})

test('material options accept booleans and preserve current values for partial or invalid updates', () => {
  const input = { materialChannelsEnabled: true }, current = normalizeOptions(input)
  assert.equal(current.materialChannelsEnabled, true)
  for (const invalid of [null, {}, { materialChannelsEnabled: 'true' }, { materialChannelsEnabled: 1 }]) {
    assert.equal(normalizeOptions(invalid, current).materialChannelsEnabled, true)
  }
  assert.equal(normalizeOptions({ materialChannelsEnabled: false }, current).materialChannelsEnabled, false)
  assert.deepEqual(input, { materialChannelsEnabled: true })
})

test('unsupported material channel retains the request without creating primitives or extra stages', () => {
  const f = fixture(), pipeline = new VisualPipeline(f)
  assert.deepEqual(pipeline.setMaterialChannels({ enabled: true }), { enabled: true })
  const diagnostics = pipeline.getMaterialDiagnostics()
  assert.equal(diagnostics.supported, false)
  assert.equal(diagnostics.enabled, false)
  assert.equal(diagnostics.valid, false)
  assert.match(diagnostics.reason, /webgl2/i)
  assert.deepEqual(diagnostics.requested, { enabled: true })
  assert.equal(f.owned.length, 1)
  assert.equal(pipeline.color.enabled, true)
  const owner = pipeline.materialChannels
  pipeline.destroy()
  assert.equal(owner.isDestroyed(), true)
})

test('material-only updates preserve unrelated externally changed scene properties', () => {
  const f = fixture(), pipeline = new VisualPipeline(f)
  const original = pipeline.getOptions(), foreignLight = { owner: 'weather' }
  f.viewer.scene.light = foreignLight
  f.viewer.scene.msaaSamples = 2
  f.stages.exposure = 0.8
  f.viewer.resize = () => assert.fail('material-only update must not resize')
  for (const settings of [{ enabled: true, exposure: 3 }, {}, null, { enabled: 'false' }, { enabled: false }]) {
    pipeline.setMaterialChannels(settings)
    assert.equal(f.viewer.scene.light, foreignLight)
    assert.equal(f.viewer.scene.msaaSamples, 2)
    assert.equal(f.stages.exposure, 0.8)
    assert.deepEqual({ ...pipeline.getOptions(), materialChannelsEnabled: false }, original)
  }
  pipeline.destroy()
  assert.equal(f.viewer.scene.light, foreignLight)
  assert.equal(f.stages.exposure, 0.8)
})

test('disabled, suspended and destroyed requests remain deferred without channel creation', () => {
  const f = fixture(), pipeline = new VisualPipeline(f)
  pipeline.setEnabled(false)
  pipeline.setMaterialChannels({ enabled: true })
  assert.equal(pipeline.materialChannels, undefined)
  assert.equal(pipeline.getMaterialDiagnostics().reason, 'Pipeline disabled')
  pipeline.suspend('weather')
  pipeline.suspend('analysis')
  pipeline.setEnabled(true)
  assert.equal(pipeline.getMaterialDiagnostics().reason, 'Suspended')
  pipeline.resume('weather')
  assert.equal(pipeline.materialChannels, undefined)
  pipeline.setMaterialChannels({ enabled: false })
  assert.equal(pipeline.getMaterialDiagnostics().reason, 'Not requested')
  pipeline.setMaterialChannels({ enabled: true })
  pipeline.destroy()
  assert.equal(pipeline.getMaterialDiagnostics().reason, 'Destroyed')
  assert.deepEqual(pipeline.setMaterialChannels({ enabled: false }), { enabled: true })
  assert.equal(pipeline.materialChannels, undefined)
})

test('existing material owner follows pipeline disable, nested suspension, resume and destruction', () => {
  const f = fixture(), pipeline = new VisualPipeline(f), calls = []
  const owner = { enabled: false, destroyed: false,
    setEnabled(value) { this.enabled = value; calls.push(value) },
    getDiagnostics() { return { enabled: this.enabled, valid: this.enabled, reason: this.enabled ? null : 'Disabled' } },
    destroy() { this.destroyed = true }, isDestroyed() { return this.destroyed } }
  pipeline.materialChannels = owner
  pipeline.setMaterialChannels({ enabled: true })
  assert.equal(pipeline.getMaterialDiagnostics().enabled, true)
  pipeline.suspend('weather')
  pipeline.suspend('analysis')
  assert.equal(owner.enabled, false)
  assert.equal(pipeline.getMaterialDiagnostics().reason, 'Suspended')
  pipeline.resume('weather')
  assert.equal(owner.enabled, false)
  pipeline.resume('analysis')
  assert.equal(owner.enabled, true)
  pipeline.setEnabled(false)
  assert.equal(owner.enabled, false)
  assert.equal(pipeline.getMaterialDiagnostics().reason, 'Pipeline disabled')
  pipeline.setEnabled(true)
  assert.equal(owner.enabled, true)
  pipeline.destroy()
  pipeline.destroy()
  assert.equal(owner.destroyed, true)
  assert.equal(pipeline.getMaterialDiagnostics().reason, 'Destroyed')
  assert.deepEqual(calls, [true, false, true, false, true, false])
})

test('albedo defaults off and its dedicated setter creates only the material producer', () => {
  const f = fixture(), pipeline = new VisualPipeline(f)
  assert.equal(pipeline.getOptions().albedoEnabled, false)
  assert.deepEqual(pipeline.getAlbedoDiagnostics().requested, { enabled: false })
  const foreignLight = { owner: 'external' }
  f.viewer.scene.light = foreignLight
  f.viewer.scene.msaaSamples = 3
  f.stages.exposure = 0.75
  assert.deepEqual(pipeline.setAlbedo({ enabled: true, exposure: 4 }), { enabled: true })
  assert.equal(pipeline.getOptions().depthPyramidEnabled, false)
  assert.equal(pipeline.getOptions().screenSpaceReflectionEnabled, false)
  assert.equal(pipeline.getOptions().screenSpaceAoEnabled, false)
  assert.equal(pipeline.materialChannels.depthPyramidEnabled, false)
  assert.equal(pipeline.materialChannels.reflectionRequested, false)
  assert.equal(pipeline.materialChannels.albedoRequested, true)
  assert.equal(f.viewer.scene.light, foreignLight)
  assert.equal(f.viewer.scene.msaaSamples, 3)
  assert.equal(f.stages.exposure, 0.75)
  assert.deepEqual(pipeline.getRenderDiagnostics().albedo, pipeline.getAlbedoDiagnostics())
  pipeline.destroy()
})

test('albedo request survives suspension and releases independently from explicit material, AO and SSR consumers', () => {
  const f = fixture(), pipeline = new VisualPipeline(f), calls = []
  const owner = { enabled: false, depthPyramidEnabled: false, reflectionEnabled: false, opaqueColorEnabled: false, albedoEnabled: false,
    setDepthPyramidEnabled(value) { this.depthPyramidEnabled = value; calls.push(['depth', value]) },
    setReflectionEnabled(value) { this.reflectionEnabled = value; calls.push(['reflection', value]) },
    setOpaqueColorEnabled(value) { this.opaqueColorEnabled = value; calls.push(['opaque', value]) },
    setAlbedoEnabled(value) { this.albedoEnabled = value; calls.push(['albedo', value]) },
    setEnabled(value) { this.enabled = value; calls.push(['enabled', value]) },
    getDiagnostics() { return { enabled: this.enabled, valid: this.enabled } },
    getAlbedoDiagnostics() { return { enabled: this.enabled && this.albedoEnabled, valid: this.enabled && this.albedoEnabled } },
    getDepthPyramidDiagnostics() { return { enabled: this.enabled && this.depthPyramidEnabled, valid: this.enabled && this.depthPyramidEnabled } },
    destroy() {} }
  pipeline.materialChannels = owner
  pipeline.screenSpaceAO = { setEnabled() {}, destroy() {}, getDiagnostics() { return { valid: true } } }
  pipeline.screenSpaceReflections = { setEnabled() {}, destroy() {}, getDiagnostics() { return { valid: true } } }
  pipeline.transparentReflections = { setEnabled() {}, destroy() {}, getDiagnostics() { return { valid: true } } }
  pipeline.suspend('weather')
  pipeline.setAlbedo({ enabled: true })
  pipeline.setMaterialChannels({ enabled: true })
  assert.equal(owner.albedoEnabled, false)
  pipeline.resume('weather')
  assert.equal(owner.albedoEnabled, true)
  assert.equal(owner.depthPyramidEnabled, false)
  pipeline.setScreenSpaceAO({ enabled: true })
  pipeline.setScreenSpaceReflections({ enabled: true, transparent: true })
  pipeline.setAlbedo({ enabled: false })
  assert.equal(owner.albedoEnabled, false)
  assert.equal(owner.enabled, true)
  assert.equal(owner.depthPyramidEnabled, true)
  assert.equal(owner.reflectionEnabled, true)
  assert.equal(owner.opaqueColorEnabled, true)
  pipeline.setScreenSpaceAO({ enabled: false })
  pipeline.setScreenSpaceReflections({ enabled: false })
  assert.equal(owner.enabled, true)
  assert.equal(owner.depthPyramidEnabled, false)
  assert.equal(owner.reflectionEnabled, false)
  assert.equal(owner.opaqueColorEnabled, false)
  assert.ok(calls.some(call => call[0] === 'albedo'))
  pipeline.destroy()
})
