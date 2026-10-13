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
    primitives: { add() { assert.fail('CubeMap reflection must not add a Hi-Z primitive') } },
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

function attachEnvironment(pipeline, modelCount = 2) {
  const calls = [], included = new Set(), state = { enabled: false, strength: 1, map: null }
  pipeline.environmentRenderer = {
    lighting: {
      setReflection(settings) { Object.assign(state, settings); calls.push({ ...settings }) },
      setReflectionIncluded(primitive, value) { value ? included.add(primitive) : included.delete(primitive); return included.has(primitive) },
      getReflectionDiagnostics() { return { ...state, valid: state.enabled && !!state.map && modelCount > 0,
        mode: 'cube-map', source: state.map ? 'static-ktx2' : 'none', sceneReflections: false,
        modelCount, readyCount: 0,
        reason: state.enabled && state.map && modelCount ? null : state.enabled ? 'No static environment map configured' : 'Not requested' } }
    },
    setEnabled() {}, destroy() { calls.push({ destroy: true }) }
  }
  return { calls, state, included }
}

test('reflection defaults allocate no SSR owners and expose CubeMap diagnostics', () => {
  const f = fixture(), pipeline = new VisualPipeline(f)
  assert.equal(pipeline.getOptions().environmentReflectionEnabled, false)
  assert.equal(pipeline.getOptions().screenSpaceReflectionEnabled, false)
  assert.equal(pipeline.screenSpaceReflections, undefined)
  assert.equal(pipeline.transparentReflections, undefined)
  assert.equal(pipeline.materialChannels, undefined)
  assert.equal(f.owned.length, 1)
  assert.deepEqual(pipeline.getEnvironmentReflectionDiagnostics(), {
    enabled: false, valid: false, mode: 'cube-map', source: 'none', sceneReflections: false,
    map: null, strength: 1, modelCount: 0, readyCount: 0, reason: 'Not requested',
    requested: { enabled: false, strength: 1, map: null }
  })
  assert.deepEqual(pipeline.getRenderDiagnostics().environmentReflections, pipeline.getEnvironmentReflectionDiagnostics())
  assert.equal(typeof rendering.ScreenSpaceReflection143, 'function')
  pipeline.destroy()
})

test('environment reflection options normalize strict booleans and bounded strength', () => {
  const current = normalizeOptions({ environmentReflectionEnabled: true, environmentReflectionStrength: 0.4,
    environmentReflectionMap: '/assets/environment/campus.ktx2' })
  assert.equal(current.environmentReflectionEnabled, true)
  assert.equal(current.environmentReflectionStrength, 0.4)
  assert.equal(current.environmentReflectionMap, '/assets/environment/campus.ktx2')
  assert.equal(normalizeOptions({ environmentReflectionEnabled: 'true', environmentReflectionStrength: Infinity }, current).environmentReflectionEnabled, true)
  assert.equal(normalizeOptions({ environmentReflectionStrength: -1 }).environmentReflectionStrength, 0)
  assert.equal(normalizeOptions({ environmentReflectionStrength: 2 }).environmentReflectionStrength, 1)
  assert.equal(normalizeOptions({ environmentReflectionMap: '' }, current).environmentReflectionMap, null)
})

test('environment reflection uses CubeMap IBL without SSR, Hi-Z or material attachments', () => {
  const pipeline = new VisualPipeline(fixture()), { calls } = attachEnvironment(pipeline)
  assert.deepEqual(pipeline.setEnvironmentReflections({ enabled: true, strength: 0.45,
    map: '/assets/environment/campus.ktx2' }), {
    enabled: true, strength: 0.45, map: '/assets/environment/campus.ktx2',
    mode: 'cube-map', source: 'static-ktx2', sceneReflections: false
  })
  assert.deepEqual(calls, [{ enabled: true, strength: 0.45, map: '/assets/environment/campus.ktx2' }])
  assert.equal(pipeline.screenSpaceReflections, undefined)
  assert.equal(pipeline.transparentReflections, undefined)
  assert.equal(pipeline.materialChannels, undefined)
  assert.equal(pipeline.getOptions().screenSpaceReflectionEnabled, false)
  assert.equal(pipeline.getOptions().screenSpaceReflectionTransparent, false)
  assert.equal(pipeline.getEnvironmentReflectionDiagnostics().valid, true)
  pipeline.destroy()
})

test('only explicitly included primitives receive environment reflections through the public pipeline', () => {
  const pipeline = new VisualPipeline(fixture()), { included } = attachEnvironment(pipeline)
  const library = { name: 'library.glb' }
  assert.equal(pipeline.setEnvironmentReflectionIncluded(library), true)
  assert.equal(included.has(library), true)
  assert.equal(pipeline.setEnvironmentReflectionIncluded(library, false), false)
  assert.equal(included.has(library), false)
  pipeline.destroy()
})

test('legacy SSR setter migrates to CubeMap and ignores scene sampling settings', () => {
  const f = fixture(), pipeline = new VisualPipeline(f), original = pipeline.getOptions()
  const light = { owner: 'weather' }
  f.viewer.scene.light = light
  f.stages.exposure = 0.7
  attachEnvironment(pipeline)
  assert.deepEqual(pipeline.setScreenSpaceReflections({ enabled: true, strength: 0.3,
    distance: 900, thickness: 4, transparent: true }), {
    enabled: true, strength: 0.3, map: null, mode: 'cube-map', source: 'none', sceneReflections: false
  })
  assert.equal(pipeline.getOptions().screenSpaceReflectionEnabled, false)
  assert.equal(pipeline.getOptions().screenSpaceReflectionTransparent, false)
  assert.equal(pipeline.getOptions().screenSpaceReflectionDistance, original.screenSpaceReflectionDistance)
  assert.equal(pipeline.getOptions().screenSpaceReflectionThickness, original.screenSpaceReflectionThickness)
  assert.equal(pipeline.materialChannels, undefined)
  assert.equal(f.viewer.scene.light, light)
  assert.equal(f.stages.exposure, 0.7)
  assert.equal(pipeline.getScreenSpaceReflectionDiagnostics().sceneReflections, false)
  pipeline.destroy()
})

test('CubeMap reflection follows pipeline disable, suspension, resume and cleanup', () => {
  const pipeline = new VisualPipeline(fixture()), { calls, state } = attachEnvironment(pipeline)
  pipeline.setEnabled(false)
  pipeline.setEnvironmentReflections({ enabled: true, strength: 0.4 })
  assert.equal(state.enabled, false)
  assert.equal(pipeline.getEnvironmentReflectionDiagnostics().reason, 'Pipeline disabled')
  pipeline.setEnabled(true)
  assert.equal(state.enabled, true)
  pipeline.suspend('weather')
  assert.equal(state.enabled, false)
  assert.equal(pipeline.getEnvironmentReflectionDiagnostics().reason, 'Suspended')
  pipeline.resume('weather')
  assert.equal(state.enabled, true)
  pipeline.destroy()
  assert.equal(calls.filter(call => call.destroy).length, 1)
  assert.equal(pipeline.getEnvironmentReflectionDiagnostics().reason, 'Destroyed')
})
