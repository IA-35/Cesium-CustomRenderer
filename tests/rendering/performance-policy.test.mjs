import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveMsaaPolicy, normalizeAntiAliasing } from '../../src/antialiasing/settings143.js'
import { defaults, normalizeOptions } from '../../src/presets.js'
import VisualPipeline from '../../src/VisualPipeline.js'

// Reference 1080p HDR measurement on the fixed campus view: P95 73.0 ms with
// SMAA + MSAA4 versus P95 20.5 ms with SMAA + MSAA1. Multisampling and post-process
// AA solve the same coverage problem, so the redundant combination must not be the
// default; callers that want the experiment have to opt in explicitly.
test('MSAA and post-process coverage are mutually exclusive unless explicitly combined', () => {
  assert.deepEqual(resolveMsaaPolicy({ antialiasing: 'smaa', msaaSamples: 4 }),
    { requested: 4, effective: 1, combined: false, reason: 'Post-process anti-aliasing owns coverage; MSAA request reduced to 1' })
  assert.deepEqual(resolveMsaaPolicy({ antialiasing: 'fxaa', msaaSamples: 8 }),
    { requested: 8, effective: 1, combined: false, reason: 'Post-process anti-aliasing owns coverage; MSAA request reduced to 1' })
  assert.deepEqual(resolveMsaaPolicy({ antialiasing: 'msaa', msaaSamples: 4 }),
    { requested: 4, effective: 4, combined: false, reason: 'Multisample-only mode' })
  assert.deepEqual(resolveMsaaPolicy({ antialiasing: 'off', msaaSamples: 4 }),
    { requested: 4, effective: 1, combined: false, reason: 'Anti-aliasing disabled' })
  assert.deepEqual(resolveMsaaPolicy({ antialiasing: 'smaa', msaaSamples: 4, msaaCombine: true }),
    { requested: 4, effective: 4, combined: true, reason: 'Combined multisample and post-process anti-aliasing requested' })
})

test('MSAA policy is defensive about malformed and already-reduced requests', () => {
  assert.deepEqual(resolveMsaaPolicy({ antialiasing: 'smaa', msaaSamples: 1 }),
    { requested: 1, effective: 1, combined: false, reason: 'Post-process anti-aliasing owns coverage' })
  assert.equal(resolveMsaaPolicy({ antialiasing: 'smaa' }).effective, 1)
  assert.equal(resolveMsaaPolicy({ antialiasing: 'smaa', msaaSamples: Number.NaN }).requested, 1)
  assert.equal(resolveMsaaPolicy({ antialiasing: 'smaa', msaaSamples: 0 }).requested, 1)
  assert.equal(resolveMsaaPolicy({ antialiasing: 'smaa', msaaSamples: 1, msaaCombine: true }).combined, false)
})

test('the shipped default requests a single MSAA sample and keeps the combination opt-in', () => {
  assert.equal(defaults.antialiasing, 'smaa')
  assert.equal(defaults.msaaSamples, 1)
  assert.equal(defaults.msaaCombine, false)
  assert.equal(normalizeAntiAliasing({ antialiasing: 'taa', msaaSamples: 99 }).msaaSamples, 1)
  assert.equal(normalizeAntiAliasing({ msaaSamples: 4 }).msaaSamples, 4)
  assert.equal(normalizeOptions({ msaaCombine: true }).msaaCombine, true)
  assert.equal(normalizeOptions({ msaaCombine: 'yes' }).msaaCombine, false)
})

function fixture() {
  const stages = {
    tonemapper: 'old', exposure: 2,
    ambientOcclusion: { enabled: false, uniforms: {} },
    bloom: { enabled: false }, fxaa: { enabled: false },
    add() {}, remove() { return true }
  }
  const gl = { RENDERBUFFER: 1, SAMPLES: 2, MAX_SAMPLES: 3, RGBA16F: 4, RGBA32F: 5, RGBA8: 6, DEPTH24_STENCIL8: 7,
    getParameter: () => 8,
    getInternalformatParameter: (target, format) => format === 4 ? new Int32Array([4, 2]) : new Int32Array([8, 4]) }
  const viewer = {
    scene: { light: {}, globe: { enableLighting: false }, postProcessStages: stages, requestRender() {},
      highDynamicRange: true, msaaSupported: true, msaaSamples: 1,
      context: { halfFloatingPointTexture: true, _gl: gl } },
    resolutionScale: 1, useBrowserRecommendedResolution: false, resize() {}, isDestroyed: () => false
  }
  viewer.scene.shadowMap = { size: 1024, maximumDistance: 1000, softShadows: false, enabled: false, _lightCamera: {} }
  Object.defineProperty(viewer, 'shadowMap', { get: () => viewer.scene.shadowMap })
  const Cesium = { VERSION: '1.143.0', Tonemapper: { ACES: 'aces' },
    PostProcessStage: class { constructor(options) { Object.assign(this, options) } },
    SunLight: class {}, ShadowMap: class { constructor(options) { Object.assign(this, options) } isDestroyed() { return false } destroy() {} },
    PostProcessStageLibrary: { isAmbientOcclusionSupported: () => true } }
  return { viewer, Cesium, stages, options: { shadowMode: 'native', environment: false } }
}

test('the pipeline applies the reduced effective MSAA and reports why', () => {
  const f = fixture()
  const pipeline = new VisualPipeline(f)
  assert.equal(f.viewer.scene.msaaSamples, 1)
  const aa = pipeline.getRenderDiagnostics().antiAliasing
  assert.equal(aa.msaa.requested, 1)
  assert.equal(aa.msaa.selected, 1)
  assert.equal(aa.msaa.combined, false)
  assert.equal(aa.msaa.policy, 'Post-process anti-aliasing owns coverage')

  pipeline.setAntiAliasing({ mode: 'smaa', msaaSamples: 4 })
  assert.equal(f.viewer.scene.msaaSamples, 1)
  const reduced = pipeline.getRenderDiagnostics().antiAliasing.msaa
  assert.equal(reduced.requested, 4)
  assert.equal(reduced.selected, 1)
  assert.match(reduced.policy, /reduced to 1/)
  pipeline.destroy()
})

test('opting into the combined mode restores the requested sample count', () => {
  const f = fixture()
  const pipeline = new VisualPipeline(f)
  pipeline.setAntiAliasing({ mode: 'smaa', msaaSamples: 4, msaaCombine: true })
  assert.equal(f.viewer.scene.msaaSamples, 4)
  const aa = pipeline.getRenderDiagnostics().antiAliasing.msaa
  assert.equal(aa.combined, true)
  assert.equal(aa.selected, 4)
  pipeline.destroy()
})

test('multisample-only mode keeps the requested sample count without combining', () => {
  const f = fixture()
  const pipeline = new VisualPipeline(f)
  pipeline.setAntiAliasing({ mode: 'msaa', msaaSamples: 4 })
  assert.equal(f.viewer.scene.msaaSamples, 4)
  const aa = pipeline.getRenderDiagnostics().antiAliasing.msaa
  assert.equal(aa.combined, false)
  assert.equal(aa.policy, 'Multisample-only mode')
  pipeline.destroy()
})
