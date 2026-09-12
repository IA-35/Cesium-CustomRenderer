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

const defaults = { enabled: false, distance: 150, thickness: 0.5, strength: 1, transparent: false }

function attachOwners(pipeline) {
  const calls = []
  const materials = { enabled: false, depthPyramidEnabled: false, reflectionEnabled: false,
    setDepthPyramidEnabled(value) { this.depthPyramidEnabled = value; calls.push(['depth', value]) },
    setReflectionEnabled(value) { this.reflectionEnabled = value; calls.push(['attachments', value]) },
    setEnabled(value) { this.enabled = value; calls.push(['materials', value]) },
    getDiagnostics() { return { enabled: this.enabled, valid: this.enabled } },
    getDepthPyramidDiagnostics() { return { enabled: this.enabled && this.depthPyramidEnabled, valid: this.enabled && this.depthPyramidEnabled } },
    getReflectionDiagnostics() { return { enabled: this.enabled && this.reflectionEnabled, valid: this.enabled && this.reflectionEnabled } },
    destroy() { calls.push(['destroy-materials']) } }
  const consumer = name => ({ enabled: false,
    setEnabled(value) { this.enabled = value; calls.push([name, value]) },
    getDiagnostics() { return { enabled: this.enabled, valid: this.enabled } },
    destroy() { this.enabled = false; calls.push([`destroy-${name}`]) } })
  pipeline.materialChannels = materials
  pipeline.screenSpaceAO = consumer('ao')
  pipeline.screenSpaceReflections = consumer('ssr')
  return { materials, ao: pipeline.screenSpaceAO, ssr: pipeline.screenSpaceReflections, calls }
}

test('SSR defaults allocate no owners and expose diagnostics and the public class', () => {
  const f = fixture(), pipeline = new VisualPipeline(f)
  assert.equal(pipeline.getOptions().screenSpaceReflectionEnabled, false)
  assert.equal(pipeline.screenSpaceReflections, undefined)
  assert.equal(pipeline.materialChannels, undefined)
  assert.equal(f.owned.length, 1)
  assert.deepEqual(pipeline.getScreenSpaceReflectionDiagnostics(), {
    enabled: false, valid: false, reason: 'Not requested', requested: defaults
  })
  assert.deepEqual(pipeline.getRenderDiagnostics().screenSpaceReflections, pipeline.getScreenSpaceReflectionDiagnostics())
  assert.equal(typeof rendering.ScreenSpaceReflection143, 'function')
  pipeline.destroy()
})

test('SSR settings normalize booleans and finite ranges without mutating input', () => {
  const input = { screenSpaceReflectionEnabled: true, screenSpaceReflectionDistance: 500,
    screenSpaceReflectionThickness: 2, screenSpaceReflectionStrength: 0.5 }
  const current = normalizeOptions(input)
  assert.equal(current.screenSpaceReflectionEnabled, true)
  assert.equal(current.screenSpaceReflectionDistance, 500)
  for (const invalid of [null, {}, { screenSpaceReflectionEnabled: 'true', screenSpaceReflectionDistance: Infinity,
    screenSpaceReflectionThickness: NaN, screenSpaceReflectionStrength: '1' }]) assert.deepEqual(normalizeOptions(invalid, current), current)
  const low = normalizeOptions({ screenSpaceReflectionDistance: 0, screenSpaceReflectionThickness: 0, screenSpaceReflectionStrength: -1 })
  assert.equal(low.screenSpaceReflectionDistance, 1)
  assert.equal(low.screenSpaceReflectionThickness, 0.01)
  assert.equal(low.screenSpaceReflectionStrength, 0)
  const high = normalizeOptions({ screenSpaceReflectionDistance: 3000, screenSpaceReflectionThickness: 30, screenSpaceReflectionStrength: 2 })
  assert.equal(high.screenSpaceReflectionDistance, 2000)
  assert.equal(high.screenSpaceReflectionThickness, 20)
  assert.equal(high.screenSpaceReflectionStrength, 1)
  assert.deepEqual(input, { screenSpaceReflectionEnabled: true, screenSpaceReflectionDistance: 500,
    screenSpaceReflectionThickness: 2, screenSpaceReflectionStrength: 0.5 })
})

test('SSR partial updates preserve foreign scene state and never touch AO or AA', () => {
  const f = fixture(), pipeline = new VisualPipeline(f), original = pipeline.getOptions()
  const light = { owner: 'weather' }
  f.viewer.scene.light = light
  f.viewer.scene.msaaSamples = 2
  f.stages.exposure = 0.7
  f.stages.ambientOcclusion.enabled = true
  f.viewer.resize = () => assert.fail('SSR-only updates must not resize')
  const expected = { enabled: false, distance: 300, thickness: 2, strength: 0.4, transparent: false }
  assert.deepEqual(pipeline.setScreenSpaceReflections({ ...expected, exposure: 3, screenSpaceAoEnabled: true }), expected)
  for (const input of [null, {}, { enabled: 1, distance: Infinity, thickness: '2', strength: NaN }]) {
    assert.deepEqual(pipeline.setScreenSpaceReflections(input), expected)
  }
  assert.equal(pipeline.materialChannels, undefined)
  assert.equal(pipeline.screenSpaceReflections, undefined)
  const { ao } = attachOwners(pipeline)
  pipeline.setScreenSpaceReflections({ enabled: true })
  pipeline.setScreenSpaceReflections({ distance: 400 })
  pipeline.setScreenSpaceReflections({ enabled: false })
  assert.equal(ao.enabled, false)
  assert.equal(f.viewer.scene.light, light)
  assert.equal(f.viewer.scene.msaaSamples, 2)
  assert.equal(f.stages.exposure, 0.7)
  assert.equal(f.stages.ambientOcclusion.enabled, true)
  const after = pipeline.getOptions()
  for (const key of Object.keys(original).filter(key => !key.startsWith('screenSpaceReflection'))) assert.equal(after[key], original[key])
  pipeline.destroy()
  assert.equal(f.stages.ambientOcclusion.enabled, true)
})

test('SSR configures material, Hi-Z and reflection attachments before the consumer', () => {
  const pipeline = new VisualPipeline(fixture()), { calls, materials, ssr } = attachOwners(pipeline)
  assert.deepEqual(pipeline.setScreenSpaceReflections({ enabled: true }), { ...defaults, enabled: true })
  assert.deepEqual(calls, [['depth', true], ['attachments', true], ['materials', true], ['ssr', true]])
  assert.equal(pipeline.getMaterialDiagnostics().enabled, true)
  assert.equal(pipeline.getDepthPyramidDiagnostics().enabled, true)
  assert.deepEqual(pipeline.getMaterialDiagnostics().requested, { enabled: false })
  assert.deepEqual(pipeline.getDepthPyramidDiagnostics().requested, { enabled: false })
  pipeline.setMaterialChannels({ enabled: false })
  pipeline.setDepthPyramid({ enabled: false })
  assert.equal(materials.enabled, true)
  assert.equal(materials.depthPyramidEnabled, true)
  assert.equal(materials.reflectionEnabled, true)
  calls.length = 0
  pipeline.setScreenSpaceReflections({ enabled: false })
  assert.deepEqual(calls, [['ssr', false], ['depth', false], ['attachments', false], ['materials', false]])
  assert.equal(ssr.enabled, false)
  pipeline.destroy()
})

test('mixed AO and SSR consumers retain shared dependencies until the last request releases them', () => {
  const pipeline = new VisualPipeline(fixture()), { materials, ao, ssr } = attachOwners(pipeline)
  pipeline.setScreenSpaceAO({ enabled: true })
  assert.equal(materials.reflectionEnabled, false)
  pipeline.setScreenSpaceReflections({ enabled: true })
  pipeline.setScreenSpaceAO({ enabled: false })
  assert.equal(ssr.enabled, true)
  assert.equal(materials.enabled, true)
  assert.equal(materials.depthPyramidEnabled, true)
  assert.equal(materials.reflectionEnabled, true)
  pipeline.setScreenSpaceAO({ enabled: true })
  pipeline.setScreenSpaceReflections({ enabled: false })
  assert.equal(ao.enabled, true)
  assert.equal(materials.enabled, true)
  assert.equal(materials.depthPyramidEnabled, true)
  assert.equal(materials.reflectionEnabled, false)
  pipeline.setScreenSpaceAO({ enabled: false })
  assert.equal(materials.enabled, false)
  pipeline.setDepthPyramid({ enabled: true })
  pipeline.setScreenSpaceReflections({ enabled: true })
  pipeline.setScreenSpaceReflections({ enabled: false })
  assert.equal(materials.enabled, true)
  assert.equal(materials.depthPyramidEnabled, true)
  pipeline.setMaterialChannels({ enabled: true })
  pipeline.setDepthPyramid({ enabled: false })
  assert.equal(materials.enabled, true)
  pipeline.destroy()
})

test('SSR defers allocation while disabled or nested suspended and resumes latest settings', () => {
  const pipeline = new VisualPipeline(fixture())
  pipeline.setEnabled(false)
  pipeline.setScreenSpaceReflections({ enabled: true, distance: 400 })
  assert.equal(pipeline.materialChannels, undefined)
  assert.equal(pipeline.screenSpaceReflections, undefined)
  assert.equal(pipeline.getScreenSpaceReflectionDiagnostics().reason, 'Pipeline disabled')
  assert.equal(pipeline.getMaterialDiagnostics().reason, 'Pipeline disabled')
  assert.equal(pipeline.getDepthPyramidDiagnostics().reason, 'Pipeline disabled')
  pipeline.suspend('weather')
  pipeline.suspend('analysis')
  pipeline.setEnabled(true)
  assert.equal(pipeline.getScreenSpaceReflectionDiagnostics().reason, 'Suspended')
  pipeline.resume('weather')
  assert.equal(pipeline.screenSpaceReflections, undefined)
  pipeline.setScreenSpaceReflections({ strength: 0.4 })
  const { ssr } = attachOwners(pipeline)
  pipeline.resume('analysis')
  assert.equal(ssr.enabled, true)
  assert.deepEqual(pipeline.getScreenSpaceReflectionDiagnostics().requested, { enabled: true, distance: 400, thickness: 0.5, strength: 0.4, transparent: false })
  pipeline.setOptions({ antialiasing: 'off' })
  assert.equal(ssr.enabled, true)
  pipeline.destroy()
})

test('SSR and AO stop before dependencies during restore and destruction', () => {
  const pipeline = new VisualPipeline(fixture()), { calls, ssr } = attachOwners(pipeline)
  pipeline.setScreenSpaceAO({ enabled: true })
  pipeline.setScreenSpaceReflections({ enabled: true })
  calls.length = 0
  pipeline.suspend('weather')
  assert.deepEqual(calls, [['ssr', false], ['ao', false], ['materials', false]])
  pipeline.resume('weather')
  assert.equal(ssr.enabled, true)
  pipeline.setEnabled(false)
  assert.equal(pipeline.getScreenSpaceReflectionDiagnostics().reason, 'Pipeline disabled')
  pipeline.setEnabled(true)
  pipeline.destroy()
  pipeline.destroy()
  assert.equal(calls.filter(([name]) => name === 'destroy-ssr').length, 1)
  assert.ok(calls.findIndex(([name]) => name === 'destroy-ssr') < calls.findIndex(([name]) => name === 'destroy-materials'))
  assert.equal(pipeline.getScreenSpaceReflectionDiagnostics().reason, 'Destroyed')
  const count = calls.length
  assert.deepEqual(pipeline.setScreenSpaceReflections({ enabled: false }), { ...defaults, enabled: true })
  assert.equal(calls.length, count)
})

test('unsupported SSR preserves request diagnostics and the pipeline without GPU allocations', () => {
  const f = fixture(), pipeline = new VisualPipeline({ ...f, options: { ...f.options, screenSpaceReflectionEnabled: true } })
  const diagnostics = pipeline.getScreenSpaceReflectionDiagnostics()
  assert.equal(diagnostics.valid, false)
  assert.equal(diagnostics.enabled, false)
  assert.match(diagnostics.reason, /webgl2/i)
  assert.deepEqual(diagnostics.requested, { ...defaults, enabled: true })
  assert.equal(pipeline.color.enabled, true)
  assert.equal(f.owned.length, 1)
  assert.equal(pipeline.geometry, undefined)
  pipeline.destroy()
})
