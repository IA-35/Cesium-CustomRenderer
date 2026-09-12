import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import ScreenSpaceAo143 from '../../src/ao/ScreenSpaceAo143.js'
const C = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')

function fixture() {
  const native = new C.PostProcessStageCollection()
  native.ambientOcclusion.enabled = false
  const scene = { context: { webgl2: true, depthTexture: true, floatingPointTexture: true, colorBufferFloat: true,
    _gl: { isContextLost: () => false } },
    mode: C.SceneMode.SCENE3D, camera: { frustum: new C.PerspectiveFrustum() }, highDynamicRange: true,
    frameState: { frameNumber: 1 }, _view: { frustumCommandsList: [{ indices: {} }] },
    postProcessStages: native, requestRender() {}, isDestroyed: () => false }
  const source = { getTextures: () => ({ transparency: {} }), getDepthPyramidLevels: () => [{}] }
  return { scene, native, source, ao: new ScreenSpaceAo143(C, scene, () => source, () => ({})) }
}

test('AO defaults to no stage resources; enabling owns four stages and releasing restores HDR hook', () => {
  const { ao, native } = fixture(), execute = native.execute
  assert.equal(ao.collection, undefined)
  ao.setEnabled(true)
  assert.notEqual(native.execute, execute)
  assert.equal(ao.composite.length, 4)
  assert.equal(ao.stages.raw.textureScale, .5)
  assert.equal(ao.stages.resolve.pixelDatatype, C.PixelDatatype.FLOAT)
  assert.equal(ao.composite.inputPreviousStageTexture, false)
  assert.equal(ao.stages.horizontal.uniforms.u_visibility, ao.stages.raw.name)
  assert.equal(ao.stages.vertical.uniforms.u_visibility, ao.stages.horizontal.name)
  const collection = ao.collection
  ao.destroy(); ao.destroy()
  assert.equal(collection.isDestroyed(), true)
  assert.equal(native.execute, execute)
  native.destroy()
})

test('AO requires current transparency coverage and accepts transparent commands when covered', () => {
  const { ao, scene, source, native } = fixture()
  ao.setEnabled(true)
  assert.equal(ao._scopeReason(), null)
  source.getDepthPyramidLevels = () => null
  assert.match(ao._scopeReason(), /depth|Hi-Z/i)
  source.getDepthPyramidLevels = () => [{}]
  scene._view.frustumCommandsList[0].indices[C.Pass.TRANSLUCENT] = 1
  assert.equal(ao._scopeReason(), null)
  source.getTextures = () => ({})
  assert.match(ao._scopeReason(), /transparen/i)
  source.getTextures = () => ({ transparency: {} })
  scene._view.frustumCommandsList[0].indices[C.Pass.TRANSLUCENT] = 0
  native.ambientOcclusion.enabled = true
  assert.match(ao._scopeReason(), /native AO/i)
  native.ambientOcclusion.enabled = false
  scene.camera.frustum = new C.PerspectiveOffCenterFrustum()
  assert.match(ao._scopeReason(), /symmetric perspective/i)
  ao.destroy(); native.destroy()
})

test('unsupported AO cannot allocate resources or install a hook', () => {
  const scene = { context: { webgl2: false }, postProcessStages: {}, requestRender() {}, isDestroyed: () => false }
  const ao = new ScreenSpaceAo143(C, scene, () => null, () => ({}))
  ao.setEnabled(true)
  assert.equal(ao.getDiagnostics().supported, false)
  assert.equal(ao.collection, undefined)
  ao.destroy()
})

test('incomplete AO framebuffer fails closed, restores bindings and only retries after off-on', () => {
  const { ao, scene, source, native } = fixture()
  scene.camera.frustum = new C.PerspectiveFrustum({ fov: Math.PI / 3, aspectRatio: 1, near: 1, far: 1000 })
  scene.context.uniformState = { viewport: new C.BoundingRectangle(0, 0, 64, 64) }
  const bindings = []
  Object.assign(scene.context._gl, { FRAMEBUFFER_COMPLETE: 1, READ_FRAMEBUFFER_BINDING: 2, DRAW_FRAMEBUFFER_BINDING: 3,
    READ_FRAMEBUFFER: 4, DRAW_FRAMEBUFFER: 5, getParameter: value => value, bindFramebuffer: (...args) => bindings.push(args) })
  const previous = native.execute, input = { width: 64, height: 64 }
  source.getDepthPyramidLevels = () => [{ texture: {} }]
  ao.setEnabled(true)
  const collection = ao.collection
  Object.defineProperty(collection, 'ready', { get: () => true })
  Object.defineProperty(ao.composite, 'ready', { get: () => true })
  collection.update = () => {}; collection.clear = () => {}
  collection.execute = () => assert.fail('must reject incomplete framebuffer before drawing')
  const fakeFramebuffer = { status: 9 }
  for (const stage of Object.values(ao.stages)) stage._textureCache.getFramebuffer = () => fakeFramebuffer
  assert.equal(ao._execute(scene.context, input), input)
  assert.match(ao.error, /incomplete/i)
  assert.equal(ao.failed, true)
  assert.equal(collection.isDestroyed(), true)
  assert.equal(native.execute, previous)
  assert.deepEqual(bindings.slice(-2), [[4, 2], [5, 3]])
  ao.setEnabled(true)
  assert.equal(ao.collection, undefined)
  ao.setEnabled(false); ao.setEnabled(true)
  assert.ok(ao.collection)
  ao.destroy(); native.destroy()
})
