import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import VisualPipeline, { getVisualPipeline } from '../../src/VisualPipeline.js'
import * as rendering from '../../src/index.js'
import { defaultFilters, normalizeOptions, resolveSavedFilters } from '../../src/presets.js'

function fixture() {
  const owned = []
  const stages = {
    tonemapper: 'old', exposure: 2,
    ambientOcclusion: { enabled: false, uniforms: { intensity: 3, directionCount: 8, stepCount: 32, lengthCap: 0.26 } },
    bloom: { enabled: false }, fxaa: { enabled: false },
    add(stage) { owned.push(stage); return stage },
    remove(stage) { const i = owned.indexOf(stage); if (i < 0) return false; owned.splice(i, 1); return true }
  }
  const viewer = {
    scene: { light: {}, globe: { enableLighting: false }, postProcessStages: stages, requestRender() {}, highDynamicRange: false },
    shadowMap: { size: 1024, maximumDistance: 1000, softShadows: false },
    shadows: false, resolutionScale: 0.75, useBrowserRecommendedResolution: false,
    isDestroyed: () => false
  }
  viewer.scene.shadowMap = viewer.shadowMap
  viewer.scene.shadowMap.enabled = false
  viewer.scene.shadowMap._lightCamera = {}
  Object.defineProperty(viewer, 'shadowMap', { get: () => viewer.scene.shadowMap })
  Object.defineProperty(viewer, 'shadows', {
    get: () => viewer.scene.shadowMap.enabled,
    set: value => { viewer.scene.shadowMap.enabled = value }
  })
  const Cesium = {
    VERSION: '1.143.0', Tonemapper: { ACES: 'aces' },
    PostProcessStage: class { constructor(options) { Object.assign(this, options) } },
    SunLight: class {},
    ShadowMap: class {
      constructor(options) {
        Object.assign(this, options)
        this._primitiveBias = { depthBias: 0.00002, normalOffsetScale: 0.1 }
        this._lightCamera = options.lightCamera
        this.dead = false
      }
      isDestroyed() { return this.dead }
      destroy() { this.dead = true }
    },
    PostProcessStageLibrary: { isAmbientOcclusionSupported: () => true, isDepthOfFieldSupported: () => true }
  }
  // These compatibility tests exercise native fallback; real custom GPU behavior
  // is covered by shadow-fixture.html and the custom-shadow tests.
  return { viewer, Cesium, stages, owned, options: { shadowMode: 'native', environment: false } }
}

function geometryFixture(capabilities = {}) {
  const f = fixture()
  const C = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')
  for (const key of ['PostProcessStage', 'PostProcessStageComposite', 'PixelFormat', 'PixelDatatype',
    'PostProcessStageSampleMode', 'Color', 'SceneMode']) f.Cesium[key] = C[key]
  f.stages = new C.PostProcessStageCollection()
  Object.assign(f.viewer.scene, {
    postProcessStages: f.stages,
    context: { depthTexture: true, floatingPointTexture: true, colorBufferFloat: true,
      halfFloatingPointTexture: true, colorBufferHalfFloat: true, ...capabilities },
    mode: C.SceneMode.SCENE3D,
    _view: { frustumCommandsList: [{}] },
    drawingBufferWidth: 800, drawingBufferHeight: 600
  })
  return f
}

test('geometry defaults to no channel or stage and exports the standalone channel', () => {
  const f = fixture()
  const pipeline = new VisualPipeline(f)
  assert.equal(pipeline.getOptions().geometryEnabled, false)
  assert.equal(pipeline.getOptions().geometryDebugMode, 'off')
  assert.equal(pipeline.geometry, undefined)
  assert.equal(f.owned.length, 1)
  const diagnostics = pipeline.getGeometryDiagnostics()
  assert.equal(diagnostics.enabled, false)
  assert.equal(diagnostics.valid, false)
  assert.equal(diagnostics.reason, 'Not requested')
  assert.deepEqual(pipeline.getRenderDiagnostics().geometry, diagnostics)
  assert.equal(typeof rendering.ScreenSpaceGeometry143, 'function')
  pipeline.destroy()
})

test('geometry options accept only booleans and supported debug modes without mutation', () => {
  const input = { geometryEnabled: true, geometryDebugMode: 'depth' }
  const current = normalizeOptions(input)
  assert.equal(current.geometryEnabled, true)
  assert.equal(current.geometryDebugMode, 'depth')
  for (const invalid of [null, {}, { geometryEnabled: 'true', geometryDebugMode: 'Depth' },
    { geometryEnabled: 1, geometryDebugMode: false }]) {
    const result = normalizeOptions(invalid, current)
    assert.equal(result.geometryEnabled, true)
    assert.equal(result.geometryDebugMode, 'depth')
  }
  assert.deepEqual(input, { geometryEnabled: true, geometryDebugMode: 'depth' })
})

test('geometry partial updates retain settings and debug alone never creates a channel', () => {
  const f = geometryFixture()
  const pipeline = new VisualPipeline(f)
  assert.deepEqual(pipeline.setGeometry({ debugMode: 'normal' }), { enabled: false, debugMode: 'normal' })
  assert.equal(pipeline.geometry, undefined)
  assert.equal(f.stages.length, 1)
  assert.deepEqual(pipeline.setGeometry({ enabled: true }), { enabled: true, debugMode: 'normal' })
  const geometry = pipeline.geometry
  assert.equal(geometry.getDiagnostics().valid, true)
  assert.equal(geometry.outputStage.uniforms.debugMode(), 1)
  assert.equal(f.stages.length, 2)
  pipeline.setGeometry({ debugMode: 'depth' })
  assert.equal(geometry.outputStage.uniforms.debugMode(), 2)
  for (const invalid of [null, {}, { enabled: 'false', debugMode: 'invalid' }]) {
    assert.deepEqual(pipeline.setGeometry(invalid), { enabled: true, debugMode: 'depth' })
  }
  pipeline.setGeometry({ enabled: false })
  assert.equal(geometry.enabled, false)
  pipeline.setGeometry({ enabled: true })
  assert.equal(pipeline.geometry, geometry)
  pipeline.destroy()
  assert.equal(geometry.isDestroyed(), true)
  assert.equal(pipeline.getGeometryDiagnostics().valid, false)
  assert.deepEqual(pipeline.setGeometry({ enabled: false }), { enabled: true, debugMode: 'depth' })
  f.stages.destroy()
})

test('geometry requested at construction starts active and follows disable and re-enable', () => {
  const f = geometryFixture()
  const pipeline = new VisualPipeline({ ...f, options: { ...f.options, geometryEnabled: true, geometryDebugMode: 'depth' } })
  assert.equal(pipeline.getGeometryDiagnostics().enabled, true)
  assert.equal(pipeline.getGeometryDiagnostics().debugMode, 'depth')
  pipeline.setEnabled(false)
  assert.equal(pipeline.getGeometryDiagnostics().enabled, false)
  pipeline.setGeometry({ debugMode: 'normal' })
  assert.equal(pipeline.getGeometryDiagnostics().enabled, false)
  pipeline.setEnabled(true)
  assert.equal(pipeline.getGeometryDiagnostics().enabled, true)
  assert.equal(pipeline.getGeometryDiagnostics().debugMode, 'normal')
  pipeline.destroy()
  f.stages.destroy()
})

test('geometry-only updates preserve unrelated scene state and settings', () => {
  const f = geometryFixture()
  const pipeline = new VisualPipeline(f)
  const originalOptions = pipeline.getOptions()
  const externalLight = { owner: 'weather' }
  f.viewer.scene.light = externalLight
  f.viewer.scene.msaaSamples = 2
  f.stages.exposure = 0.8
  f.viewer.resize = () => assert.fail('geometry settings must not resize the viewer')
  for (const settings of [{ debugMode: 'normal', exposure: 3 }, { enabled: true },
    { debugMode: 'depth' }, { enabled: false }]) {
    pipeline.setGeometry(settings)
    assert.equal(f.viewer.scene.light, externalLight)
    assert.equal(f.viewer.scene.msaaSamples, 2)
    assert.equal(f.stages.exposure, 0.8)
    const options = pipeline.getOptions()
    delete options.geometryEnabled
    delete options.geometryDebugMode
    const expected = { ...originalOptions }
    delete expected.geometryEnabled
    delete expected.geometryDebugMode
    assert.deepEqual(options, expected)
  }
  pipeline.destroy()
  f.stages.destroy()
})

test('deferred geometry diagnostics distinguish suspended and disabled requests', () => {
  const f = geometryFixture()
  const pipeline = new VisualPipeline(f)
  pipeline.setEnabled(false)
  pipeline.setGeometry({ enabled: true })
  assert.equal(pipeline.geometry, undefined)
  assert.equal(pipeline.getGeometryDiagnostics().reason, 'Pipeline disabled')
  pipeline.suspend('weather')
  pipeline.setEnabled(true)
  assert.equal(pipeline.geometry, undefined)
  assert.equal(pipeline.getGeometryDiagnostics().reason, 'Suspended')
  pipeline.setGeometry({ enabled: false })
  assert.equal(pipeline.getGeometryDiagnostics().reason, 'Not requested')
  pipeline.destroy()
  f.stages.destroy()
})

test('nested suspension defers geometry creation and resumes the latest requested configuration', () => {
  const f = geometryFixture()
  const pipeline = new VisualPipeline(f)
  pipeline.suspend('weather')
  pipeline.suspend('analysis')
  pipeline.setGeometry({ enabled: true, debugMode: 'normal' })
  assert.equal(pipeline.geometry, undefined)
  assert.equal(pipeline.getGeometryDiagnostics().reason, 'Suspended')
  pipeline.resume('weather')
  assert.equal(pipeline.geometry, undefined)
  pipeline.setGeometry({ debugMode: 'depth' })
  pipeline.resume('analysis')
  assert.equal(pipeline.getGeometryDiagnostics().enabled, true)
  assert.equal(pipeline.getGeometryDiagnostics().debugMode, 'depth')
  pipeline.suspend('weather')
  assert.equal(pipeline.getGeometryDiagnostics().enabled, false)
  pipeline.setGeometry({ enabled: false })
  pipeline.resume('weather')
  assert.equal(pipeline.getGeometryDiagnostics().enabled, false)
  pipeline.destroy()
  f.stages.destroy()
})

test('unsupported geometry retains the request without adding a stage or breaking the pipeline', () => {
  const f = geometryFixture({ depthTexture: false })
  const pipeline = new VisualPipeline(f)
  assert.deepEqual(pipeline.setGeometry({ enabled: true, debugMode: 'normal' }), { enabled: true, debugMode: 'normal' })
  const diagnostics = pipeline.getGeometryDiagnostics()
  assert.equal(diagnostics.enabled, false)
  assert.equal(diagnostics.supported, false)
  assert.equal(diagnostics.valid, false)
  assert.match(diagnostics.reason, /depthTexture/)
  assert.deepEqual(diagnostics.requested, { enabled: true, debugMode: 'normal' })
  assert.equal(f.stages.length, 1)
  assert.equal(pipeline.color.enabled, true)
  pipeline.destroy()
  assert.equal(f.stages.length, 0)
  f.stages.destroy()
})

test('ten geometry lifecycle cycles preserve foreign stages and externally changed properties', () => {
  const f = geometryFixture()
  const foreign = f.stages.add(new f.Cesium.PostProcessStage({
    name: 'foreign-geometry-consumer', fragmentShader: 'void main() { out_FragColor = vec4(1.0); }'
  }))
  for (let i = 0; i < 10; i++) {
    const pipeline = new VisualPipeline({ ...f, options: { ...f.options, geometryEnabled: true } })
    const geometry = pipeline.geometry
    assert.equal(f.stages.length, 3)
    const externalLight = { iteration: i }
    f.viewer.scene.light = externalLight
    pipeline.suspend('weather')
    assert.equal(foreign.enabled, true)
    assert.equal(f.viewer.scene.light, externalLight)
    pipeline.resume('weather')
    pipeline.destroy()
    pipeline.destroy()
    assert.equal(f.viewer.scene.light, externalLight)
    assert.equal(geometry.isDestroyed(), true)
    assert.equal(geometry.composite.isDestroyed(), true)
    assert.equal(f.stages.length, 1)
    assert.equal(f.stages.contains(foreign), true)
    assert.equal(foreign.isDestroyed(), false)
  }
  f.stages.destroy()
})

test('invalid and extreme settings are sanitized without mutating the input', () => {
  const input = { exposure: Infinity, saturation: -3, contrast: 30, shadowSize: 12, fog: 'true' }
  const result = normalizeOptions(input)
  assert.equal(result.exposure, 1.6)
  assert.equal(result.saturation, 0)
  assert.equal(result.contrast, 3)
  assert.equal(result.shadowSize, 4096)
  assert.equal(input.saturation, -3)
  assert.equal(result.shadowMode, 'custom')
})

test('disable restores native values and destroy preserves unrelated stages', () => {
  const f = fixture()
  const foreign = { name: 'silhouette' }
  f.stages.add(foreign)
  const light = f.viewer.scene.light
  const pipeline = new VisualPipeline(f)
  pipeline.setEnabled(false)
  assert.equal(f.viewer.scene.light, light)
  assert.equal(f.viewer.resolutionScale, 0.75)
  assert.equal(f.stages.exposure, 2)
  pipeline.setEnabled(true)
  pipeline.destroy()
  pipeline.destroy()
  assert.deepEqual(f.owned, [foreign])
  assert.equal(getVisualPipeline(f.viewer), undefined)
})

test('nested tool suspension resumes only after all tools release ownership', () => {
  const f = fixture()
  const pipeline = new VisualPipeline(f)
  pipeline.suspend('weather')
  pipeline.suspend('sun')
  pipeline.setOptions({ exposure: 0.8 })
  pipeline.resume('sun')
  assert.equal(f.stages.exposure, 2)
  pipeline.resume('weather')
  assert.equal(f.stages.exposure, 0.8)
  pipeline.destroy()
})

test('cleanup does not overwrite a later external property change', () => {
  const f = fixture()
  const pipeline = new VisualPipeline(f)
  const external = {}
  f.viewer.scene.light = external
  pipeline.destroy()
  assert.equal(f.viewer.scene.light, external)
})

test('ten create/destroy cycles return the collection to its baseline', () => {
  const f = fixture()
  for (let i = 0; i < 10; i++) new VisualPipeline(f).destroy()
  assert.equal(f.owned.length, 0)
  assert.equal(f.stages.ambientOcclusion.enabled, false)
})

test('wrong runtime version fails before modifying the scene', () => {
  const f = fixture()
  f.Cesium.VERSION = '1.118'
  assert.throws(() => new VisualPipeline(f), /1.143/)
  assert.equal(f.owned.length, 0)
})

test('version-specific shadow bias is restored when the module is disabled', () => {
  const f = fixture()
  f.viewer.shadowMap._primitiveBias = { depthBias: 0.00002, normalOffsetScale: 0.1 }
  const pipeline = new VisualPipeline(f)
  assert.equal(f.viewer.shadowMap._primitiveBias.depthBias, 0.0002)
  pipeline.setEnabled(false)
  assert.deepEqual(f.viewer.shadowMap._primitiveBias, { depthBias: 0.00002, normalOffsetScale: 0.1 })
  pipeline.destroy()
})

test('failed initialization rolls back its stages and registry entry', () => {
  const f = fixture()
  const light = f.viewer.scene.light
  f.Cesium.PostProcessStageLibrary.isAmbientOcclusionSupported = () => { throw new Error('capability failure') }
  assert.throws(() => new VisualPipeline({ ...f, options: { shadowMode: 'native', environment: false, ambientOcclusion: true } }), /capability failure/)
  assert.equal(f.owned.length, 0)
  assert.equal(getVisualPipeline(f.viewer), undefined)
  assert.equal(f.viewer.scene.light, light)
})

test('explicit native comparison maps the custom single-cascade default to a supported single cascade', () => {
  const f = fixture()
  const original = f.viewer.shadowMap
  const pipeline = new VisualPipeline(f)
  const owned = f.viewer.shadowMap
  assert.notEqual(owned, original)
  assert.equal(owned.numberOfCascades, 1)
  assert.equal(owned.size, 4096)
  assert.equal(original.size, 1024)
  pipeline.suspend('sun-analysis')
  assert.equal(f.viewer.shadowMap, original)
  pipeline.resume('sun-analysis')
  assert.equal(f.viewer.shadowMap, owned)
  pipeline.destroy()
  assert.equal(f.viewer.shadowMap, original)
  assert.equal(owned.isDestroyed(), true)
})

test('changing cascade count releases the old map and preserves native fallback', () => {
  const f = fixture()
  const original = f.viewer.shadowMap
  const pipeline = new VisualPipeline(f)
  const first = f.viewer.shadowMap
  pipeline.setOptions({ shadowCascades: 4 })
  assert.equal(first.isDestroyed(), true)
  assert.equal(f.viewer.shadowMap.numberOfCascades, 4)
  pipeline.setEnabled(false)
  assert.equal(f.viewer.shadowMap, original)
  pipeline.destroy()
})

test('cleanup leaves an externally replaced shadow map and its enabled flag alone', () => {
  const f = fixture()
  const pipeline = new VisualPipeline(f)
  const owned = f.viewer.shadowMap
  const external = { enabled: true }
  f.viewer.scene.shadowMap = external
  pipeline.destroy()
  assert.equal(f.viewer.shadowMap, external)
  assert.deepEqual(external, { enabled: true })
  assert.equal(owned.isDestroyed(), true)
})

test('default daylight uses native exposure and keeps noisy AO disabled', () => {
  const f = fixture()
  const pipeline = new VisualPipeline(f)
  assert.equal(f.stages.exposure, 1.6)
  assert.equal(f.stages.ambientOcclusion.enabled, false)
  assert.equal(f.viewer.shadows, true)
  pipeline.destroy()
  assert.equal(f.stages.exposure, 2)
})

test('automatically saved previous defaults upgrade to the brighter preset', () => {
  const previous = { contrast: 1.05, brightness: 1, exposure: 1, saturation: 0.95, hue: 0 }
  const next = resolveSavedFilters(previous)
  assert.equal(next.exposure, 1.6)
  assert.equal(next.contrast, defaultFilters.contrast)
  assert.equal(previous.exposure, 1)
})

test('user-adjusted filters are retained and invalid cache data is sanitized', () => {
  const custom = { contrast: 1.1, brightness: 0.9, exposure: 1.2, saturation: 0.8, hue: 0.1 }
  assert.deepEqual(resolveSavedFilters(custom), custom)
  assert.equal(resolveSavedFilters(null).exposure, 1.6)
  assert.equal(resolveSavedFilters({ exposure: NaN, brightness: 100 }).brightness, 3)
})

test('preview loads the configured map image and surrounding white model outside campus readiness', () => {
  const preview = readFileSync(new URL('./preview.html', import.meta.url), 'utf8')
  assert.match(preview, /get\('imagery'\)/)
  assert.match(preview, /get\('contextTiles'\)/)
  assert.match(preview, /if \(previewImageryUrl\) viewer.imageryLayers.add/)
  assert.match(preview, /if \(previewWhiteModelUrl\) Cesium.Cesium3DTileset.fromUrl/)
  assert.match(preview, /const contextTiles = \[\]/)
  assert.match(preview, /contextTiles\.push\(whiteModel\)/)
  assert.doesNotMatch(preview, /tiles\.push\(whiteModel\)/)
})
