import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import TrafficSystem from '../../src/traffic/TrafficSystem.js'
const C = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')
const point = (east, north) => [123 + east / 80000, 41 + north / 111000, 10]
const nodes = { W: point(-100, 0), J: point(0, 0), D: point(90, 0), N: point(0, 90), Q: point(160, 90) }
const lane = (id, from, to, spawn = false) => ({ type: 'Feature', id,
  properties: { from, to, spawn }, geometry: { type: 'LineString', coordinates: [nodes[from], nodes[to]] } })
const network = { type: 'FeatureCollection', features: [lane('west', 'W', 'J', true),
  lane('east', 'J', 'D'), lane('north', 'J', 'N'), lane('far', 'Q', 'N', true)] }
function setup(loader) {
  let now = 0, count = 0
  const models = [], members = new Set(), preUpdate = new C.Event(), postRender = new C.Event()
  const makeModel = () => {
    let destroyed = false
    const model = { ready: true, readyEvent: new C.Event(), errorEvent: new C.Event(),
      modelMatrix: C.Matrix4.clone(C.Matrix4.IDENTITY), isDestroyed: () => destroyed,
      destroy() { assert.equal(destroyed, false); destroyed = true } }
    models.push(model); return model
  }
  const scene = { preUpdate, postRender, requestRender() {}, primitives: {
    add(model) { members.add(model) }, remove(model) { if (members.delete(model)) { model.destroy(); return true } return false }
  } }
  const viewer = { scene, isDestroyed: () => false, clock: { shouldAnimate: false, currentTime: C.JulianDate.now() } }
  const engine = { ...C, Model: { fromGltfAsync: async options => loader ? loader(++count, makeModel, options) : makeModel() } }
  return { models, members, makeModel, viewer, tick(ms) { now += ms; preUpdate.raiseEvent() },
    options: { Cesium: engine, viewer, network, now: () => now,
      vehicles: [{ id: 'car', routeId: 'east', url: 'https://example.test/car.glb', speed: 8 }] } }
}
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)) }

test('a dead-end car is destroyed and a distinct model spawns at another safe entry', async () => {
  const fixture = setup(), traffic = new TrafficSystem(fixture.options)
  await traffic.readyPromise
  const original = traffic.vehicles[0].model, route = traffic.vehicles[0].route
  traffic.vehicles[0].distance = route.length - .1
  fixture.tick(1000); await settle()
  assert.equal(original.isDestroyed(), true)
  assert.equal(fixture.members.has(original), false)
  assert.notEqual(traffic.vehicles[0].route.id, route.id)
  assert.notEqual(traffic.vehicles[0].model, original)
  assert.equal(traffic.vehicles[0].model.ready, true)
  assert.equal(fixture.members.size, 1)
  assert.ok(traffic.getDiagnostics().despawned >= 1)
  traffic.destroy(); assert.equal(fixture.members.size, 0)
})

test('destroy during respawn loading releases the late model without reattaching', async () => {
  let complete
  const fixture = setup((count, makeModel) => count === 1 ? makeModel() : new Promise(resolve => { complete = resolve }))
  const traffic = new TrafficSystem(fixture.options)
  await traffic.readyPromise
  traffic.vehicles[0].distance = traffic.vehicles[0].route.length - .1
  for (let i = 0; i < 20 && !complete; i++) { fixture.tick(100); await settle() }
  assert.equal(typeof complete, 'function')
  traffic.destroy()
  const late = fixture.makeModel(); complete(late); await settle()
  assert.equal(late.isDestroyed(), true)
  assert.equal(fixture.members.size, 0)
  assert.equal(fixture.viewer.scene.preUpdate.numberOfListeners, 0)
})

test('respawn failure reports that vehicle and leaves no failed model or retry storm', async () => {
  let requests = 0
  const fixture = setup((count, makeModel) => { requests++; if (count > 1) throw Error('respawn unavailable'); return makeModel() })
  const traffic = new TrafficSystem(fixture.options)
  await traffic.readyPromise
  traffic.vehicles[0].distance = traffic.vehicles[0].route.length - .1
  fixture.tick(1000); await settle()
  assert.equal(traffic.state, 'ready')
  assert.equal(traffic.getDiagnostics().respawnErrors.length, 1)
  assert.equal(traffic.vehicles[0].state, 'error')
  fixture.tick(10000); await settle()
  assert.equal(requests, 2)
  assert.equal(fixture.members.size, 0)
  traffic.destroy()
})

test('waiting initial vehicles stay hidden even when the layer is made visible', async () => {
  const fixture = setup(), vehicle = { ...fixture.options.vehicles[0], routeId: 'west', offset: 0 }
  const traffic = new TrafficSystem({ ...fixture.options, vehicles: [vehicle, { ...vehicle, id: 'second' }] })
  await traffic.readyPromise
  assert.equal(traffic.vehicles.filter(car => car.state === 'waiting').length, 1)
  traffic.setVisible(false); traffic.setVisible(true)
  assert.equal(traffic.vehicles.find(car => car.state === 'waiting').model.show, false)
  traffic.destroy()
})

test('open lane input errors reject before allocating models', async () => {
  for (const patch of [{ length: 0 }, { width: NaN }, { offset: -1 }, { offset: 10000 }]) {
    const fixture = setup(), traffic = new TrafficSystem({ ...fixture.options,
      vehicles: [{ ...fixture.options.vehicles[0], ...patch }] })
    await assert.rejects(traffic.readyPromise)
    assert.equal(fixture.models.length, 0)
    traffic.destroy()
  }
})

test('respawn readiness failures remove the replacement and all readiness listeners', async () => {
  const fixture = setup((count, makeModel) => { const model = makeModel(); if (count > 1) model.ready = false; return model })
  const traffic = new TrafficSystem(fixture.options)
  await traffic.readyPromise
  traffic.vehicles[0].distance = traffic.vehicles[0].route.length - .1
  fixture.tick(1000); await settle()
  const replacement = fixture.models.at(-1)
  assert.equal(replacement.readyEvent.numberOfListeners, 1)
  replacement.errorEvent.raiseEvent(new Error('invalid glTF')); await settle()
  assert.equal(replacement.isDestroyed(), true)
  assert.equal(replacement.errorEvent.numberOfListeners, 0)
  assert.equal(replacement.readyEvent.numberOfListeners, 0)
  assert.equal(fixture.viewer.scene.postRender.numberOfListeners, 0)
  assert.equal(traffic.getDiagnostics().respawnErrors.length, 1)
  traffic.destroy()
})

test('delayed successful respawn holds its entry while hidden and moves only after ready', async () => {
  const fixture = setup((count, makeModel) => { const model = makeModel(); if (count > 1) model.ready = false; return model })
  const traffic = new TrafficSystem(fixture.options)
  await traffic.readyPromise
  traffic.vehicles[0].distance = traffic.vehicles[0].route.length - .1
  fixture.tick(1000); await settle()
  const car = traffic.vehicles[0], replacement = car.model, distance = car.distance
  assert.equal(car.state, 'spawning'); assert.equal(replacement.show, false)
  traffic.setVisible(false); traffic.setVisible(true)
  assert.equal(replacement.show, false)
  fixture.tick(1000); assert.equal(car.distance, distance)
  replacement.ready = true; replacement.readyEvent.raiseEvent(); await settle()
  assert.equal(car.state, 'driving'); assert.equal(replacement.show, true)
  fixture.tick(1000); assert.ok(car.distance > distance)
  traffic.destroy(); assert.equal(replacement.isDestroyed(), true)
})
