import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { prepareCampusTraffic } from '../../examples/campus-traffic-placement.js'
const C = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')
const manifest = () => ({ schemaVersion: 1, network: { type: 'FeatureCollection', features: [
  { type: 'Feature', id: 'a', properties: { from: 'west', to: 'east' }, geometry: { type: 'LineString',
    coordinates: [[123,41,0], [123.0001,41,0], [123.0002,41,0]] } },
  { type: 'Feature', id: 'b', properties: { from: 'east', to: 'north' }, geometry: { type: 'LineString',
    coordinates: [[123.0002,41,0], [123.0002,41.0001,0]] } }
] }, vehicles: [{ id: 'car', routeId: 'a', url: '../traffic-assets/car-blue.glb', speed: 8 }] })
const atHeight = (p, height) => {
  const c = C.Cartographic.fromCartesian(p)
  return C.Cartesian3.fromRadians(c.longitude, c.latitude, height)
}

test('campus placement resolves car URLs and keeps source data unchanged', async () => {
  const data = manifest(), before = JSON.stringify(data), excluded = [{}]
  const scene = { clampToHeightMostDetailed: async (points, objects) => {
    assert.equal(objects, excluded)
    return points.map(point => atHeight(point, 2))
  } }
  const result = await prepareCampusTraffic(C, scene, data, 'https://example.test/examples/campus-traffic/traffic.json', excluded)
  assert.equal(JSON.stringify(data), before)
  assert.equal(result.vehicles[0].url, 'https://example.test/examples/traffic-assets/car-blue.glb')
  for (const f of result.network.features) for (const p of f.geometry.coordinates) assert.ok(Math.abs(p[2] - 2.03) < 1e-6)
  assert.equal(result.network.features[0].geometry.coordinates.at(-1)[2], result.network.features[1].geometry.coordinates[0][2])
  assert.equal(result.placement.missingSamples, 0)
})

test('missing ground is interpolated from surveyed neighbours and counted', async () => {
  const data = manifest()
  const scene = { clampToHeightMostDetailed: async points => points.map(point => {
    const longitude = C.Math.toDegrees(C.Cartographic.fromCartesian(point).longitude)
    return Math.abs(longitude - 123.0001) < .00001 ? undefined : atHeight(point, longitude > 123.00015 ? 4 : 2)
  }) }
  const result = await prepareCampusTraffic(C, scene, data, 'https://example.test/traffic.json', [], { spacing: 1 })
  const points = result.network.features[0].geometry.coordinates
  assert.ok(Math.abs(points[1][2] - 3.03) < 1e-4)
  assert.ok(result.placement.missingSamples > 0)
  assert.ok(result.placement.interpolatedVertices > 0)
})

test('no surveyed ground refuses zero-height placement', async () => {
  const scene = { clampToHeightMostDetailed: async points => points.map(() => undefined) }
  await assert.rejects(prepareCampusTraffic(C, scene, manifest(), 'https://example.test/traffic.json'), /ground height/i)
  await assert.rejects(prepareCampusTraffic(C, {}, manifest(), 'https://example.test/traffic.json'), /supported/i)
})

test('cancelled placement stops after the pending ground request', async () => {
  let resolve, cancelled = false
  const scene = { clampToHeightMostDetailed: points => new Promise(done => { resolve = () => done(points.map(p => atHeight(p, 2))) }) }
  const promise = prepareCampusTraffic(C, scene, manifest(), 'https://example.test/traffic.json', [], { isCancelled: () => cancelled })
  cancelled = true; resolve()
  await assert.rejects(promise, /cancelled/i)
})
