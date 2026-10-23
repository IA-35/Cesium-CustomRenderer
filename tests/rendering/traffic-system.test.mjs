import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import TrafficSystem from '../../src/traffic/TrafficSystem.js'
const C = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')
const routes = { type: 'FeatureCollection', features: [{ type: 'Feature', id: 'loop', properties: {},
  geometry: { type: 'LineString', coordinates: [[123, 41, 10], [123.001, 41, 10], [123.001, 41.001, 10], [123, 41, 10]] } }] }
const vehicles = [{ id: 'car', routeId: 'loop', url: 'https://example.test/car.glb', speed: 10, offset: 0 }]
function setup(load) {
  let milliseconds = 0, invalidations = 0
  const invalidationArgs = []
  const models = [], members = new Set(), preUpdate = new C.Event(), postRender = new C.Event()
  const clock = { shouldAnimate: false, multiplier: 10, currentTime: C.JulianDate.now() }
  const scene = { preUpdate, postRender, requestRender() {}, isDestroyed: () => false,
    primitives: { add(model) { members.add(model); return model }, remove(model) {
      if (!members.delete(model)) return false
      model.destroy(); return true
    } } }
  const makeModel = () => { let destroyed = false; const model = { ready: true, readyEvent: new C.Event(), errorEvent: new C.Event(),
    modelMatrix: C.Matrix4.clone(C.Matrix4.IDENTITY), destroy() { assert.equal(destroyed, false); destroyed = true },
    isDestroyed: () => destroyed }; models.push(model); return model }
  const engine = { ...C, Model: { fromGltfAsync: load || (async () => makeModel()) } }
  const viewer = { scene, clock, isDestroyed: () => false }
  return { engine, viewer, models, members, makeModel, invalidationArgs,
    options: { Cesium: engine, viewer, routes, vehicles, now: () => milliseconds,
      pipeline: { invalidateShadows(...args) { invalidations++; invalidationArgs.push(args) } } },
    tick(ms) { milliseconds += ms; preUpdate.raiseEvent(scene, clock.currentTime) },
    get invalidations() { return invalidations } }
}
test('vehicles move at metres per second without changing a frozen scene clock', async () => {
  const fixture = setup(), clock = JSON.stringify(fixture.viewer.clock)
  const traffic = new TrafficSystem(fixture.options)
  await traffic.readyPromise
  const matrix = fixture.models[0].modelMatrix, start = C.Matrix4.getTranslation(matrix, new C.Cartesian3())
  fixture.tick(1000)
  const end = C.Matrix4.getTranslation(matrix, new C.Cartesian3())
  assert.ok(Math.abs(C.Cartesian3.distance(start, end) - 10) < 1e-6)
  assert.equal(fixture.models[0].modelMatrix, matrix, 'reuse the model matrix')
  assert.equal(JSON.stringify(fixture.viewer.clock), clock)
  assert.ok(fixture.invalidations > 0)
  assert.equal(traffic.getDiagnostics().elapsedSeconds, 1)
  traffic.destroy()
})
test('pause and hide freeze distance and resume without accumulating stopped time', async () => {
  const fixture = setup(), traffic = new TrafficSystem(fixture.options)
  await traffic.readyPromise
  fixture.tick(1000); traffic.pause(); fixture.tick(10000)
  assert.equal(traffic.getDiagnostics().elapsedSeconds, 1)
  traffic.play(); fixture.tick(1000)
  assert.equal(traffic.getDiagnostics().elapsedSeconds, 2)
  traffic.setVisible(false); assert.equal(fixture.models[0].show, false)
  fixture.tick(5000); traffic.setVisible(true); fixture.tick(1000)
  assert.equal(traffic.getDiagnostics().elapsedSeconds, 3)
  traffic.destroy()
})
test('speed changes affect subsequent travel and reject invalid multipliers', async () => {
  const fixture = setup(), traffic = new TrafficSystem(fixture.options)
  await traffic.readyPromise
  fixture.tick(1000); traffic.setSpeed(2); fixture.tick(1000)
  assert.ok(Math.abs(traffic.vehicles[0].distance - 30) < 1e-8)
  for (const value of [-1, NaN, Infinity, '2']) assert.throws(() => traffic.setSpeed(value))
  traffic.setSpeed(0); fixture.tick(5000)
  assert.ok(Math.abs(traffic.vehicles[0].distance - 30) < 1e-8)
  traffic.destroy()
})
test('continuous vehicle movement defers the shadow redraw instead of forcing it', async () => {
  const fixture = setup(), traffic = new TrafficSystem(fixture.options)
  await traffic.readyPromise
  fixture.invalidationArgs.length = 0
  fixture.tick(1000)
  assert.ok(fixture.invalidationArgs.length > 0, 'moving vehicles still stale the cached caster signature')
  // Every invalidation caused by per-frame motion must be the deferred form, otherwise
  // forceShadowUpdate stays set and shadowUpdateInterval can never skip a frame.
  // Load/spawn/visibility are discrete and keep the immediate default.
  for (const args of fixture.invalidationArgs) {
    assert.deepEqual(args, [{ immediate: false }], 'per-frame movement must not force an immediate redraw')
  }
  traffic.setVisible(false)
  assert.notEqual(fixture.invalidationArgs.at(-1)[0]?.immediate, false, 'a visibility change must still redraw immediately')
  traffic.destroy()
})
test('vehicles registered as dynamic shadow casters never drop the static shadow layer', async () => {
  const fixture = setup(), dynamic = []
  fixture.options.pipeline.setShadowCasterDynamic = (model, value) => dynamic.push([model, value])
  const traffic = new TrafficSystem(fixture.options)
  await traffic.readyPromise
  assert.deepEqual(dynamic, [[fixture.models[0], true]])
  fixture.invalidationArgs.length = 0
  fixture.tick(1000)
  assert.equal(fixture.invalidationArgs.length, 0, 'motion is covered by the scheduled dynamic-layer refresh')
  traffic.setVisible(false)
  assert.deepEqual(fixture.invalidationArgs.at(-1), [{ dynamicOnly: true }])
  traffic.destroy()
})
test('one listener drives all cars and destroy preserves foreign primitives', async () => {
  const fixture = setup(), foreign = {}, traffic = new TrafficSystem({ ...fixture.options,
    vehicles: [...vehicles, { ...vehicles[0], id: 'car-2', offset: 50 }] })
  fixture.members.add(foreign)
  await traffic.readyPromise
  assert.equal(fixture.viewer.scene.preUpdate.numberOfListeners, 1)
  traffic.destroy(); traffic.destroy()
  assert.equal(fixture.viewer.scene.preUpdate.numberOfListeners, 0)
  assert.deepEqual([...fixture.members], [foreign])
  assert.ok(fixture.models.every(model => model.isDestroyed()))
  assert.equal(traffic.getDiagnostics().state, 'destroyed')
  fixture.tick(1000)
})
test('vehicle input is validated before starting model requests', async () => {
  for (const input of [[{ ...vehicles[0], routeId: 'missing' }], [{ ...vehicles[0], speed: -1 }],
    [{ ...vehicles[0], scale: 0 }], [{ ...vehicles[0], offset: Infinity }], [vehicles[0], vehicles[0]]]) {
    const fixture = setup(), traffic = new TrafficSystem({ ...fixture.options, vehicles: input })
    await assert.rejects(traffic.readyPromise)
    assert.equal(fixture.models.length, 0)
    assert.equal(fixture.members.size, 0)
    traffic.destroy()
  }
})

test('initial vehicles load serially and destruction stops queued model requests', async () => {
  const pending = []
  const fixture = setup(() => new Promise(resolve => pending.push(resolve)))
  const traffic = new TrafficSystem({ ...fixture.options,
    vehicles: [0, 1, 2].map(i => ({ ...vehicles[0], id: `car-${i}`, offset: i * 20 })) })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(pending.length, 1)
  pending[0](fixture.makeModel())
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(pending.length, 2)
  traffic.destroy()
  pending[1](fixture.makeModel())
  await assert.rejects(traffic.readyPromise)
  assert.equal(pending.length, 2)
  assert.equal(fixture.members.size, 0)
})

test('destruction during cooperative junction preparation prevents vehicle creation', async () => {
  const fixture = setup()
  const network = { type: 'FeatureCollection', features: [{ type: 'Feature', id: 'long',
    properties: { from: 'a', to: 'b', spawn: true },
    geometry: { type: 'LineString', coordinates: [[123, 41, 0], [123.2, 41, 0]] } }] }
  const traffic = new TrafficSystem({ ...fixture.options, network, routes: undefined,
    vehicles: [{ ...vehicles[0], routeId: 'long' }] })
  await new Promise(resolve => setImmediate(resolve))
  traffic.destroy()
  await assert.rejects(traffic.readyPromise, /destroyed/)
  assert.equal(fixture.models.length, 0)
  assert.equal(fixture.members.size, 0)
})
test('manifest URLs resolve relative vehicle assets and failed loading rolls back', async () => {
  const fixture = setup(), traffic = new TrafficSystem({ ...fixture.options, routes: undefined, vehicles: undefined,
    manifestUrl: 'https://example.test/data/traffic.json', fetchJson: async () => ({ schemaVersion: 1, routes,
      vehicles: [{ ...vehicles[0], url: '../cars/a.glb' }] }) })
  await traffic.readyPromise
  assert.equal(traffic.vehicles[0].url, 'https://example.test/cars/a.glb')
  traffic.destroy()
  let calls = 0
  const failed = setup(async () => { if (++calls === 2) throw Error('asset missing'); return failed.makeModel() })
  const broken = new TrafficSystem({ ...failed.options, vehicles: [vehicles[0], { ...vehicles[0], id: 'b' }] })
  await assert.rejects(broken.readyPromise, /asset missing/)
  assert.equal(broken.getDiagnostics().state, 'error')
  assert.equal(failed.members.size, 0)
  assert.equal(failed.viewer.scene.preUpdate.numberOfListeners, 0)
  broken.destroy()
})
test('destroy during async loading destroys late models instead of attaching them', async () => {
  let complete
  const fixture = setup(() => new Promise(resolve => { complete = resolve }))
  const traffic = new TrafficSystem(fixture.options)
  while (!complete) await new Promise(resolve => setImmediate(resolve))
  traffic.destroy()
  const late = fixture.makeModel(); complete(late)
  await assert.rejects(traffic.readyPromise, /destroyed/i)
  assert.equal(late.isDestroyed(), true)
  assert.equal(fixture.members.size, 0)
  assert.equal(fixture.viewer.scene.preUpdate.numberOfListeners, 0)
})
test('destroy cancels readiness waiters and removes ready/error/render listeners', async () => {
  const fixture = setup(async () => { const model = fixture.makeModel(); model.ready = false; return model })
  const traffic = new TrafficSystem(fixture.options)
  while (!fixture.models[0]?.readyEvent.numberOfListeners) await new Promise(resolve => setImmediate(resolve))
  const model = fixture.models[0]
  traffic.destroy()
  await assert.rejects(traffic.readyPromise, /destroyed/i)
  assert.equal(model.readyEvent.numberOfListeners, 0)
  assert.equal(model.errorEvent.numberOfListeners, 0)
  assert.equal(fixture.viewer.scene.postRender.numberOfListeners, 0)
})

test('distance is independent of frame subdivision and defaults to even vehicle spacing', async () => {
  const a = setup(), b = setup(), one = new TrafficSystem(a.options), many = new TrafficSystem(b.options)
  await Promise.all([one.readyPromise, many.readyPromise])
  a.tick(1000); for (let i = 0; i < 10; i++) b.tick(100)
  assert.ok(C.Matrix4.equalsEpsilon(a.models[0].modelMatrix, b.models[0].modelMatrix, 1e-7))
  one.destroy(); many.destroy()
  const fixture = setup(), traffic = new TrafficSystem({ ...fixture.options,
    vehicles: [0, 1].map(index => ({ ...vehicles[0], id: `car-${index}`, offset: undefined })) })
  await traffic.readyPromise
  assert.equal(traffic.vehicles[1].distance, traffic.vehicles[0].route.length / 2)
  traffic.destroy()
})

test('tab visibility changes reset time even when background frames stop completely', async () => {
  const original = globalThis.document, listeners = new Set()
  globalThis.document = { baseURI: 'https://example.test/', hidden: false,
    addEventListener(type, listener) { listeners.add(listener) }, removeEventListener(type, listener) { listeners.delete(listener) } }
  try {
    const fixture = setup(), traffic = new TrafficSystem(fixture.options)
    await traffic.readyPromise
    fixture.tick(1000)
    document.hidden = true; for (const listener of listeners) listener()
    fixture.tick(60000)
    document.hidden = false; for (const listener of listeners) listener()
    fixture.tick(1000)
    assert.equal(traffic.elapsedSeconds, 2)
    traffic.destroy(); assert.equal(listeners.size, 0)
  } finally { if (original === undefined) delete globalThis.document; else globalThis.document = original }
})

test('a load failure rolls back ready vehicles and never starts later requests', async () => {
  let calls = 0
  const fixture = setup(async () => {
    if (++calls === 2) throw new Error('broken asset')
    return fixture.makeModel()
  })
  const traffic = new TrafficSystem({ ...fixture.options,
    vehicles: [0, 1, 2].map(i => ({ ...vehicles[0], id: `car-${i}`, offset: i * 20 })) })
  await assert.rejects(traffic.readyPromise, /broken asset/)
  assert.equal(calls, 2)
  assert.equal(fixture.models[0].isDestroyed(), true)
  assert.equal(fixture.members.size, 0)
  traffic.destroy()
})

test('immediate destruction cannot repopulate the disposed route map', async () => {
  const fixture = setup(), traffic = new TrafficSystem(fixture.options)
  traffic.destroy()
  await assert.rejects(traffic.readyPromise, /destroyed/i)
  assert.equal(traffic.routes.size, 0)
  assert.equal(traffic.vehicles.length, 0)
  assert.equal(fixture.models.length, 0)
})

test('ground sampling resolving after destruction cannot retain compiled routes', async () => {
  let complete
  const fixture = setup()
  fixture.viewer.scene.clampToHeightMostDetailed = points => new Promise(resolve => { complete = () => resolve(points) })
  const traffic = new TrafficSystem({ ...fixture.options, clampToGround: true })
  assert.equal(typeof complete, 'function')
  traffic.destroy(); complete()
  await assert.rejects(traffic.readyPromise, /destroyed/i)
  assert.equal(traffic.routes.size, 0)
  assert.equal(fixture.models.length, 0)
})
