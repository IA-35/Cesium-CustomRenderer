import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { prepareTrafficRoutes, sampleTrafficRoute } from '../../src/traffic/trafficRoute.js'
import { prepareTrafficNetwork } from '../../src/traffic/trafficNetwork.js'
const C = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')
const A = [123, 41, 0], B = [123.001, 41, 0], D = [123.002, 41, 0]
const edge = (id, from, to, coordinates, properties = {}) => ({ type: 'Feature', id,
  geometry: { type: 'LineString', coordinates }, properties: { from, to, ...properties } })
const data = features => ({ type: 'FeatureCollection', features })

test('open lanes clamp samples at both endpoints while legacy routes require closure', async () => {
  const input = data([edge('ab', 'a', 'b', [A, B])])
  assert.throws(() => prepareTrafficRoutes(C, input))
  const route = (await prepareTrafficNetwork(C, input)).routes.get('ab')
  assert.equal(route.closed, false)
  for (const [distance, endpoint] of [[-5, 0], [route.length + 5, 1]]) {
    const p = new C.Cartesian3(), direction = new C.Cartesian3()
    sampleTrafficRoute(C, route, distance, p, direction)
    assert.ok(C.Cartesian3.distance(p, route.positions[endpoint]) < 1e-7)
    assert.ok(Math.abs(C.Cartesian3.magnitude(direction) - 1) < 1e-8)
  }
})

test('directed forks are explicit, sorted and exclude immediate reverse lanes', async () => {
  const network = await prepareTrafficNetwork(C, data([
    edge('ab', 'a', 'b', [A, B], { spawn: true, next: ['bd', 'ba'], priority: 2 }),
    edge('ba', 'b', 'a', [B, A]), edge('bd', 'b', 'd', [B, D])
  ]))
  assert.deepEqual(network.successors.get('ab'), ['bd'])
  assert.deepEqual(network.spawnRoutes, ['ab'])
  assert.equal(network.routes.get('ab').priority, 2)
  assert.equal(network.nodes.size, 3)
})

test('geometric crossings without shared nodes do not create connections', async () => {
  const network = await prepareTrafficNetwork(C, data([
    edge('ab', 'a', 'b', [A, D]),
    edge('cd', 'c', 'd', [[123.001, 40.999, 0], [123.001, 41.001, 0]])
  ]))
  assert.deepEqual(network.successors.get('ab'), [])
  assert.deepEqual(network.spawnRoutes, ['ab', 'cd'])
})

test('invalid graph metadata, inconsistent endpoints and impossible next links fail', async () => {
  for (const features of [
    [edge('ab', '', 'b', [A, B])],
    [edge('ab', 'a', 'b', [A, B], { priority: NaN })],
    [edge('ab', 'a', 'b', [A, B], { spawn: 'yes' })],
    [edge('ab', 'a', 'b', [A, B], { next: ['missing'] })],
    [edge('ab', 'a', 'b', [A, B]), edge('bd', 'b', 'd', [A, D])],
    [edge('ab', 'a', 'b', [A, B], { next: ['cd'] }), edge('cd', 'c', 'd', [A, D])],
    [edge('ab', 'a', 'b', [A, B]), edge('ba', 'b', 'a', [B, A])]
  ]) await assert.rejects(async () => prepareTrafficNetwork(C, data(features)))
})

test('explicit closed self-loops retain legal continuation and ground sampling', async () => {
  const input = data([edge('loop', 'a', 'a', [A, B, [123.001, 41.001, 0], A], { spawn: true })])
  const network = await prepareTrafficNetwork(C, input, { clampToGround: true,
    scene: { clampToHeightMostDetailed: async points => points } })
  assert.equal(network.routes.get('loop').closed, true)
  assert.deepEqual(network.successors.get('loop'), ['loop'])
})

test('a closed self-loop cannot bypass open-lane junction admission at a shared node', async () => {
  const input = data([edge('loop','a','a',[A,B,[123.001,41.001,0],A],{spawn:true}),
    edge('out','a','d',[A,D])])
  await assert.rejects(() => prepareTrafficNetwork(C,input), /closed|loop|shared/i)
})
