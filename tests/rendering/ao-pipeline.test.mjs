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
    primitives: { add() { assert.fail('unsupported Hi-Z must not add a primitive') } },
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

const defaults = { enabled: false, radius: 3, strength: 1, bias: 0.08 }

function attachOwners(pipeline) {
  const calls = []
  const materials = { enabled: false, depthPyramidEnabled: false,
    setDepthPyramidEnabled(value) { this.depthPyramidEnabled = value; calls.push(['depth', value]) },
    setEnabled(value) { this.enabled = value; calls.push(['materials', value]) },
    getDiagnostics() { return { enabled: this.enabled, valid: this.enabled } },
    getDepthPyramidDiagnostics() { return { enabled: this.enabled && this.depthPyramidEnabled, valid: this.enabled && this.depthPyramidEnabled } },
    destroy() { calls.push(['destroy-materials']) } }
  const ao = { enabled: false,
    setEnabled(value) { this.enabled = value; calls.push(['ao', value]) },
    getDiagnostics() { return { enabled: this.enabled, valid: this.enabled } },
    destroy() { this.enabled = false; calls.push(['destroy-ao']) } }
  pipeline.materialChannels = materials
  pipeline.screenSpaceAO = ao
  return { materials, ao, calls }
}

test('screen-space AO defaults to no resources and exposes public diagnostics and export', () => {
  const f = fixture(), pipeline = new VisualPipeline(f)
  assert.equal(pipeline.getOptions().screenSpaceAoEnabled, false)
  assert.equal(pipeline.screenSpaceAO, undefined)
  assert.equal(pipeline.materialChannels, undefined)
  assert.equal(f.owned.length, 1)
  assert.deepEqual(pipeline.getScreenSpaceAODiagnostics(), {
    enabled: false, valid: false, reason: 'Not requested', requested: defaults
  })
  assert.deepEqual(pipeline.getRenderDiagnostics().screenSpaceAO, pipeline.getScreenSpaceAODiagnostics())
  assert.equal(typeof rendering.ScreenSpaceAo143, 'function')
  pipeline.destroy()
})

test('screen-space AO validates booleans, clamps finite numbers and retains invalid or missing values', () => {
  const input = { screenSpaceAoEnabled: true, screenSpaceAoRadius: 8, screenSpaceAoStrength: 0.5, screenSpaceAoBias: 0.1 }
  const current = normalizeOptions(input)
  assert.equal(current.screenSpaceAoEnabled, true)
  assert.equal(current.screenSpaceAoRadius, 8)
  for (const invalid of [null, {}, { screenSpaceAoEnabled: 1, screenSpaceAoRadius: NaN,
    screenSpaceAoStrength: Infinity, screenSpaceAoBias: '0.2' }]) assert.deepEqual(normalizeOptions(invalid, current), current)
  const low = normalizeOptions({ screenSpaceAoRadius: -1, screenSpaceAoStrength: -1, screenSpaceAoBias: 0 }, current)
  assert.equal(low.screenSpaceAoRadius, 0.1)
  assert.equal(low.screenSpaceAoStrength, 0)
  assert.equal(low.screenSpaceAoBias, 0.02)
  const high = normalizeOptions({ screenSpaceAoRadius: 30, screenSpaceAoStrength: 8, screenSpaceAoBias: 1 }, current)
  assert.equal(high.screenSpaceAoRadius, 20)
  assert.equal(high.screenSpaceAoStrength, 2)
  assert.equal(high.screenSpaceAoBias, 0.5)
  assert.deepEqual(input, { screenSpaceAoEnabled: true, screenSpaceAoRadius: 8, screenSpaceAoStrength: 0.5, screenSpaceAoBias: 0.1 })
})

test('AO partial settings preserve foreign scene state and never create resources while disabled', () => {
  const f = fixture(), pipeline = new VisualPipeline(f), original = pipeline.getOptions()
  const light = { owner: 'weather' }
  f.viewer.scene.light = light
  f.viewer.scene.msaaSamples = 2
  f.stages.exposure = 0.7
  f.viewer.resize = () => assert.fail('AO-only updates must not resize')
  assert.deepEqual(pipeline.setScreenSpaceAO({ radius: 5, strength: 0.7, bias: 0.12,
    exposure: 3, materialChannelsEnabled: true, geometryEnabled: true }), { enabled: false, radius: 5, strength: 0.7, bias: 0.12 })
  for (const input of [null, {}, { enabled: 'true', radius: Infinity, strength: null, bias: NaN }]) {
    assert.deepEqual(pipeline.setScreenSpaceAO(input), { enabled: false, radius: 5, strength: 0.7, bias: 0.12 })
  }
  assert.equal(pipeline.materialChannels, undefined)
  assert.equal(pipeline.screenSpaceAO, undefined)
  assert.equal(pipeline.geometry, undefined)
  assert.equal(f.viewer.scene.light, light)
  assert.equal(f.viewer.scene.msaaSamples, 2)
  assert.equal(f.stages.exposure, 0.7)
  const after = pipeline.getOptions()
  for (const key of Object.keys(original).filter(key => !key.startsWith('screenSpaceAo'))) assert.equal(after[key], original[key])
  pipeline.destroy()
})

test('AO activates both dependencies before its owner while retaining explicit request diagnostics', () => {
  const pipeline = new VisualPipeline(fixture()), { calls, materials, ao } = attachOwners(pipeline)
  assert.deepEqual(pipeline.setScreenSpaceAO({ enabled: true }), { ...defaults, enabled: true })
  assert.deepEqual(calls, [['depth', true], ['materials', true], ['ao', true]])
  assert.deepEqual(pipeline.getMaterialDiagnostics().requested, { enabled: false })
  assert.deepEqual(pipeline.getDepthPyramidDiagnostics().requested, { enabled: false })
  assert.equal(pipeline.getMaterialDiagnostics().enabled, true)
  assert.equal(pipeline.getDepthPyramidDiagnostics().enabled, true)
  pipeline.setMaterialChannels({ enabled: false })
  pipeline.setDepthPyramid({ enabled: false })
  assert.equal(materials.enabled, true)
  assert.equal(materials.depthPyramidEnabled, true)
  assert.equal(ao.enabled, true)
  pipeline.setScreenSpaceAO({ enabled: false })
  assert.equal(materials.enabled, false)
  assert.equal(materials.depthPyramidEnabled, false)
  assert.equal(ao.enabled, false)
  pipeline.destroy()
})

test('disabling AO preserves explicitly requested material and Hi-Z dependencies', () => {
  const pipeline = new VisualPipeline(fixture()), { materials } = attachOwners(pipeline)
  pipeline.setDepthPyramid({ enabled: true })
  pipeline.setScreenSpaceAO({ enabled: true })
  pipeline.setScreenSpaceAO({ enabled: false })
  assert.equal(materials.enabled, true)
  assert.equal(materials.depthPyramidEnabled, true)
  pipeline.setMaterialChannels({ enabled: true })
  pipeline.setDepthPyramid({ enabled: false })
  assert.equal(materials.enabled, true)
  assert.equal(materials.depthPyramidEnabled, false)
  pipeline.destroy()
})

test('disabled and nested suspensions defer AO allocation and resume latest settings', () => {
  const pipeline = new VisualPipeline(fixture())
  pipeline.setEnabled(false)
  pipeline.setScreenSpaceAO({ enabled: true, radius: 4 })
  assert.equal(pipeline.materialChannels, undefined)
  assert.equal(pipeline.screenSpaceAO, undefined)
  assert.equal(pipeline.getScreenSpaceAODiagnostics().reason, 'Pipeline disabled')
  assert.equal(pipeline.getDepthPyramidDiagnostics().reason, 'Pipeline disabled')
  pipeline.suspend('weather')
  pipeline.suspend('analysis')
  pipeline.setEnabled(true)
  assert.equal(pipeline.getScreenSpaceAODiagnostics().reason, 'Suspended')
  pipeline.setScreenSpaceAO({ strength: 0.4 })
  pipeline.resume('weather')
  assert.equal(pipeline.screenSpaceAO, undefined)
  const { calls } = attachOwners(pipeline)
  pipeline.resume('analysis')
  assert.deepEqual(calls, [['depth', true], ['materials', true], ['ao', true]])
  assert.deepEqual(pipeline.getScreenSpaceAODiagnostics().requested, { enabled: true, radius: 4, strength: 0.4, bias: 0.08 })
  pipeline.destroy()
})

test('AO stops before dependencies on restore and destruction is idempotent', () => {
  const pipeline = new VisualPipeline(fixture()), { calls, ao, materials } = attachOwners(pipeline)
  pipeline.setScreenSpaceAO({ enabled: true })
  calls.length = 0
  pipeline.suspend('weather')
  assert.deepEqual(calls, [['ao', false], ['materials', false]])
  assert.equal(ao.enabled, false)
  assert.equal(materials.enabled, false)
  pipeline.resume('weather')
  assert.equal(ao.enabled, true)
  pipeline.setEnabled(false)
  assert.equal(pipeline.getScreenSpaceAODiagnostics().reason, 'Pipeline disabled')
  pipeline.setEnabled(true)
  pipeline.destroy()
  pipeline.destroy()
  assert.equal(calls.filter(([name]) => name === 'destroy-ao').length, 1)
  assert.ok(calls.findIndex(([name]) => name === 'destroy-ao') < calls.findIndex(([name]) => name === 'destroy-materials'))
  assert.equal(pipeline.getScreenSpaceAODiagnostics().reason, 'Destroyed')
  const count = calls.length
  assert.deepEqual(pipeline.setScreenSpaceAO({ enabled: false }), { ...defaults, enabled: true })
  assert.equal(calls.length, count)
})

test('screen-space AO suppresses native AO and restores its requested state when disabled', () => {
  const f = fixture()
  f.options.ambientOcclusion = true
  const pipeline = new VisualPipeline(f)
  attachOwners(pipeline)
  assert.equal(f.stages.ambientOcclusion.enabled, true)
  pipeline.setScreenSpaceAO({ enabled: true })
  assert.equal(f.stages.ambientOcclusion.enabled, false)
  pipeline.setOptions({ exposure: 1.8 })
  assert.equal(f.stages.ambientOcclusion.enabled, false)
  assert.equal(pipeline.getOptions().ambientOcclusion, true)
  pipeline.setScreenSpaceAO({ enabled: false })
  assert.equal(f.stages.ambientOcclusion.enabled, true)
  pipeline.destroy()
  assert.equal(f.stages.ambientOcclusion.enabled, false)
})

test('inactive AO parameter updates do not reclaim externally enabled native AO', () => {
  const f = fixture(), pipeline = new VisualPipeline(f)
  f.stages.ambientOcclusion.enabled = true
  const ownership = pipeline.changes.map(change => ({ ...change }))
  pipeline.setScreenSpaceAO({ radius: 5 })
  assert.equal(f.stages.ambientOcclusion.enabled, true)
  assert.deepEqual(pipeline.changes, ownership)
  assert.equal(pipeline.screenSpaceAO, undefined)
  pipeline.destroy()
  assert.equal(f.stages.ambientOcclusion.enabled, true)
})

test('active AO parameter updates preserve foreign native AO changes and the pass bypasses', () => {
  const f = fixture(), pipeline = new VisualPipeline(f)
  attachOwners(pipeline)
  pipeline.setScreenSpaceAO({ enabled: true })
  f.stages.ambientOcclusion.enabled = true
  const ownership = pipeline.changes.map(change => ({ ...change }))
  pipeline.setScreenSpaceAO({ radius: 5 })
  assert.equal(f.stages.ambientOcclusion.enabled, true)
  assert.deepEqual(pipeline.changes, ownership)
  const pass = Object.create(rendering.ScreenSpaceAo143.prototype)
  class PerspectiveFrustum {}
  Object.assign(pass, { C: { PerspectiveFrustum }, scene: f.viewer.scene, supported: true, enabled: true })
  f.viewer.scene.context._gl = { isContextLost: () => false }
  f.viewer.scene.camera = { frustum: new PerspectiveFrustum() }
  assert.equal(pass._scopeReason(), 'Native AO active')
  pipeline.destroy()
  assert.equal(f.stages.ambientOcclusion.enabled, true)
})

test('turning custom AO off does not overwrite a foreign native AO value', () => {
  const f = fixture(), pipeline = new VisualPipeline(f)
  attachOwners(pipeline)
  pipeline.setScreenSpaceAO({ enabled: true })
  f.stages.ambientOcclusion.enabled = true
  const ownership = pipeline.changes.map(change => ({ ...change }))
  pipeline.setScreenSpaceAO({ enabled: false })
  assert.equal(f.stages.ambientOcclusion.enabled, true)
  assert.deepEqual(pipeline.changes, ownership)
  assert.equal(pipeline.screenSpaceAO.enabled, false)
  pipeline.destroy()
  assert.equal(f.stages.ambientOcclusion.enabled, true)
})
