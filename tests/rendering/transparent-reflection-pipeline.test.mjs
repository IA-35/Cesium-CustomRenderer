import test from 'node:test'
import assert from 'node:assert/strict'
import VisualPipeline from '../../src/VisualPipeline.js'
import { normalizeOptions } from '../../src/presets.js'
import * as rendering from '../../src/index.js'
import RenderProfiler143 from '../../src/diagnostics/RenderProfiler143.js'

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

function attachOwners(pipeline) {
  const calls = []
  const materials = { enabled: false, reflectionEnabled: false, opaqueColorEnabled: false,
    setDepthPyramidEnabled(value) { this.depthPyramidEnabled = value; calls.push(['depth', value]) },
    setReflectionEnabled(value) { this.reflectionEnabled = value; calls.push(['reflection', value]) },
    setOpaqueColorEnabled(value) { this.opaqueColorEnabled = value; calls.push(['opaque', value]) },
    setEnabled(value) { this.enabled = value; calls.push(['materials', value]) },
    getDiagnostics() { return { enabled: this.enabled, valid: this.enabled } },
    getDepthPyramidDiagnostics() { return { enabled: this.enabled && this.depthPyramidEnabled, valid: this.enabled && this.depthPyramidEnabled } },
    destroy() { calls.push(['destroy-materials']) } }
  const consumer = name => ({ enabled: false,
    setEnabled(value) { this.enabled = value; calls.push([name, value]) },
    getDiagnostics() { return { enabled: this.enabled, valid: this.enabled } },
    destroy() { this.enabled = false; calls.push([`destroy-${name}`]) } })
  pipeline.materialChannels = materials
  pipeline.screenSpaceReflections = consumer('ssr')
  pipeline.screenSpaceAO = consumer('ao')
  pipeline.transparentReflections = consumer('transparent')
  return { calls, materials, transparent: pipeline.transparentReflections }
}

test('transparent reflections default off and standalone request waits for the SSR master switch', () => {
  const f = fixture(), pipeline = new VisualPipeline(f)
  assert.equal(pipeline.getOptions().screenSpaceReflectionTransparent, false)
  assert.equal(pipeline.transparentReflections, undefined)
  assert.equal(typeof rendering.TransparentReflection143, 'function')
  assert.deepEqual(pipeline.getTransparentReflectionDiagnostics(), {
    enabled: false, valid: false, reason: 'Not requested', requested: { enabled: false }
  })
  assert.deepEqual(pipeline.setScreenSpaceReflections({ transparent: true }), {
    enabled: false, transparent: true, distance: 150, thickness: 0.5, strength: 1
  })
  assert.equal(pipeline.transparentReflections, undefined)
  assert.equal(pipeline.materialChannels, undefined)
  assert.equal(pipeline.getTransparentReflectionDiagnostics().reason, 'Screen-space reflections disabled')
  assert.deepEqual(pipeline.getRenderDiagnostics().transparentReflections, pipeline.getTransparentReflectionDiagnostics())
  assert.equal(f.owned.length, 1)
  pipeline.destroy()
})

test('transparent option accepts only booleans and retains partial settings without touching external state', () => {
  const current = normalizeOptions({ screenSpaceReflectionTransparent: true })
  assert.equal(current.screenSpaceReflectionTransparent, true)
  assert.equal(normalizeOptions({ screenSpaceReflectionTransparent: false }, current).screenSpaceReflectionTransparent, false)
  for (const input of [null, {}, { screenSpaceReflectionTransparent: 1 }]) assert.deepEqual(normalizeOptions(input, current), current)
  const f = fixture(), pipeline = new VisualPipeline(f)
  const light = { external: true }
  f.viewer.scene.light = light
  f.viewer.scene.msaaSamples = 2
  f.stages.exposure = 0.5
  f.stages.ambientOcclusion.enabled = true
  f.viewer.resize = () => assert.fail('transparent-only setter must not resize')
  pipeline.setScreenSpaceReflections({ transparent: true })
  for (const input of [null, {}, { transparent: 'false', exposure: 3 }]) assert.equal(pipeline.setScreenSpaceReflections(input).transparent, true)
  assert.equal(f.viewer.scene.light, light)
  assert.equal(f.viewer.scene.msaaSamples, 2)
  assert.equal(f.stages.exposure, 0.5)
  assert.equal(f.stages.ambientOcclusion.enabled, true)
  pipeline.destroy()
})

test('transparent SSR requests opaque color after reflection attachments and leaves opaque SSR and AO enabled on release', () => {
  const pipeline = new VisualPipeline(fixture()), { calls, materials, transparent } = attachOwners(pipeline)
  pipeline.setScreenSpaceAO({ enabled: true })
  calls.length = 0
  pipeline.setScreenSpaceReflections({ enabled: true, transparent: true })
  assert.deepEqual(calls, [['depth', true], ['reflection', true], ['opaque', true], ['materials', true], ['ssr', true], ['transparent', true]])
  assert.equal(transparent.enabled, true)
  calls.length = 0
  pipeline.setScreenSpaceReflections({ transparent: false })
  assert.equal(calls[0][0], 'transparent')
  assert.equal(calls[0][1], false)
  assert.equal(materials.opaqueColorEnabled, false)
  assert.equal(materials.reflectionEnabled, true)
  assert.equal(materials.depthPyramidEnabled, true)
  assert.equal(pipeline.screenSpaceReflections.enabled, true)
  assert.equal(pipeline.screenSpaceAO.enabled, true)
  pipeline.setScreenSpaceReflections({ transparent: true })
  pipeline.setScreenSpaceReflections({ enabled: false })
  assert.equal(pipeline.getOptions().screenSpaceReflectionTransparent, true)
  assert.equal(transparent.enabled, false)
  assert.equal(materials.opaqueColorEnabled, false)
  assert.equal(materials.enabled, true)
  pipeline.destroy()
})

test('transparent SSR defers through disabled and nested suspended states and releases consumers before sources', () => {
  const pipeline = new VisualPipeline(fixture())
  pipeline.setEnabled(false)
  pipeline.setScreenSpaceReflections({ enabled: true, transparent: true })
  assert.equal(pipeline.transparentReflections, undefined)
  assert.equal(pipeline.getTransparentReflectionDiagnostics().reason, 'Pipeline disabled')
  pipeline.suspend('weather')
  pipeline.suspend('analysis')
  pipeline.setEnabled(true)
  assert.equal(pipeline.getTransparentReflectionDiagnostics().reason, 'Suspended')
  pipeline.resume('weather')
  assert.equal(pipeline.transparentReflections, undefined)
  const { calls, transparent } = attachOwners(pipeline)
  pipeline.resume('analysis')
  assert.equal(transparent.enabled, true)
  calls.length = 0
  pipeline.suspend('weather')
  assert.deepEqual(calls.slice(0, 4), [['transparent', false], ['ssr', false], ['ao', false], ['materials', false]])
  pipeline.resume('weather')
  pipeline.destroy()
  pipeline.destroy()
  assert.equal(calls.filter(([name]) => name === 'destroy-transparent').length, 1)
  assert.ok(calls.findIndex(([name]) => name === 'destroy-transparent') < calls.findIndex(([name]) => name === 'destroy-materials'))
  assert.equal(pipeline.getTransparentReflectionDiagnostics().reason, 'Destroyed')
  assert.equal(pipeline.setScreenSpaceReflections({ transparent: false }).transparent, true)
})

test('unavailable transparent capability leaves opaque SSR and AO diagnostic validity intact', () => {
  const pipeline = new VisualPipeline(fixture())
  attachOwners(pipeline)
  pipeline.transparentReflections.getDiagnostics = () => ({ enabled: false, valid: false, reason: 'Missing 7 color attachments' })
  pipeline.setScreenSpaceAO({ enabled: true })
  pipeline.setScreenSpaceReflections({ enabled: true, transparent: true })
  assert.equal(pipeline.getTransparentReflectionDiagnostics().valid, false)
  assert.match(pipeline.getTransparentReflectionDiagnostics().reason, /7 color attachments/)
  assert.equal(pipeline.getScreenSpaceReflectionDiagnostics().valid, true)
  assert.equal(pipeline.getScreenSpaceAODiagnostics().valid, true)
  assert.equal(pipeline.getMaterialDiagnostics().valid, true)
  pipeline.destroy()
})

test('profiler counts transparent reflection work and live delta/output plus opaque-color resources once', () => {
  const texture = bytes => ({ width: 4, height: 4, sizeInBytes: bytes, isDestroyed: () => false })
  const delta = texture(256), output = texture(256), opaqueColor = texture(256)
  const target = { delta, output }
  const transparentReflections = { _execute() { return 17 }, target }
  const scene = { context: { _gl: { getExtension: () => null }, draw() {} }, frameState: { commandList: [] },
    render() { return transparentReflections._execute() } }
  const pipeline = { viewer: { scene }, transparentReflections,
    materialChannels: { _render() {}, target: { opaqueColor } },
    color: { outputTexture: output, isDestroyed: () => false } }
  const profiler = new RenderProfiler143({ VERSION: '1.143' }, pipeline)
  assert.equal(scene.render(), 17)
  const report = profiler.getReport()
  assert.ok(profiler.labels.includes('transparentSsr'))
  assert.ok(report.cpu.some(sample => sample.label === 'transparentSsr'))
  assert.equal(report.textures.currentBytes, 768)
  assert.equal(report.textures.entries.length, 3)
  assert.ok(report.textures.entries.some(entry => entry.name === 'materials.opaqueColor'))
  transparentReflections.target = undefined
  pipeline.materialChannels.target = undefined
  pipeline.color.outputTexture = undefined
  assert.equal(profiler.getReport().textures.currentBytes, 0)
  assert.equal(profiler.getReport().textures.peakBytes, 768)
  profiler.destroy()
})
