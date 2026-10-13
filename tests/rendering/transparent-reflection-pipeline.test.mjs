import test from 'node:test'
import assert from 'node:assert/strict'
import VisualPipeline from '../../src/VisualPipeline.js'
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
    primitives: { add() { assert.fail('environment reflection must not allocate screen-space primitives') } },
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

test('transparent scene reflections remain disabled in CubeMap mode', () => {
  const f = fixture(), pipeline = new VisualPipeline(f)
  assert.equal(typeof rendering.TransparentReflection143, 'function')
  assert.deepEqual(pipeline.getTransparentReflectionDiagnostics(), {
    enabled: false, valid: false, mode: 'cube-map', sceneReflections: false,
    reason: 'Transparent scene reflections disabled', requested: { enabled: false }
  })
  assert.deepEqual(pipeline.setScreenSpaceReflections({ transparent: true }), {
    enabled: false, strength: 1, map: null, mode: 'cube-map', source: 'none', sceneReflections: false
  })
  assert.equal(pipeline.getOptions().screenSpaceReflectionTransparent, false)
  assert.equal(pipeline.transparentReflections, undefined)
  assert.equal(pipeline.materialChannels, undefined)
  assert.equal(f.owned.length, 1)
  pipeline.destroy()
})

test('profiler can still inspect an explicitly supplied legacy transparent reflection pass', () => {
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
