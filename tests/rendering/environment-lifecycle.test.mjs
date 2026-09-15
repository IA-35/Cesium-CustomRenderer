import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import EnvironmentRenderer from '../../src/environment/EnvironmentRenderer.js'
import { normalizeOptions } from '../../src/presets.js'

const Cesium = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')

test('surface depth borrows only the current visible globe copy and never keeps a stale texture', () => {
  const renderer = Object.create(EnvironmentRenderer.prototype)
  const first = { isDestroyed: () => false, destroy: () => assert.fail('borrowed texture') }
  const second = { isDestroyed: () => false, destroy: () => assert.fail('borrowed texture') }
  const scene = renderer.scene = { globe: { show: true }, context: { uniformState: { globeDepthTexture: first } } }
  assert.equal(renderer.surfaceDepth(), first)
  scene.context.uniformState.globeDepthTexture = second
  assert.equal(renderer.surfaceDepth(), second)
  scene.globe.show = false
  assert.equal(renderer.surfaceDepth(), undefined)
  scene.globe.show = true
  second.isDestroyed = () => true
  assert.equal(renderer.surfaceDepth(), undefined)
  scene.context.uniformState.globeDepthTexture = undefined
  assert.equal(renderer.surfaceDepth(), undefined)
  scene.globe = undefined
  assert.equal(renderer.surfaceDepth(), undefined)
})

test('renderer retries a failed HDR allocation only after an explicit off-to-on transition', () => {
  let attempts = 0
  // GPU allocation is simulated and remote ICRF data is unavailable; renderer, adapter, stages,
  // lighting and event subscription are the shipped runtime implementations.
  class Texture {
    constructor() { if (++attempts === 1) throw new Error('temporary texture allocation failure') }
    isDestroyed() { return !!this.destroyed }
    destroy() { this.destroyed = true }
  }
  const C = { ...Cesium, Texture,
    Transforms: { ...Cesium.Transforms, computeIcrfToFixedMatrix: () => undefined } }
  const native = new C.PostProcessStageCollection()
  const execute = native.execute
  const preUpdate = new C.Event()
  const scene = { context: { depthTexture: true, floatingPointTexture: true, colorBufferFloat: true },
    light: new C.SunLight(), globe: {}, fog: { renderable: true }, atmosphere: new C.Atmosphere(),
    primitives: new C.PrimitiveCollection(), postProcessStages: native, preUpdate,
    mode: C.SceneMode.SCENE3D, highDynamicRange: true, _view: { frustumCommandsList: [{}] },
    isDestroyed: () => false, requestRender() {} }
  const viewer = { scene, clock: { currentTime: C.JulianDate.fromIso8601('2026-09-08T03:00:00Z') }, isDestroyed: () => false }
  const renderer = new EnvironmentRenderer(C, viewer, () => normalizeOptions({ cloudGeometry: "local" }), () => null)
  try {
    renderer.setOrigin(C.Cartesian3.fromDegrees(123.42, 41.77))
    renderer.setEnabled(true)
    assert.equal(attempts, 1)
    assert.match(renderer.hdr.error, /temporary texture allocation failure/)
    assert.equal(renderer.hdr.enabled, false)
    assert.equal(native.execute, execute)
    for (let i = 0; i < 4; i++) preUpdate.raiseEvent()
    renderer.setEnabled(true)
    assert.equal(attempts, 1, 'updates and repeated enable must not retry')
    renderer.setEnabled(false)
    renderer.setEnabled(true)
    assert.equal(attempts, 2, 'explicit off/on must retry once')
    assert.equal(renderer.hdr.error, null)
    assert.equal(renderer.hdr.enabled, true)
    assert.equal(scene.fog.renderable, false, 'active volume replaces native fog')
    assert.notEqual(native.execute, execute)
    assert.ok(renderer.stages.raymarchStage instanceof C.PostProcessStage)
    for (let i = 0; i < 4; i++) preUpdate.raiseEvent()
    assert.equal(attempts, 2)
    viewer.camera = { positionWC: C.Cartesian3.fromDegrees(126, 41.77, 100) }
    renderer.update()
    assert.equal(renderer.hdr.enabled, false)
    assert.equal(scene.fog.renderable, true, 'regional fallback restores native aerial fog')
    viewer.camera.positionWC = C.Cartesian3.fromDegrees(123.42, 41.77, 100)
    renderer.update()
    assert.equal(renderer.hdr.enabled, true)
    assert.equal(scene.fog.renderable, false)
    scene.fog.renderable = true
    renderer.update()
    assert.equal(scene.fog.renderable, true, 'external fog ownership must be retained')
    const texture = renderer.noise
    renderer.destroy()
    assert.equal(texture.isDestroyed(), true)
    assert.equal(native.execute, execute)
    assert.equal(preUpdate.numberOfListeners, 0)
    assert.equal(scene.fog.renderable, true)
  } finally {
    renderer.destroy()
    native.destroy()
    scene.primitives.destroy()
  }
})
