import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { prepareTrafficRoutes, sampleTrafficRoute } from '../../src/traffic/trafficRoute.js'
const C = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')
const coordinates = [[123, 41, 10], [123.001, 41, 10], [123.001, 41.001, 10], [123, 41, 10]]
const data = points => ({ type: 'FeatureCollection', features: [{ type: 'Feature', id: 'loop',
  geometry: { type: 'LineString', coordinates: points }, properties: {} }] })

test('closed routes wrap distance continuously in both directions', () => {
  const route = prepareTrafficRoutes(C, data(coordinates)).get('loop')
  const position = new C.Cartesian3(), direction = new C.Cartesian3()
  sampleTrafficRoute(C, route, 0, position, direction)
  assert.ok(C.Cartesian3.distance(position, route.positions[0]) < 1e-8)
  const first = C.Cartesian3.clone(position)
  sampleTrafficRoute(C, route, route.length * 4, position, direction)
  assert.ok(C.Cartesian3.distance(first, position) < 1e-8)
  sampleTrafficRoute(C, route, -1, position, direction)
  const before = C.Cartesian3.clone(position)
  sampleTrafficRoute(C, route, route.length - 1, position, direction)
  assert.ok(C.Cartesian3.distance(before, position) < 1e-8)
  assert.ok(Math.abs(C.Cartesian3.magnitude(direction) - 1) < 1e-10)
})

test('arc distance produces uniform motion within a road segment', () => {
  const route = prepareTrafficRoutes(C, data(coordinates)).get('loop')
  const a = new C.Cartesian3(), b = new C.Cartesian3(), direction = new C.Cartesian3()
  sampleTrafficRoute(C, route, 10, a, direction)
  sampleTrafficRoute(C, route, 30, b, direction)
  assert.ok(Math.abs(C.Cartesian3.distance(a, b) - 20) < 1e-8)
})

test('adjacent repeated points do not introduce zero length segments', () => {
  const route = prepareTrafficRoutes(C, data([coordinates[0], ...coordinates])).get('loop')
  assert.equal(route.positions.length, coordinates.length)
  assert.ok(route.distances.every((distance, i, values) => i === 0 || distance > values[i - 1]))
})

test('open, degenerate, non-geographic, heightless and duplicate routes are rejected', () => {
  for (const points of [coordinates.slice(0, -1), [coordinates[0], coordinates[0]],
    [coordinates[0], coordinates[1], coordinates[0], coordinates[1], coordinates[0]],
    [[181, 41, 0], ...coordinates], coordinates.map(p => p.slice(0, 2)),
    coordinates.map(p => [p[0], p[1], NaN])]) {
    assert.throws(() => prepareTrafficRoutes(C, data(points)))
  }
  const repeated = data(coordinates)
  repeated.features.push(repeated.features[0])
  assert.throws(() => prepareTrafficRoutes(C, repeated), /Duplicate/)
  assert.throws(() => prepareTrafficRoutes(C, { type: 'FeatureCollection', features: [] }))
})

test('ground sampling is explicit and does not mutate caller coordinates', async () => {
  const input = data(coordinates.map(p => p.slice(0, 2)))
  const before = JSON.stringify(input)
  const scene = { clampToHeightMostDetailed: async positions => positions.map(p => {
    const c = C.Cartographic.fromCartesian(p)
    return C.Cartesian3.fromRadians(c.longitude, c.latitude, 23)
  }) }
  const routes = await prepareTrafficRoutes(C, input, { clampToGround: true, scene })
  assert.equal(JSON.stringify(input), before)
  assert.ok(Math.abs(C.Cartographic.fromCartesian(routes.get('loop').positions[0]).height - 23) < 1e-6)
  scene.clampToHeightMostDetailed = async positions => positions.map(() => undefined)
  await assert.rejects(async () => prepareTrafficRoutes(C, input, { clampToGround: true, scene }), /height/i)
})
