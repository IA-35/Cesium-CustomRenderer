import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import TrafficSimulation from '../../src/traffic/TrafficSimulation.js'
import { prepareTrafficNetwork } from '../../src/traffic/trafficNetwork.js'
const C = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')
const point = (x, y = 0) => [123 + x / 84000, 41 + y / 111000, 0]
const feature = (id, from, to, points, properties = {}) => ({ type: 'Feature', id,
  properties: { from, to, ...properties }, geometry: { type: 'LineString', coordinates: points.map(p => point(...p)) } })
const pair = () => [feature('ab', 'a', 'b', [[0, 0], [100, 0]], { corridor: 'narrow', spawn: true }),
  feature('ba', 'b', 'a', [[100, 0], [0, 0]], { corridor: 'narrow', spawn: true })]
const graph = features => prepareTrafficNetwork(C, { type: 'FeatureCollection', features })
const car = (id, route, distance = 0, speed = 8) => ({ id, route, distance, speed, length: 4.3, width: 1.8 })
const active = v => v.state === 'driving' || v.state === 'spawning'
const junctionGraph = () => graph([...pair(),
  feature('south-a', 'sa', 'a', [[0, -100], [0, 0]], { next: ['ab'] }),
  feature('south-b', 'sb', 'b', [[100, -100], [100, 0]], { next: ['ba'] }),
  feature('west', 'a', 'w', [[0, 0], [-100, 0]]),
  feature('east', 'b', 'e', [[100, 0], [200, 0]])])

test('corridor metadata requires a reverse pair with identical centreline geometry', async () => {
  const network = await graph(pair())
  assert.equal(network.routes.get('ab').corridor, 'narrow')
  const malformed = [
    [feature('ab', 'a', 'b', [[0, 0], [100, 0]], { corridor: '' })],
    [feature('ab', 'a', 'b', [[0, 0], [100, 0]], { corridor: '  ' })],
    [feature('ab', 'a', 'b', [[0, 0], [100, 0]], { corridor: 1 })],
    [pair()[0]],
    [...pair(), feature('third', 'a', 'b', [[0, 0], [100, 0]], { corridor: 'narrow' })],
    [pair()[0], feature('ba', 'b', 'a', [[100, 0], [50, 2], [0, 0]], { corridor: 'narrow' })],
    [pair()[0], feature('other', 'c', 'd', [[100, 0], [0, 0]], { corridor: 'narrow' })]
  ]
  for (const features of malformed) await assert.rejects(() => graph(features), /corridor|metadata/i)
})

test('shared reverse lanes construct without overlapping conflict zones and hide opposing initial cars', async () => {
  const network = await graph(pair())
  const forward = car('forward', network.routes.get('ab'), 20)
  const reverse = car('reverse', network.routes.get('ba'), 20)
  const convoy = car('convoy', network.routes.get('ab'), 5)
  const simulation = new TrafficSimulation(C, [forward, reverse, convoy], network)
  assert.equal(forward.state, 'driving')
  assert.equal(convoy.state, 'driving')
  assert.equal(reverse.state, 'waiting')
  assert.equal(simulation.getDiagnostics().activeCorridors, 1)
})

test('parked and loading owners block opposite spawning until the last owner fails', async () => {
  const network = await graph(pair())
  network.spawnRoutes = ['ba']
  const owner = car('parked', network.routes.get('ab'), 40, 0)
  const loading = car('loading', network.routes.get('ab'), 10, 0)
  const opposite = car('opposite', network.routes.get('ba'), 10)
  const simulation = new TrafficSimulation(C, [owner, loading, opposite], network)
  loading.state = 'spawning'
  assert.equal(simulation.advance(1).length, 0)
  assert.equal(opposite.state, 'waiting')
  owner.state = 'error'
  assert.equal(simulation.advance(1).length, 0)
  loading.state = 'error'
  assert.deepEqual(simulation.advance(.05).map(e => e.type), ['spawn'])
  assert.equal(opposite.route.id, 'ba')
  assert.equal(opposite.state, 'spawning')
  assert.equal(simulation.getDiagnostics().activeCorridors, 1)
})

test('opposing junction admission waits for the outgoing owner tail and then makes progress', async () => {
  const network = await junctionGraph()
  network.successors.set('ab', ['east']); network.successors.set('ba', ['west'])
  const owner = car('owner', network.routes.get('ab'), 70)
  const opposite = car('opposite', network.routes.get('south-b'), 80)
  const simulation = new TrafficSimulation(C, [owner, opposite], network)
  let sawTail = false, entered = false
  for (let step = 0; step < 400; step++) {
    simulation.advance(.05)
    if (owner.route.id === 'east' && owner.distance < simulation.zones.get(owner.route).start) {
      sawTail = true
      assert.equal(opposite.route.id, 'south-b')
    }
    entered ||= opposite.route.id === 'ba'
    if (active(owner) && active(opposite)) assert.equal(simulation._physicalOverlap(owner, owner.route, owner.distance, opposite), false)
  }
  assert.ok(sawTail)
  assert.ok(entered)
})

test('an opposing entry reservation blocks spawning before its car reaches the corridor', async () => {
  const network = await junctionGraph()
  network.spawnRoutes = ['ab']
  const incoming = car('incoming', network.routes.get('south-b'), 90)
  const queued = car('queued', network.routes.get('south-b'), 90)
  const simulation = new TrafficSimulation(C, [incoming, queued], network)
  assert.equal(queued.state, 'waiting')
  simulation.advance(.05)
  assert.equal(simulation.reservations.get('b')?.vehicle, incoming)
  assert.equal(queued.state, 'waiting')
  incoming.state = 'error'
  assert.deepEqual(simulation.advance(.05).map(e => e.type), ['spawn'])
  assert.equal(queued.route.id, 'ab')
})

test('the last terminal departure releases the corridor for a waiting opposite entry', async () => {
  const network = await graph(pair())
  network.spawnRoutes = ['ba']
  const owner = car('owner', network.routes.get('ab'), 98)
  const opposite = car('opposite', network.routes.get('ba'), 10)
  const simulation = new TrafficSimulation(C, [owner, opposite], network)
  assert.equal(opposite.state, 'waiting')
  const events = simulation.advance(1)
  assert.deepEqual(events.map(e => [e.type, e.vehicle.id]), [['despawn', 'owner'], ['spawn', 'opposite']])
  assert.equal(owner.state, 'waiting')
  assert.equal(opposite.state, 'spawning')
})

test('older opposing requests stop a continuing convoy from starving the other endpoint', async () => {
  const network = await junctionGraph()
  network.successors.set('ab', ['east']); network.successors.set('ba', ['west'])
  const owner = car('owner', network.routes.get('ab'), 30)
  const reverse = car('reverse', network.routes.get('south-b'), 85)
  const forwards = Array.from({ length: 4 }, (_, i) => car(`forward-${i}`, network.routes.get('south-a'), 80 - i * 15))
  const cars = [owner, reverse, ...forwards]
  const simulation = new TrafficSimulation(C, cars, network)
  let reverseEntered = false, forwardEntered = false
  const admittedDirections = []
  for (let step = 0; step < 1600; step++) {
    for (const event of simulation.advance(.05)) if (event.type === 'spawn') simulation.activate(event.vehicle)
    reverseEntered ||= reverse.route.id === 'ba'
    forwardEntered ||= forwards.some(v => v.route.id === 'ab')
    const directions = new Set(cars.filter(v => active(v) && v.route.corridor).map(v => v.route.id))
    assert.ok(directions.size <= 1)
    const direction = [...directions][0]
    if (direction && direction !== admittedDirections.at(-1)) admittedDirections.push(direction)
    const visible = cars.filter(active)
    for (let a = 0; a < visible.length; a++) for (let b = a + 1; b < visible.length; b++) {
      assert.equal(simulation._physicalOverlap(visible[a], visible[a].route, visible[a].distance, visible[b]), false,
        `step ${step}: ${visible[a].id}/${visible[a].route.id} overlaps ${visible[b].id}/${visible[b].route.id}`)
    }
  }
  assert.ok(reverseEntered)
  assert.ok(forwardEntered)
  assert.ok(admittedDirections.length >= 3, `directions did not alternate: ${admittedDirections}`)
  assert.ok(simulation.getDiagnostics().despawned >= 6)
})

test('both corridor endpoints continue admitting alternating requests over repeated rounds', async () => {
  const network = await junctionGraph()
  network.successors.set('ab', ['east']); network.successors.set('ba', ['west'])
  network.spawnRoutes = []
  const eastbound = car('eastbound', network.routes.get('south-a'), 85)
  const westbound = car('westbound', network.routes.get('south-b'), 85)
  const simulation = new TrafficSimulation(C, [eastbound, westbound], network)
  const directions = []
  for (let round = 0; round < 3; round++) {
    if (round) for (const [vehicle, route] of [[eastbound, 'south-a'], [westbound, 'south-b']]) {
      vehicle.route = network.routes.get(route)
      vehicle.distance = 85
      vehicle.state = 'driving'
      vehicle.currentSpeed = vehicle.speed
    }
    for (let step = 0; step < 1600 && [eastbound, westbound].some(active); step++) {
      simulation.advance(.05)
      const occupying = [eastbound, westbound].filter(v => active(v) && v.route.corridor)
      assert.ok(new Set(occupying.map(v => v.route.id)).size <= 1)
      const direction = occupying[0]?.route.id
      if (direction && direction !== directions.at(-1)) directions.push(direction)
      if (active(eastbound) && active(westbound)) {
        assert.equal(simulation._physicalOverlap(eastbound, eastbound.route, eastbound.distance, westbound), false)
      }
    }
    assert.equal(eastbound.state, 'waiting')
    assert.equal(westbound.state, 'waiting')
    assert.equal(simulation.getDiagnostics().activeCorridors, 0)
  }
  assert.deepEqual(directions, ['ab', 'ba', 'ab', 'ba', 'ab', 'ba'])
  assert.equal(simulation.getDiagnostics().despawned, 6)
})

test('reciprocal corridor choices use a legal free fork without entering the opposing owner', async () => {
  const network = await graph([
    feature('left-in', 'l', 'j', [[-100, 0], [0, 0]], { corridor: 'left', spawn: true }),
    feature('left-out', 'j', 'l', [[0, 0], [-100, 0]], { corridor: 'left' }),
    feature('right-in', 'r', 'j', [[100, 0], [0, 0]], { corridor: 'right', spawn: true }),
    feature('right-out', 'j', 'r', [[0, 0], [100, 0]], { corridor: 'right' }),
    feature('escape', 'j', 'n', [[0, 0], [0, 100]])
  ])
  network.spawnRoutes = []
  const left = car('left', network.routes.get('left-in'), 80)
  const right = car('right', network.routes.get('right-in'), 80)
  left.nextRoute = network.routes.get('right-out')
  right.nextRoute = network.routes.get('left-out')
  const simulation = new TrafficSimulation(C, [left, right], network)
  let escaped = false
  for (let step = 0; step < 400; step++) {
    simulation.advance(.05)
    escaped ||= left.route.id === 'escape' || right.route.id === 'escape'
    if (active(left) && active(right)) assert.equal(simulation._physicalOverlap(left, left.route, left.distance, right), false)
    assert.ok(left.route.id !== 'left-out' && right.route.id !== 'right-out', 'immediate U-turn selected')
  }
  assert.ok(escaped, 'both cars remain stuck on their preferred opposing corridors')
  assert.ok(simulation.getDiagnostics().despawned >= 1)
})

test('the actual school network keeps all 60 vehicles progressing for 600 seconds without overlap', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../examples/campus-traffic/traffic.json', import.meta.url), 'utf8'))
  assert.equal(manifest.vehicles.length, 60)
  assert.ok(manifest.network.features.every(feature => !feature.properties.corridor), 'school roads require separate lanes in both directions')
  const network = await prepareTrafficNetwork(C, manifest.network)
  const cars = manifest.vehicles.map(v => ({ ...v, route: network.routes.get(v.routeId), distance: v.offset ?? 0 }))
  const simulation = new TrafficSimulation(C, cars, network)
  const lastMotion = cars.map(() => 0)
  let travelled = 0, previousDepartures = 0
  for (let step = 0; step < 12000; step++) {
    const previous = cars.map(v => ({ route: v.route, distance: v.distance, state: v.state }))
    for (const event of simulation.advance(.05)) if (event.type === 'spawn') simulation.activate(event.vehicle)
    for (let i = 0; i < cars.length; i++) {
      if (previous[i].state !== 'driving') continue
      const movement = previous[i].route === cars[i].route ? cars[i].distance - previous[i].distance :
        previous[i].route.length - previous[i].distance + cars[i].distance
      travelled += Math.max(0, movement)
      if (movement > 1e-5) lastMotion[i] = simulation.time
    }
    const footprints = cars.filter(active).map(v => ({ vehicle: v, body: simulation._footprint(v, v.route, v.distance) }))
    for (let a = 0; a < footprints.length; a++) for (let b = a + 1; b < footprints.length; b++) {
      assert.equal(simulation._footprintsOverlap(footprints[a].body, footprints[b].body), false,
        `step ${step}: ${footprints[a].vehicle.id} overlaps ${footprints[b].vehicle.id}`)
    }
    if ((step + 1) % 1200 === 0) {
      const departed = simulation.getDiagnostics().despawned
      assert.ok(travelled > 1 || departed > previousDepartures, `all vehicles stopped during seconds ${(step + 1) / 20 - 60}–${(step + 1) / 20}`)
      for (let i = 0; i < cars.length; i++) {
        if (cars[i].speed > 0) assert.ok(simulation.time - lastMotion[i] < 180,
          `${cars[i].id} has made no progress for ${(simulation.time - lastMotion[i]).toFixed(1)} seconds`)
      }
      travelled = 0
      previousDepartures = departed
    }
  }
  assert.equal(simulation.vehicles.length, 60)
})
