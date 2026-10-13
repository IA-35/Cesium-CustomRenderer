import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import TrafficSimulation from '../../src/traffic/TrafficSimulation.js'
import { prepareTrafficNetwork } from '../../src/traffic/trafficNetwork.js'
import { prepareTrafficRoutes } from '../../src/traffic/trafficRoute.js'
const C = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')
const point = (x, y = 0) => [123 + x / 84000, 41 + y / 111000, 0]
const graph = async definitions => prepareTrafficNetwork(C, { type: 'FeatureCollection', features:
  definitions.map(([id, from, to, a, b, properties = {}]) => ({ type: 'Feature', id,
    properties: { from, to, ...properties }, geometry: { type: 'LineString', coordinates: [point(...a), point(...b)] } })) })
const car = (id, route, distance, speed = 8, extra = {}) => ({ id, route, distance, speed, scale: 1, ...extra })
const loop = () => prepareTrafficRoutes(C, { type: 'FeatureCollection', features: [{ type: 'Feature', id: 'loop',
  properties: {}, geometry: { type: 'LineString', coordinates: [point(0), point(100), point(100, 100), point(0)] } }] }).get('loop')
const separated = (rear, front) => assert.ok(front.distance - rear.distance >= (rear.length + front.length) / 2 + 2 - 1e-7)
const curve = (network, id, points) => {
  const route = prepareTrafficRoutes(C, { type: 'FeatureCollection', features: [{ type: 'Feature', id,
    properties: {}, geometry: { type: 'LineString', coordinates: points.map(p => point(...p)) } }] }, { allowOpen: true }).get(id)
  Object.assign(network.routes.get(id), route)
}

test('fast followers decelerate and never overtake a stationary leader', () => {
  const route = loop(), front = car('front', route, 35, 0), rear = car('rear', route, 0, 20)
  const simulation = new TrafficSimulation(C, [rear, front])
  for (let i = 0; i < 300; i++) { simulation.advance(0.05); separated(rear, front) }
  assert.equal(rear.currentSpeed, 0)
  assert.ok(simulation.getDiagnostics().following > 0)
})

test('closed-loop followers see leaders across the wrap seam', () => {
  const route = loop(), front = car('front', route, 2, 0), rear = car('rear', route, route.length - 20, 12)
  const simulation = new TrafficSimulation(C, [rear, front])
  simulation.advance(10)
  assert.ok((front.distance - rear.distance + route.length) % route.length >= 6.5 - 1e-7)
  assert.ok(rear.currentSpeed < 0.001)
})

test('a moving leader allows a tightly spaced follower to advance without emergency braking', () => {
  const route = loop(), front = car('front', route, 30, 8), rear = car('rear', route, 23.5, 8)
  const simulation = new TrafficSimulation(C, [rear, front])
  simulation.advance(0.05)
  assert.ok(rear.currentSpeed >= 7.8)
  assert.ok(rear.distance > 23.8)
  separated(rear, front)
})

test('a moving platoon propagates a sudden stop through hard spacing constraints', () => {
  const route = loop(), cars = [car('rear', route, 0, 20), car('middle', route, 6.5, 20), car('front', route, 13, 0)]
  const simulation = new TrafficSimulation(C, cars)
  for (let step = 0; step < 40; step++) {
    simulation.advance(0.05)
    separated(cars[0], cars[1]); separated(cars[1], cars[2])
  }
})

test('followers open a time-headway gap behind a leader at the same desired speed', () => {
  const route = loop(), front = car('front', route, 30, 8), rear = car('rear', route, 23.5, 8)
  const simulation = new TrafficSimulation(C, [rear, front])
  simulation.advance(15)
  assert.ok(front.distance - rear.distance >= 6.5 + 8 * 1.1)
  assert.ok(rear.currentSpeed > 7.5)
})

test('fixed steps produce the same state for large and small frames', () => {
  const route = loop(), a = [car('a', route, 0, 12), car('b', route, 45, 5)]
  const b = a.map(v => ({ ...v }))
  const one = new TrafficSimulation(C, a), many = new TrafficSimulation(C, b)
  one.advance(10)
  for (let i = 0; i < 100; i++) many.advance(0.1)
  for (let i = 0; i < a.length; i++) {
    assert.ok(Math.abs(a[i].distance - b[i].distance) < 1e-8)
    assert.ok(Math.abs(a[i].currentSpeed - b[i].currentSpeed) < 1e-8)
  }
})

test('initial overlap queues a hidden vehicle while retaining its route', () => {
  const route = loop(), first = car('a', route, 0), second = car('b', route, 0)
  const simulation = new TrafficSimulation(C, [first, second])
  assert.equal(first.state, 'driving')
  assert.equal(second.state, 'waiting')
  assert.equal(second.route, route)
  assert.equal(second.currentSpeed, 0)
  const events = simulation.advance(2)
  assert.ok(events.some(event => event.type === 'spawn' && event.vehicle === second))
  assert.equal(second.state, 'spawning')
  const distance = second.distance
  simulation.advance(2)
  assert.equal(second.distance, distance)
  simulation.activate(second)
  assert.equal(second.currentSpeed, 0)
  simulation.advance(0.05)
  assert.ok(second.currentSpeed > 0 && second.currentSpeed <= 0.15)
})

test('fork choices are deterministic and do not select a direct U-turn', async () => {
  const network = await graph([['in', 'a', 'j', [0, 0], [50, 0], { spawn: true }],
    ['left', 'j', 'l', [50, 0], [50, 100]], ['right', 'j', 'r', [50, 0], [100, 0]],
    ['reverse', 'j', 'a', [50, 0], [0, 0]]])
  curve(network, 'reverse', [[50,0],[45,5],[5,5],[0,0]])
  const runs = []
  for (let i = 0; i < 2; i++) {
    const vehicle = car('same', network.routes.get('in'), 40)
    new TrafficSimulation(C, [vehicle], network).advance(3)
    runs.push(vehicle.route.id)
  }
  assert.equal(runs[0], runs[1])
  assert.ok(['left', 'right'].includes(runs[0]))
})

test('crossing and merging cars hold exclusive junction access until their tails clear', async () => {
  for (const merge of [false, true]) {
    const network = await graph([['west', 'w', 'j', [0, 0], [50, 0], { spawn: true }],
      ['south', 's', 'j', [50, -50], [50, 0], { spawn: true }],
      ['east', 'j', 'e', [50, 0], [150, 0]], ['north', 'j', 'n', [50, 0], [50, 100]]])
    network.successors.set('west', ['east'])
    network.successors.set('south', [merge ? 'east' : 'north'])
    const a = car('a', network.routes.get('west'), 35), b = car('b', network.routes.get('south'), 35)
    const simulation = new TrafficSimulation(C, [a, b], network)
    let sawWait = false, cleared = false
    for (let i = 0; i < 160; i++) {
      simulation.advance(0.05)
      sawWait ||= simulation.getDiagnostics().junctionWaiting > 0
      assert.ok(simulation.getDiagnostics().reservations <= 1)
      if (a.route.id === 'east' && a.distance < a.length / 2 + 2 && b.route.id !== 'south') {
        assert.ok(b.distance >= b.length / 2 + 2)
      }
      if (b.route.id !== 'south' && b.distance < b.length / 2 + 2 && a.route.id !== 'west') {
        assert.ok(a.distance >= a.length / 2 + 2)
      }
      if (b.route.id !== 'south') cleared = true
      if (merge && a.route === b.route) a.distance > b.distance ? separated(b, a) : separated(a, b)
    }
    assert.ok(sawWait)
    assert.ok(cleared)
  }
})

test('a queued rear car cannot steal the lane leader junction reservation', async () => {
  const network = await graph([['in', 'a', 'j', [0, 0], [100, 0]], ['out', 'j', 'b', [100, 0], [200, 0]]])
  const front = car('z-front', network.routes.get('in'), 80, 4), rear = car('a-rear', network.routes.get('in'), 70, 12)
  const simulation = new TrafficSimulation(C, [rear, front], network)
  simulation.advance(6)
  assert.equal(front.route.id, 'out')
  if (rear.route.id === 'out') separated(rear, front)
})

test('blocked exits keep cars before the junction without reserving it', async () => {
  const network = await graph([['in', 'a', 'j', [0, 0], [100, 0]], ['out', 'j', 'b', [100, 0], [200, 0]]])
  const front = car('block', network.routes.get('out'), 3, 0), incoming = car('in', network.routes.get('in'), 85, 8)
  const simulation = new TrafficSimulation(C, [incoming, front], network)
  simulation.advance(10)
  assert.equal(incoming.route.id, 'in')
  assert.ok(incoming.distance <= incoming.route.length - incoming.length / 2 - 2 + 1e-7)
  assert.equal(simulation.getDiagnostics().reservations, 0)
  assert.ok(simulation.getDiagnostics().junctionWaiting > 0)
})

test('dead-end departure emits ordered lifecycle events and safely uses another entry', async () => {
  const network = await graph([['one', 'a', 'b', [0, 0], [100, 0], { spawn: true }],
    ['two', 'c', 'd', [0, 50], [100, 50], { spawn: true }]])
  const vehicle = car('v', network.routes.get('one'), 98, 10)
  const simulation = new TrafficSimulation(C, [vehicle], network)
  const events = simulation.advance(1)
  assert.deepEqual(events.map(event => event.type), ['despawn', 'spawn'])
  assert.equal(vehicle.route.id, 'two')
  assert.equal(vehicle.state, 'spawning')
  assert.equal(vehicle.distance, 0)
  for (let cycle = 0; cycle < 3; cycle++) {
    simulation.activate(vehicle)
    const previous = vehicle.route.id
    const next = simulation.advance(30)
    assert.deepEqual(next.map(event => event.type), ['despawn', 'spawn'])
    assert.notEqual(vehicle.route.id, previous)
  }
  assert.equal(simulation.getDiagnostics().despawned, 4)
})

test('full alternative entries leave departed vehicles waiting and spawning cars occupy space', async () => {
  const network = await graph([['one', 'a', 'b', [0, 0], [100, 0], { spawn: true }],
    ['two', 'c', 'd', [0, 50], [100, 50], { spawn: true }]])
  const vehicle = car('v', network.routes.get('one'), 98, 10), blocker = car('b', network.routes.get('two'), 0, 0)
  const simulation = new TrafficSimulation(C, [vehicle, blocker], network)
  assert.deepEqual(simulation.advance(2).map(event => event.type), ['despawn'])
  assert.equal(vehicle.state, 'waiting')
  assert.ok(vehicle.route)
  assert.equal(simulation.advance(2).length, 0)
  blocker.distance = 30
  assert.deepEqual(simulation.advance(0.05).map(event => event.type), ['spawn'])
  const third = car('third', network.routes.get('one'), 98, 10)
  // A second terminal arrival cannot occupy the loading vehicle's reserved entry.
  simulation.vehicles.push(third)
  third.length = 4.5; third.width = 1.8; third.state = 'driving'; third.currentSpeed = 10; third.generation = 0
  simulation.advance(1)
  assert.equal(third.state, 'waiting')
})

test('regeneration entries must be spatially distant from the departure position', async () => {
  const network = await graph([['one', 'a', 'b', [0, 0], [100, 0], { spawn: true }],
    ['near', 'c', 'd', [101, 0], [201, 0], { spawn: true }]])
  const vehicle = car('v', network.routes.get('one'), 98, 10)
  const simulation = new TrafficSimulation(C, [vehicle], network)
  assert.deepEqual(simulation.advance(2).map(event => event.type), ['despawn'])
  assert.equal(vehicle.state, 'waiting')
})

test('short connectors are rejected explicitly rather than trapping long vehicles', async () => {
  const network = await graph([['short', 'a', 'b', [0, 0], [3, 0]]])
  assert.throws(() => new TrafficSimulation(C, [car('v', network.routes.get('short'), 0)], network), /short|connector|merge/i)
})

test('initial shared-node overlap queues one car while separated opposite lanes remain visible', async () => {
  const network = await graph([['west', 'w', 'j', [0, 0], [100, 0], { spawn: true }],
    ['south', 's', 'j', [100, -100], [100, 0], { spawn: true }],
    ['parallel', 'p', 'q', [100, 4.8], [0, 4.8], { spawn: true }]])
  const a = car('a', network.routes.get('west'), network.routes.get('west').length, 0)
  const b = car('b', network.routes.get('south'), network.routes.get('south').length, 0)
  const c = car('c', network.routes.get('parallel'), 0, 0)
  new TrafficSimulation(C, [a, b, c], network)
  assert.equal(a.state, 'driving')
  assert.equal(b.state, 'waiting')
  assert.equal(c.state, 'driving')
})

test('spawn entries cannot overlap occupied shared-node lanes', async () => {
  const network = await graph([['one', 'a', 'b', [0, 0], [100, 0], { spawn: true }],
    ['two', 'c', 'd', [0, 50], [100, 50], { spawn: true }],
    ['third', 'x', 'z', [0, 100], [0, 50]]])
  const departing = car('a', network.routes.get('one'), 98, 10)
  const blocking = car('b', network.routes.get('third'), network.routes.get('third').length - 1, 0)
  const simulation = new TrafficSimulation(C, [departing, blocking], network)
  const events = simulation.advance(1)
  assert.deepEqual(events.map(event => event.type), ['despawn'])
  assert.equal(departing.state, 'waiting')
})

test('loop offsets normalize and out-of-range open offsets fail before loading', async () => {
  const route = loop(), vehicle = car('v', route, -10)
  new TrafficSimulation(C, [vehicle])
  assert.ok(Math.abs(vehicle.distance - (route.length - 10)) < 1e-8)
  const network = await graph([['in', 'a', 'b', [0, 0], [100, 0]]])
  for (const offset of [-1, 101]) {
    assert.throws(() => new TrafficSimulation(C, [car('v', network.routes.get('in'), offset)], network), /offset/i)
  }
})

test('loading at a junction blocks admission even on a different outgoing lane', async () => {
  const network = await graph([['in', 'a', 'j', [0, 0], [100, 0]],
    ['out', 'j', 'b', [100, 0], [200, 0]], ['entry', 'j', 'c', [100, 0], [100, 100], { spawn: true }]])
  network.successors.set('in', ['out'])
  const incoming = car('a', network.routes.get('in'), 85, 8)
  const loading = car('b', network.routes.get('entry'), 0, 0)
  const simulation = new TrafficSimulation(C, [incoming, loading], network)
  loading.state = 'spawning'
  simulation.advance(5)
  assert.equal(incoming.route.id, 'in')
  assert.equal(simulation.getDiagnostics().reservations, 0)
})

test('a spawn entry at a reserved node waits rather than parking in the crossing path', async () => {
  const network = await graph([['in', 'a', 'j', [0, 0], [100, 0]],
    ['out', 'j', 'b', [100, 0], [200, 0]], ['entry', 'j', 'c', [100, 0], [100, 100], { spawn: true }]])
  network.successors.set('in', ['out'])
  const incoming = car('a', network.routes.get('in'), 90, 8)
  const queued = car('b', network.routes.get('in'), 90, 8)
  const simulation = new TrafficSimulation(C, [incoming, queued], network)
  assert.equal(queued.state, 'waiting')
  assert.equal(simulation.advance(0.05).length, 0)
  assert.equal(queued.state, 'waiting')
  simulation.advance(3)
  assert.equal(queued.state, 'spawning')
})

test('failed cars release junction ownership before the next car can enter', async () => {
  const network = await graph([['west', 'w', 'j', [0, 0], [100, 0]],
    ['south', 's', 'j', [100, -100], [100, 0]], ['out', 'j', 'b', [100, 0], [200, 0]]])
  const owner = car('a', network.routes.get('west'), 90, 8)
  const next = car('b', network.routes.get('south'), 80, 8)
  const simulation = new TrafficSimulation(C, [owner, next], network)
  simulation.advance(0.05)
  assert.equal(simulation.reservations.get('j').vehicle, owner)
  owner.state = 'error'
  simulation.advance(0.05)
  assert.equal(simulation.reservations.has('j'), false)
  simulation.advance(4)
  assert.equal(next.route.id, 'out')
  assert.ok([...simulation.reservations.values()].every(reservation => reservation.vehicle !== owner))
})

test('opposing tapered lanes yield beyond their converging footprints', async () => {
  const network = await graph([['in', 'n', 'j', [0, 70], [0, 0], { spawn: true }],
    ['out', 'j', 'n', [0, 0], [0, 70], { spawn: true }],
    ['west', 'w', 'j', [-70, 0], [0, 0]], ['east', 'j', 'e', [0, 0], [70, 0]]])
  curve(network, 'in', [[0,70],[-2.4,58],[-2.4,12],[0,0]])
  curve(network, 'out', [[0,0],[2.4,12],[2.4,58],[0,70]])
  network.successors.set('in', ['east']); network.successors.set('west', ['out'])
  const a = car('incoming', network.routes.get('in'), network.routes.get('in').length - 22, 8)
  const b = car('outgoing', network.routes.get('west'), network.routes.get('west').length - 8, 8)
  const simulation = new TrafficSimulation(C, [a,b], network)
  let turned = false
  for (let i=0;i<240;i++) {
    simulation.advance(0.05)
    if (a.state === 'driving' && b.state === 'driving') assert.equal(simulation._physicalOverlap(a,a.route,a.distance,b),false)
    turned ||= a.route.id === 'east'
  }
  assert.ok(turned)
})

test('a terminal approach reserves its node before an opposite entry can spawn', async () => {
  const network = await graph([['terminal','a','b',[0,0],[100,0]],
    ['entry','b','a',[100,0],[0,0],{spawn:true}], ['other','c','d',[0,50],[100,50],{spawn:true}]])
  curve(network,'entry',[[100,0],[90,4.8],[10,4.8],[0,0]])
  const incoming = car('incoming',network.routes.get('terminal'),88,8)
  const queued = car('queued',network.routes.get('other'),network.routes.get('other').length,8)
  const simulation = new TrafficSimulation(C,[incoming,queued],network)
  simulation.advance(.05)
  assert.equal(queued.state,'waiting')
  for(let i=0;i<80;i++) {
    simulation.advance(.05)
    if (incoming.state === 'driving' && onRoadForTest(queued)) assert.equal(simulation._physicalOverlap(incoming,incoming.route,incoming.distance,queued),false)
  }
  assert.ok(simulation.getDiagnostics().despawned>=2)
})
const onRoadForTest = car => car.state === 'driving' || car.state === 'spawning'

test('tapered demo preserves physical separation through repeated terminal and spawn cycles', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../examples/traffic-assets/network.json', import.meta.url), 'utf8'))
  const network = await prepareTrafficNetwork(C, manifest.network)
  const cars = manifest.vehicles.map(vehicle => ({ ...vehicle, route: network.routes.get(vehicle.routeId), distance: vehicle.offset ?? 0 }))
  const simulation = new TrafficSimulation(C, cars, network)
  for (let step = 0; step < 2400; step++) {
    for (const event of simulation.advance(0.05)) if (event.type === 'spawn') simulation.activate(event.vehicle)
    const active = cars.filter(onRoadForTest)
    for (let a = 0; a < active.length; a++) for (let b = a + 1; b < active.length; b++) {
      assert.equal(simulation._physicalOverlap(active[a], active[a].route, active[a].distance, active[b]), false,
        `step ${step}: ${active[a].id} ${active[a].route.id} overlaps ${active[b].id} ${active[b].route.id}`)
    }
  }
  assert.ok(simulation.getDiagnostics().despawned >= 20)
  assert.ok(simulation.getDiagnostics().spawned >= 20)
})

test('connectors cannot be shorter than the combined geometry conflict zones', async () => {
  const network = await graph([['in', 'a', 'j', [0,0], [100,0]],
    ['connector', 'j', 'k', [100,0], [110,0]], ['out', 'k', 'b', [110,0], [200,0]]])
  assert.throws(() => new TrafficSimulation(C, [car('v', network.routes.get('in'), 0)], network), /connector|merge|conflict/i)
})

test('shallow Y merge approaches wait before their incoming footprints converge', async () => {
  const network = await graph([['west','w','j',[-100,0],[0,0]],
    ['sw','s','j',[-100,-20],[0,0]], ['east','j','e',[0,0],[100,0]]])
  const west = car('west', network.routes.get('west'),30,8)
  const sw = car('sw', network.routes.get('sw'),30,8)
  const simulation = new TrafficSimulation(C,[west,sw],network)
  for(let step=0;step<320;step++) {
    simulation.advance(.05)
    assert.equal(simulation._physicalOverlap(west,west.route,west.distance,sw),false, `overlap at step ${step}`)
  }
  assert.equal(west.route.id,'east')
  assert.equal(sw.route.id,'east')
})

test('shallow outgoing forks retain junction ownership until their bodies diverge', async () => {
  const network = await graph([['west','w','j',[-100,0],[0,0]],
    ['south','s','j',[0,-100],[0,0]], ['east','j','e',[0,0],[100,0]],
    ['ne','j','n',[0,0],[100,20]]])
  network.successors.set('west',['east']); network.successors.set('south',['ne'])
  const west = car('west',network.routes.get('west'),85,8)
  const south = car('south',network.routes.get('south'),85,8)
  const simulation = new TrafficSimulation(C,[west,south],network)
  for(let step=0;step<240;step++) {
    simulation.advance(.05)
    assert.equal(simulation._physicalOverlap(west,west.route,west.distance,south),false, `overlap at step ${step}`)
  }
  assert.equal(west.route.id,'east')
  assert.equal(south.route.id,'ne')
})

test('an occupied shallow outgoing fork blocks admission onto its neighboring branch', async () => {
  const network = await graph([['in','w','j',[-100,0],[0,0],{next:['diagonal']}],
    ['east','j','e',[0,0],[100,0]], ['diagonal','j','n',[0,0],[100,20]]])
  const incoming = car('a',network.routes.get('in'),80,8)
  const parked = car('b',network.routes.get('east'),10,0)
  const simulation = new TrafficSimulation(C,[incoming,parked],network)
  for(let step=0;step<160;step++) {
    simulation.advance(.05)
    assert.equal(simulation._physicalOverlap(incoming,incoming.route,incoming.distance,parked),false)
  }
  assert.equal(incoming.route.id,'in')
  parked.speed = 8
  simulation.advance(12)
  assert.equal(incoming.route.id,'diagonal')
})

test('a deliberately stopped car outside the conflict zone cannot reserve it forever', async () => {
  const network = await graph([['west','w','j',[-100,0],[0,0],{next:['east']}],
    ['south','s','j',[0,-100],[0,0],{next:['north']}], ['east','j','e',[0,0],[100,0]],
    ['north','j','n',[0,0],[0,100]]])
  const parked = car('a',network.routes.get('west'),85,0)
  const moving = car('b',network.routes.get('south'),80,8)
  const simulation = new TrafficSimulation(C,[parked,moving],network)
  simulation.advance(6)
  assert.equal(parked.distance,85)
  assert.equal(moving.route.id,'north')
  assert.ok([...simulation.reservations.values()].every(reservation => reservation.vehicle !== parked))
})
