import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import HdrEnvironmentPass143 from '../../src/environment/HdrEnvironmentPass143.js'

const Cesium = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')

test('orthographic views bypass perspective-only volume rays', () => {
  const f = fixture({ camera: { frustum: new Cesium.OrthographicFrustum({ width: 200, aspectRatio: 1, near: 1, far: 1000 }) } })
  f.C.OrthographicFrustum = Cesium.OrthographicFrustum
  f.pass.setEnabled(true)
  const original = { linearValue: 4 }
  f.execute(original)
  assert.equal(f.events.find(e => e[0] === 'native')[2], original)
  assert.match(f.pass.getDiagnostics().reason, /perspective/)
  f.pass.destroy()
})

function fixture(overrides = {}) {
  const events = []
  let created = 0
  const context = { depthTexture: true, floatingPointTexture: true, colorBufferFloat: true,
    uniformState: { viewport: { x: 0, y: 0, width: 800, height: 600 } } }
  class Collection {
    constructor() {
      created++
      this.fxaa = { enabled: true }
      this.ambientOcclusion = { enabled: true }
      this.bloom = { enabled: true }
      this.ready = true
      this.outputTexture = { linearValue: 8 }
    }
    add(composite) { this.composite = composite }
    update(...args) { events.push(['update', ...args]); if (this.fail) throw new Error('own GPU failure') }
    clear(c) { events.push(['clear', c]) }
    execute(...args) {
      events.push(['environment', ...args])
      context.uniformState.viewport.width = 400
      context.uniformState.viewport.height = 300
    }
    destroy() { this.destroyed = true; events.push(['destroy']) }
    isDestroyed() { return !!this.destroyed }
  }
  const C = { VERSION: '1.143', SceneMode: { SCENE3D: 3 }, PostProcessStageCollection: Collection }
  const native = { execute(c, color, depth, id) {
    events.push(['native', c, color, depth, id, this, { ...c.uniformState.viewport }])
    return 'native result'
  } }
  const originalExecute = native.execute
  const scene = { context, mode: 3, highDynamicRange: true, frameState: { useLogDepth: true },
    _view: { frustumCommandsList: [{}] }, postProcessStages: native,
    isDestroyed: () => false, requestRender() {}, ...overrides }
  const composites = []
  const pass = new HdrEnvironmentPass143(C, scene, () => {
    const composite = { ready: true }
    composites.push(composite)
    return composite
  })
  return { pass, scene, native, originalExecute, context, events, C, composites,
    created: () => created,
    execute: (color = { linearValue: 4 }) => native.execute(context, color, 'depth', 'id') }
}

test('disabled construction allocates nothing; enabled pass composites linear HDR before native tonemap', () => {
  const f = fixture()
  assert.equal(f.created(), 0)
  assert.equal(f.native.execute, f.originalExecute)
  assert.equal(f.pass.getDiagnostics().enabled, false)
  f.pass.setEnabled(true)
  for (const key of ['fxaa', 'ambientOcclusion', 'bloom']) assert.equal(f.pass.collection[key].enabled, false)
  const original = { linearValue: 4 }
  assert.equal(f.execute(original), 'native result')
  assert.deepEqual(f.events.map(e => e[0]), ['update', 'clear', 'environment', 'native'])
  assert.deepEqual(f.events[0].slice(1), [f.context, true, false])
  assert.equal(f.events[2][2], original)
  assert.equal(f.pass.inputColor, original)
  assert.equal(f.events[3][2], f.pass.collection.outputTexture)
  assert.equal(f.events[3][2].linearValue, 8)
  assert.equal(f.events[3][5], f.native)
  assert.deepEqual(f.events[3][6], { x: 0, y: 0, width: 800, height: 600 })
  assert.equal(f.pass.getDiagnostics().valid, true)
  f.pass.destroy()
})

test('not-ready composite or collection bypasses original HDR without invoking environment', () => {
  for (const owner of ['composite', 'collection']) {
    const f = fixture()
    f.pass.setEnabled(true)
    f.pass[owner].ready = false
    const color = { linearValue: 7 }
    f.execute(color)
    assert.equal(f.events.some(e => e[0] === 'environment'), false)
    assert.equal(f.events.at(-1)[2], color)
    assert.match(f.pass.getDiagnostics().reason, /ready/)
    f.pass.destroy()
  }
})

test('HDR, 3D and single-frustum requirements bypass incomplete scene depth', () => {
  for (const mutate of [f => { f.scene.highDynamicRange = false }, f => { f.scene.mode = 2 },
    f => { f.scene._view.frustumCommandsList.push({}) }]) {
    const f = fixture()
    f.pass.setEnabled(true)
    mutate(f)
    const color = { linearValue: 5 }
    f.execute(color)
    assert.deepEqual(f.events.map(e => e[0]), ['native'])
    assert.equal(f.events[0][2], color)
    assert.equal(f.pass.getDiagnostics().valid, false)
    assert.ok(f.pass.getDiagnostics().reason)
    f.pass.destroy()
  }
})

test('unsupported version or float/depth capability fails closed before allocation', () => {
  for (const capability of ['depthTexture', 'floatingPointTexture', 'colorBufferFloat']) {
    const f = fixture()
    f.context[capability] = false
    f.pass.setEnabled(true)
    assert.equal(f.created(), 0)
    assert.equal(f.native.execute, f.originalExecute)
    assert.match(f.pass.getDiagnostics().reason, new RegExp(capability))
    f.pass.destroy()
  }
  assert.throws(() => new HdrEnvironmentPass143({ VERSION: '1.142' }, {}, () => {}), /1\.143/)
})

test('underground and translucent globe preserve native HDR and recover above opaque ground', () => {
  for (const key of ['cameraUnderground', 'translucent']) {
    const f = fixture({ _globeTranslucencyState: { translucent: false } })
    f.pass.setEnabled(true)
    const owner = key === 'cameraUnderground' ? f.scene : f.scene._globeTranslucencyState
    owner[key] = true
    const color = { linearValue: 5 }
    f.execute(color)
    assert.deepEqual(f.events.map(e => e[0]), ['native'])
    assert.equal(f.events[0][2], color)
    assert.equal(f.pass.getDiagnostics().valid, false)
    assert.match(f.pass.getDiagnostics().reason, /underground|translucent/)
    owner[key] = false
    f.events.length = 0
    f.execute(color)
    assert.equal(f.pass.getDiagnostics().valid, true)
    assert.equal(f.events.at(-1)[2], f.pass.collection.outputTexture)
    assert.equal(f.created(), 1)
    f.pass.destroy()
  }
})

test('own failure closes pipeline, restores viewport, preserves HDR and allows explicit retry', () => {
  const f = fixture()
  f.pass.setEnabled(true)
  const collection = f.pass.collection
  collection.execute = () => {
    f.context.uniformState.viewport.width = 100
    throw new Error('own GPU failure')
  }
  const color = { linearValue: 6 }
  assert.equal(f.execute(color), 'native result')
  assert.equal(f.events.at(-1)[2], color)
  assert.equal(f.events.at(-1)[6].width, 800)
  assert.equal(collection.destroyed, true)
  assert.equal(f.native.execute, f.originalExecute)
  assert.equal(f.pass.getDiagnostics().enabled, false)
  assert.match(f.pass.getDiagnostics().error, /own GPU failure/)
  f.pass.setEnabled(true)
  assert.equal(f.created(), 2)
  f.pass.destroy()
})

test('native errors propagate without being mislabeled as environment errors', () => {
  const f = fixture()
  f.native.execute = () => { throw new Error('native failure') }
  f.pass.setEnabled(true)
  assert.throws(() => f.execute(), /native failure/)
  assert.equal(f.pass.getDiagnostics().enabled, true)
  assert.equal(f.pass.getDiagnostics().error, null)
  f.pass.destroy()
})

test('disable releases resources; old wrapper token stays inert after reenable under foreign wrapper', () => {
  const f = fixture()
  f.pass.setEnabled(true)
  const oldHook = f.native.execute
  const firstCollection = f.pass.collection
  const foreign = function(...args) { f.events.push(['foreign']); return oldHook.apply(this, args) }
  f.native.execute = foreign
  f.pass.setEnabled(false)
  assert.equal(f.native.execute, foreign)
  assert.equal(firstCollection.destroyed, true)
  assert.equal(f.pass.collection, undefined)
  f.pass.setEnabled(true)
  f.events.length = 0
  f.execute()
  assert.deepEqual(f.events.map(e => e[0]), ['update', 'clear', 'environment', 'foreign', 'native'])
  assert.equal(f.composites.length, 2)
  f.pass.destroy()
  assert.equal(f.native.execute, foreign)
  f.events.length = 0
  f.execute()
  assert.deepEqual(f.events.map(e => e[0]), ['foreign', 'native'])
})

test('destroy is safe after viewer teardown, idempotent and never reenables', () => {
  const f = fixture()
  f.pass.setEnabled(true)
  const collection = f.pass.collection
  f.scene.isDestroyed = () => true
  f.scene.requestRender = () => assert.fail('cannot request destroyed scene')
  f.pass.destroy()
  f.pass.destroy()
  f.pass.setEnabled(true)
  assert.equal(collection.destroyed, true)
  assert.equal(f.pass.isDestroyed(), true)
  assert.equal(f.pass.getDiagnostics().valid, false)
  assert.equal(f.created(), 1)
})

test('each frame updates allocation and takes current output after resize and readiness recovery', () => {
  const f = fixture()
  f.pass.setEnabled(true)
  f.pass.composite.ready = false
  f.execute()
  assert.equal(f.pass.getDiagnostics().valid, false)
  f.pass.composite.ready = true
  f.context.uniformState.viewport = { x: 0, y: 0, width: 1200, height: 900 }
  f.pass.collection.outputTexture = { width: 1200, height: 900, linearValue: 12 }
  f.execute()
  assert.equal(f.events.filter(e => e[0] === 'update').length, 2)
  assert.equal(f.events.at(-1)[2], f.pass.collection.outputTexture)
  assert.equal(f.events.at(-1)[6].width, 1200)
  assert.equal(f.pass.getDiagnostics().valid, true)
  f.pass.collection.outputTexture = undefined
  const color = { linearValue: 20 }
  f.execute(color)
  assert.equal(f.events.at(-1)[2], color)
  assert.equal(f.pass.getDiagnostics().valid, false)
  f.pass.destroy()
})

test('real Cesium collection owns float composite without adding anything to native stages', () => {
  const f = fixture()
  const native = new Cesium.PostProcessStageCollection()
  f.scene.postProcessStages = native
  let stage
  const pass = new HdrEnvironmentPass143(Cesium, f.scene, () => {
    stage = new Cesium.PostProcessStage({ name: 'hdr_environment_test',
      pixelFormat: Cesium.PixelFormat.RGBA, pixelDatatype: Cesium.PixelDatatype.FLOAT,
      fragmentShader: 'void main() { out_FragColor = vec4(4.0); }' })
    return new Cesium.PostProcessStageComposite({ stages: [stage] })
  })
  pass.setEnabled(true)
  assert.equal(native.length, 0)
  assert.equal(pass.collection.length, 1)
  assert.equal(pass.collection.contains(pass.composite), true)
  assert.equal(pass.collection._autoExposureEnabled, false)
  assert.equal(pass.collection._tonemapping.enabled, false)
  pass.setEnabled(false)
  assert.equal(stage.isDestroyed(), true)
  pass.destroy()
  native.destroy()
})

test('shell permits an empty sky frame but still rejects multiple depth frusta', () => {
  const f = fixture()
  f.pass.allowEmptyFrustum = () => true
  f.scene._view.frustumCommandsList = []
  assert.equal(f.pass._scopeReason(), null)
  f.scene._view.frustumCommandsList = [{}, {}]
  assert.match(f.pass._scopeReason(), /single frustum/)
  f.scene._view.frustumCommandsList = []
  f.pass.allowEmptyFrustum = () => false
  assert.match(f.pass._scopeReason(), /single frustum/)
})
