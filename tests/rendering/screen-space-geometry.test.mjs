import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import ScreenSpaceGeometry143 from '../../src/channels/ScreenSpaceGeometry143.js'

const C = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')

function fixture(capabilities = {}) {
  const scene = {
    context: { depthTexture: true, floatingPointTexture: true, colorBufferFloat: true, ...capabilities },
    mode: C.SceneMode.SCENE3D,
    _view: { frustumCommandsList: [{}] },
    drawingBufferWidth: 1920,
    drawingBufferHeight: 1080,
    postProcessStages: new C.PostProcessStageCollection(),
    renderRequests: 0,
    requestRender() { this.renderRequests++ },
    isDestroyed() { return false }
  }
  return { scene, channel: new ScreenSpaceGeometry143(C, scene) }
}

test('geometry channel starts disabled with full resolution float data and original-color composite', () => {
  const { scene, channel } = fixture()
  assert.equal(channel.getDiagnostics().enabled, false)
  assert.equal(channel.composite.enabled, false)
  assert.equal(channel.geometryStage.pixelDatatype, C.PixelDatatype.FLOAT)
  assert.equal(channel.geometryStage.pixelFormat, C.PixelFormat.RGBA)
  assert.equal(channel.geometryStage.textureScale, 1)
  assert.equal(channel.composite.inputPreviousStageTexture, false)
  const output = channel.composite.get(1)
  assert.equal(output.pixelDatatype, C.PixelDatatype.UNSIGNED_BYTE)
  assert.equal(output.uniforms.geometryTexture, channel.geometryStage.name)
  assert.equal(output.uniforms.debugMode(), 0)
  assert.equal(scene.postProcessStages.contains(channel.composite), true)
  channel.destroy()
  scene.postProcessStages.destroy()
})

test('Cesium ShaderSource injects eye reconstruction definitions for ordinary and logarithmic depth', () => {
  const { scene, channel } = fixture()
  for (const defines of [[], ['LOG_DEPTH']]) {
    const source = new C.ShaderSource({ defines, sources: [channel.geometryStage.fragmentShader] })
    const combined = source.createCombinedFragmentShader({ webgl2: true })
    assert.match(combined, /vec4 czm_screenToEyeCoordinates\(vec2 screenCoordinateXY, float depthOrLogDepth\)/)
    assert.match(combined, /vec4 czm_windowToEyeCoordinates\(vec2 fragmentCoordinateXY, float depthOrLogDepth\)/)
  }
  channel.destroy()
  scene.postProcessStages.destroy()
})

for (const capability of ['depthTexture', 'floatingPointTexture', 'colorBufferFloat']) {
  test(`missing ${capability} creates no stage resources or scene mutations`, () => {
    const scene = { context: { depthTexture: true, floatingPointTexture: true, colorBufferFloat: true,
      [capability]: false }, requestRender() { assert.fail('unsupported scene must be untouched') } }
    const engine = { ...C, PostProcessStage: class { constructor() { assert.fail('must gate before resources') } } }
    const channel = new ScreenSpaceGeometry143(engine, scene)
    channel.setEnabled(true)
    assert.equal(channel.getDiagnostics().supported, false)
    assert.equal(channel.getDiagnostics().enabled, false)
    assert.match(channel.getDiagnostics().reason, new RegExp(capability))
    assert.equal(channel.geometryStage, undefined)
    channel.destroy()
    channel.destroy()
    assert.equal(channel.isDestroyed(), true)
  })
}

test('version mismatch fails before touching the scene', () => {
  assert.throws(() => new ScreenSpaceGeometry143({ VERSION: '1.142' }, {}), /1\.143/)
})

test('two channels own distinct stage names and destroying one retains the other and foreign stages', () => {
  const { scene, channel: first } = fixture()
  const second = new ScreenSpaceGeometry143(C, scene)
  const foreign = scene.postProcessStages.add(new C.PostProcessStage({
    name: 'foreign', fragmentShader: 'void main() { out_FragColor = vec4(1.0); }'
  }))
  const names = [first, second].flatMap(channel => [channel.composite.name,
    channel.geometryStage.name, channel.composite.get(1).name])
  assert.equal(new Set(names).size, 6)
  first.destroy()
  first.destroy()
  assert.equal(scene.postProcessStages.contains(first.composite), false)
  assert.equal(scene.postProcessStages.contains(second.composite), true)
  assert.equal(scene.postProcessStages.contains(foreign), true)
  assert.equal(first.geometryStage.isDestroyed(), true)
  second.destroy()
  scene.postProcessStages.destroy()
})

test('scope uniforms evaluate current 3D single-frustum state without retaining previous validity', () => {
  const { scene, channel } = fixture()
  const scope = channel.geometryStage.uniforms.scopeValid
  channel.setEnabled(true)
  assert.equal(scope(), true)
  assert.equal(channel.getDiagnostics().valid, true)
  scene._view.frustumCommandsList.push({})
  assert.equal(scope(), false)
  assert.equal(channel.getDiagnostics().valid, false)
  assert.equal(channel.getDiagnostics().frustumCount, 2)
  scene._view.frustumCommandsList.pop()
  scene.mode = C.SceneMode.SCENE2D
  assert.equal(scope(), false)
  scene.mode = C.SceneMode.SCENE3D
  assert.equal(scope(), true)
  channel.setEnabled(false)
  assert.equal(scope(), false)
  assert.equal(channel.composite.enabled, false)
  assert.equal(channel.geometryStage.enabled, false)
  channel.destroy()
  scene.postProcessStages.destroy()
})

test('debug modes change uniforms and request a frame without enabling the channel', () => {
  const { scene, channel } = fixture()
  const mode = channel.composite.get(1).uniforms.debugMode
  channel.setDebugMode('normal')
  assert.equal(mode(), 1)
  channel.setDebugMode('depth')
  assert.equal(mode(), 2)
  channel.setDebugMode('invalid')
  assert.equal(mode(), 2)
  channel.setDebugMode('off')
  assert.equal(mode(), 0)
  assert.equal(channel.getDiagnostics().enabled, false)
  assert.ok(scene.renderRequests >= 3)
  channel.destroy()
  scene.postProcessStages.destroy()
})

test('diagnostics report actual allocated dimensions separately from drawing buffer estimates', () => {
  const { scene, channel } = fixture()
  channel.setEnabled(true)
  const before = channel.getDiagnostics()
  assert.equal(before.estimatedBytes, 1920 * 1080 * 20)
  assert.equal(before.allocatedBytes, 0)
  assert.equal(before.geometryTexture, null)
  scene.drawingBufferWidth = 800
  scene.drawingBufferHeight = 600
  assert.equal(channel.getDiagnostics().estimatedBytes, 800 * 600 * 20)
  channel.destroy()
  assert.equal(channel.getDiagnostics().valid, false)
  assert.equal(channel.getDiagnostics().allocatedBytes, 0)
  scene.postProcessStages.destroy()
})

test('diagnostics do not attribute shared cache textures to disabled or unready stages', () => {
  const { scene, channel } = fixture()
  const cache = channel.outputStage._textureCache
  const original = cache.getFramebuffer
  const sharedTexture = { width: 800, height: 600, isDestroyed: () => false }
  cache.getFramebuffer = name => name === channel.outputStage.name
    ? { getColorTexture: () => sharedTexture } : undefined
  try {
    channel.outputStage._ready = true
    assert.equal(channel.getDiagnostics().outputTexture, null)
    assert.equal(channel.getDiagnostics().allocatedBytes, 0)
    channel.setEnabled(true)
    channel.outputStage._ready = false
    assert.equal(channel.getDiagnostics().outputTexture, null)
    channel.outputStage._ready = true
    assert.equal(channel.getDiagnostics().allocatedBytes, 800 * 600 * 4)
    channel.setEnabled(false)
    assert.equal(channel.getDiagnostics().outputTexture, null)
    assert.equal(channel.getDiagnostics().allocatedBytes, 0)
  } finally {
    cache.getFramebuffer = original
    channel.destroy()
    scene.postProcessStages.destroy()
  }
})

test('destroy after viewer teardown avoids destroyed scene and collection methods', () => {
  const { scene, channel } = fixture()
  scene.postProcessStages.destroy()
  scene.isDestroyed = () => true
  scene.requestRender = () => assert.fail('scene was destroyed')
  channel.destroy()
  channel.setEnabled(true)
  channel.setDebugMode('normal')
  assert.equal(channel.isDestroyed(), true)
  assert.equal(channel.getDiagnostics().valid, false)
})
