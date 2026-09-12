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

function attachOwner(pipeline) {
  const calls = []
  const owner = { enabled: false, depthPyramidEnabled: false, destroyed: false,
    setDepthPyramidEnabled(value) { this.depthPyramidEnabled = value; calls.push(['depthPyramid', value]) },
    setEnabled(value) { this.enabled = value; calls.push(['materials', value]) },
    getDiagnostics() { return { enabled: this.enabled, valid: this.enabled, reason: this.enabled ? null : 'Disabled' } },
    getDepthPyramidDiagnostics() {
      const enabled = this.enabled && this.depthPyramidEnabled
      return { enabled, valid: enabled, reason: enabled ? null : 'Disabled', levels: enabled ? 5 : 0 }
    },
    destroy() { this.enabled = false; this.destroyed = true; calls.push(['destroy']) } }
  pipeline.materialChannels = owner
  return { owner, calls }
}

test('Hi-Z defaults to no material owner or extra stages and exposes diagnostics and export', () => {
  const f = fixture(), pipeline = new VisualPipeline(f)
  assert.equal(pipeline.getOptions().depthPyramidEnabled, false)
  assert.equal(pipeline.materialChannels, undefined)
  assert.equal(pipeline.geometry, undefined)
  assert.equal(f.owned.length, 1)
  assert.deepEqual(pipeline.getDepthPyramidDiagnostics(), {
    enabled: false, valid: false, reason: 'Not requested', requested: { enabled: false }
  })
  assert.deepEqual(pipeline.getRenderDiagnostics().depthPyramid, pipeline.getDepthPyramidDiagnostics())
  assert.equal(typeof rendering.DepthPyramid143, 'function')
  pipeline.destroy()
})

test('Hi-Z accepts only boolean options and preserves partial and invalid updates', () => {
  const input = { depthPyramidEnabled: true }, current = normalizeOptions(input)
  assert.equal(current.depthPyramidEnabled, true)
  for (const invalid of [null, {}, { depthPyramidEnabled: 'false' }, { depthPyramidEnabled: 0 }]) {
    assert.equal(normalizeOptions(invalid, current).depthPyramidEnabled, true)
  }
  assert.equal(normalizeOptions({ depthPyramidEnabled: false }, current).depthPyramidEnabled, false)
  assert.deepEqual(input, { depthPyramidEnabled: true })
})

test('Hi-Z configures its material dependency first without changing the explicit material request', () => {
  const f = fixture(), pipeline = new VisualPipeline(f), { owner, calls } = attachOwner(pipeline)
  assert.deepEqual(pipeline.setDepthPyramid({ enabled: true }), { enabled: true })
  assert.deepEqual(calls, [['depthPyramid', true], ['materials', true]])
  assert.equal(pipeline.getMaterialDiagnostics().enabled, true)
  assert.deepEqual(pipeline.getMaterialDiagnostics().requested, { enabled: false })
  assert.equal(pipeline.getDepthPyramidDiagnostics().levels, 5)
  pipeline.setMaterialChannels({ enabled: false })
  assert.equal(owner.enabled, true)
  assert.equal(owner.depthPyramidEnabled, true)
  pipeline.setDepthPyramid({ enabled: false })
  assert.equal(owner.enabled, false)
  assert.equal(pipeline.getMaterialDiagnostics().reason, 'Not requested')
  pipeline.destroy()
})

test('disabling Hi-Z preserves materials explicitly requested by the caller', () => {
  const pipeline = new VisualPipeline(fixture()), { owner } = attachOwner(pipeline)
  pipeline.setMaterialChannels({ enabled: true })
  pipeline.setDepthPyramid({ enabled: true })
  pipeline.setDepthPyramid({ enabled: false })
  assert.equal(owner.enabled, true)
  assert.equal(owner.depthPyramidEnabled, false)
  assert.equal(pipeline.getMaterialDiagnostics().enabled, true)
  assert.deepEqual(pipeline.getMaterialDiagnostics().requested, { enabled: true })
  assert.equal(pipeline.getDepthPyramidDiagnostics().reason, 'Not requested')
  pipeline.destroy()
})

test('Hi-Z setter changes only its owned settings and leaves geometry and foreign scene properties untouched', () => {
  const f = fixture(), pipeline = new VisualPipeline(f), { owner } = attachOwner(pipeline)
  const original = pipeline.getOptions(), foreignLight = { owner: 'weather' }
  f.viewer.scene.light = foreignLight
  f.viewer.scene.msaaSamples = 2
  f.stages.exposure = 0.8
  f.viewer.resize = () => assert.fail('Hi-Z-only update must not resize')
  pipeline.geometry = { setEnabled() { assert.fail('Hi-Z-only update must not reconfigure geometry') } }
  for (const settings of [{ enabled: true, materialChannelsEnabled: true, geometryEnabled: true, exposure: 3 },
    {}, null, { enabled: 'false' }]) {
    assert.deepEqual(pipeline.setDepthPyramid(settings), { enabled: true })
    assert.equal(owner.depthPyramidEnabled, true)
    assert.equal(f.viewer.scene.light, foreignLight)
    assert.equal(f.viewer.scene.msaaSamples, 2)
    assert.equal(f.stages.exposure, 0.8)
    assert.deepEqual({ ...pipeline.getOptions(), depthPyramidEnabled: false }, original)
  }
  pipeline.geometry = undefined
  pipeline.destroy()
})

test('disabled and nested suspension requests defer material ownership until resumed', () => {
  const pipeline = new VisualPipeline(fixture())
  pipeline.setEnabled(false)
  pipeline.setDepthPyramid({ enabled: true })
  assert.equal(pipeline.materialChannels, undefined)
  assert.equal(pipeline.getDepthPyramidDiagnostics().reason, 'Pipeline disabled')
  assert.equal(pipeline.getMaterialDiagnostics().reason, 'Pipeline disabled')
  pipeline.suspend('weather')
  pipeline.suspend('analysis')
  pipeline.setEnabled(true)
  assert.equal(pipeline.getDepthPyramidDiagnostics().reason, 'Suspended')
  pipeline.resume('weather')
  assert.equal(pipeline.materialChannels, undefined)
  pipeline.setDepthPyramid({ enabled: false })
  assert.equal(pipeline.getDepthPyramidDiagnostics().reason, 'Not requested')
  pipeline.setDepthPyramid({ enabled: true })
  const { owner, calls } = attachOwner(pipeline)
  pipeline.resume('analysis')
  assert.deepEqual(calls, [['depthPyramid', true], ['materials', true]])
  assert.equal(owner.enabled, true)
  assert.equal(pipeline.getDepthPyramidDiagnostics().valid, true)
  pipeline.destroy()
})

test('an existing Hi-Z owner follows disable, suspension, resume and idempotent destruction', () => {
  const pipeline = new VisualPipeline(fixture()), { owner, calls } = attachOwner(pipeline)
  pipeline.setDepthPyramid({ enabled: true })
  pipeline.setEnabled(false)
  assert.equal(owner.enabled, false)
  assert.equal(pipeline.getDepthPyramidDiagnostics().reason, 'Pipeline disabled')
  pipeline.setEnabled(true)
  assert.equal(pipeline.getDepthPyramidDiagnostics().valid, true)
  pipeline.suspend('weather')
  assert.equal(owner.enabled, false)
  assert.equal(pipeline.getDepthPyramidDiagnostics().reason, 'Suspended')
  pipeline.setDepthPyramid({ enabled: false })
  pipeline.resume('weather')
  assert.equal(owner.enabled, false)
  assert.equal(owner.depthPyramidEnabled, false)
  pipeline.setDepthPyramid({ enabled: true })
  pipeline.destroy()
  pipeline.destroy()
  assert.equal(owner.destroyed, true)
  assert.equal(calls.filter(([action]) => action === 'destroy').length, 1)
  assert.equal(pipeline.getDepthPyramidDiagnostics().reason, 'Destroyed')
  assert.equal(pipeline.getDepthPyramidDiagnostics().valid, false)
  const count = calls.length
  assert.deepEqual(pipeline.setDepthPyramid({ enabled: false }), { enabled: true })
  assert.equal(calls.length, count)
})

test('unsupported Hi-Z requests preserve diagnostics without allocating GPU resources', () => {
  const f = fixture(), pipeline = new VisualPipeline({ ...f, options: { ...f.options, depthPyramidEnabled: true } })
  assert.ok(pipeline.materialChannels)
  assert.equal(pipeline.geometry, undefined)
  const diagnostics = pipeline.getDepthPyramidDiagnostics()
  assert.deepEqual(diagnostics.requested, { enabled: true })
  assert.equal(diagnostics.enabled, false)
  assert.equal(diagnostics.valid, false)
  assert.match(diagnostics.reason, /webgl2/i)
  assert.equal(f.owned.length, 1)
  assert.equal(pipeline.color.enabled, true)
  pipeline.destroy()
})
