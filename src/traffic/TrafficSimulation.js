import { sampleTrafficRoute } from './trafficRoute.js'

const STEP = 0.05, GAP = 2, HEADWAY = 1.2, ACCELERATION = 2, DECELERATION = 4
const onRoad = vehicle => vehicle.state === 'driving' || vehicle.state === 'spawning'
const clearance = (a, b) => (a.length + b.length) / 2 + GAP

export default class TrafficSimulation {
  constructor(C, vehicles, network = null, checkpoint) {
    this.C = C
    this.vehicles = vehicles
    this.network = network
    this.time = 0
    this.accumulator = 0
    this.reservations = new Map()
    this.requests = new Map()
    this.zones = new Map()
    this.blockedCorridors = new Set()
    this.totals = { spawned: 0, despawned: 0 }
    this.destroyed = false
    this.collisionFootprints = new Map()
    const accepted = []
    for (const vehicle of vehicles) {
      const scale = vehicle.scale ?? 1
      vehicle.length = (vehicle.length ?? 4.5) * scale
      vehicle.width = (vehicle.width ?? 1.8) * scale
      if (![vehicle.length, vehicle.width].every(value => Number.isFinite(value) && value > 0) ||
        !Number.isFinite(vehicle.speed) || vehicle.speed < 0 || !Number.isFinite(vehicle.distance)) {
        throw new Error(`Invalid traffic vehicle dimensions, speed or offset: ${vehicle.id}`)
      }
      const route = vehicle.route
      if (route.closed === false && (vehicle.distance < 0 || vehicle.distance > route.length)) {
        throw new Error(`Traffic vehicle ${vehicle.id} offset is outside open lane ${route.id}`)
      }
      if (route.closed !== false && (vehicle.distance < 0 || vehicle.distance >= route.length)) {
        vehicle.distance = ((vehicle.distance % route.length) + route.length) % route.length
      }
      vehicle.homeRoute = route
      vehicle.generation = 0
      vehicle.state = 'driving'
      vehicle.currentSpeed = vehicle.speed
      vehicle.waitReason = null
      if (this._corridorBlocked(vehicle, route, accepted) || accepted.some(other => this._overlaps(vehicle, other))) {
        vehicle.state = 'waiting'; vehicle.currentSpeed = 0; vehicle.waitReason = 'entry'
      } else accepted.push(vehicle)
    }
    if (network) {
      const minimum = Math.max(...vehicles.map(vehicle => vehicle.length)) + GAP * 2
      for (const route of network.routes.values()) {
        if (!route.closed && route.length < minimum) {
          throw new Error(`Traffic lane ${route.id} is too short (${route.length.toFixed(2)} m); merge connectors to provide at least ${minimum.toFixed(2)} m`)
        }
      }
      const steps = this._prepareControlZones()
      if (checkpoint) this.readyPromise = this._finishControlZones(steps, checkpoint)
      else for (const step of steps) { /* 同步调用保留原初始化契约。 */ }
    }
  }

  async _finishControlZones(steps, checkpoint) {
    for (const step of steps) await checkpoint()
  }

  *_prepareControlZones() {
    const body = { length: Math.max(...this.vehicles.map(v => v.length)), width: Math.max(...this.vehicles.map(v => v.width)) }
    const cell = body.length + body.width + 0.4
    const samples = new Map()
    for (const route of this.network.routes.values()) this.zones.set(route, { start: body.length / 2 + GAP, end: body.length / 2 + GAP })
    for (const route of this.network.routes.values()) {
      if (route.closed) continue
      const ends = { start: { grid: new Map(), points: [] }, end: { grid: new Map(), points: [] } }
      for (let distance = 0; distance <= route.length / 2; distance += 0.5) {
        if (distance % 16 === 0) yield
        for (const side of ['start', 'end']) {
          const footprint = this._footprint(body, route, side === 'start' ? distance : route.length - distance)
          footprint.along = distance
          const key = [footprint.p.x, footprint.p.y, footprint.p.z].map(value => Math.floor(value / cell)).join(',')
          const end = ends[side]
          if (!end.grid.has(key)) end.grid.set(key, [])
          end.grid.get(key).push(footprint)
          end.points.push(footprint)
        }
      }
      samples.set(route, ends)
    }
    const compare = function* (first, second) {
        const a = this.network.routes.get(first.id), b = this.network.routes.get(second.id)
        if (a.closed || b.closed || a === b || (a.corridor && a.corridor === b.corridor)) return
        // Only this endpoint's half-lane belongs to its local conflict region.
        // The other endpoint has its own independently controlled junction.
        const grid = samples.get(a)[first.side].grid
        let processed = 0
        for (const departure of samples.get(b)[second.side].points) {
          if (processed++ % 16 === 0) yield
          const [x,y,z] = [departure.p.x, departure.p.y, departure.p.z].map(value => Math.floor(value / cell))
          for (let dx=-1;dx<=1;dx++) for (let dy=-1;dy<=1;dy++) for (let dz=-1;dz<=1;dz++) {
            for (const arrival of grid.get(`${x+dx},${y+dy},${z+dz}`) || []) {
              if (!this._footprintsOverlap(arrival, departure)) continue
              this.zones.get(a)[first.side] = Math.max(this.zones.get(a)[first.side], arrival.along + GAP + 0.5)
              this.zones.get(b)[second.side] = Math.max(this.zones.get(b)[second.side], departure.along + GAP + 0.5)
            }
          }
        }
    }.bind(this)
    for (const node of this.network.nodes.values()) {
      const ends = [...node.incoming.map(id => ({ id, side: 'end' })), ...node.outgoing.map(id => ({ id, side: 'start' }))]
      for (let a=0;a<ends.length;a++) for (let b=a+1;b<ends.length;b++) yield* compare(ends[a],ends[b])
    }
    for (const [route, zone] of this.zones) {
      if (!route.closed && zone.start + zone.end >= route.length) {
        throw new Error(`Traffic connector ${route.id} is shorter than its conflict zones; merge connectors to provide more than ${(zone.start + zone.end).toFixed(2)} m`)
      }
    }
  }

  _holdDistance(vehicle) { return this.zones.get(vehicle.route)?.end ?? vehicle.length / 2 + GAP }

  _corridorBlocked(vehicle, route, cars) {
    if (!route.corridor) return false
    const opposite = other => other?.corridor === route.corridor && other !== route
    // Retain the old direction while the last outgoing car's tail still owns
    // the endpoint, and reserve a new direction before its first car enters.
    const blocked = cars.some(other => other !== vehicle && opposite(other.route)) ||
      [...this.reservations.values()].some(reservation => reservation.vehicle !== vehicle &&
        onRoad(reservation.vehicle) && (opposite(reservation.entry) || opposite(reservation.exit)))
    if (blocked) this.blockedCorridors.add(route.corridor)
    return blocked
  }

  _corridorTurn(vehicle, route) {
    if (!route.corridor) return true
    const waiting = [...this.requests.keys()].filter(other => other !== vehicle &&
      onRoad(other) && other.nextRoute?.corridor === route.corridor && other.nextRoute !== route)
    return !waiting.some(other => !this.requests.has(vehicle) || this._requestOrder(other, vehicle) < 0)
  }

  _requestOrder(a, b) {
    return this.requests.get(a) - this.requests.get(b) ||
      b.route.priority - a.route.priority || a.id.localeCompare(b.id)
  }

  _overlaps(a, b) {
    if (a.route !== b.route) return this._physicalOverlap(a, a.route, a.distance, b)
    let distance = Math.abs(a.distance - b.distance)
    if (a.route.closed !== false) distance = Math.min(distance, a.route.length - distance)
    return distance < clearance(a, b) - 1e-8
  }

  _physicalOverlap(vehicle, route, distance, other) {
    return this._footprintsOverlap(this._collisionFootprint(vehicle, route, distance),
      this._collisionFootprint(other, other.route, other.distance))
  }

  _collisionFootprint(vehicle, route, distance) {
    let record = this.collisionFootprints.get(vehicle)
    if (!record || record.route !== route || record.distance !== distance ||
        record.length !== vehicle.length || record.width !== vehicle.width) {
      record = { ...this._footprint(vehicle, route, distance), route, distance }
      this.collisionFootprints.set(vehicle, record)
    }
    return record
  }

  _footprint(vehicle, route, distance) {
    const C = this.C, p = new C.Cartesian3(), forward = new C.Cartesian3()
    sampleTrafficRoute(C, route, distance, p, forward)
    const up = C.Cartesian3.normalize(p, new C.Cartesian3())
    const right = C.Cartesian3.normalize(C.Cartesian3.cross(up, forward, new C.Cartesian3()), new C.Cartesian3())
    return { p, forward, right, length: vehicle.length, width: vehicle.width }
  }

  _footprintsOverlap(a, b) {
    const C = this.C
    if (C.Cartesian3.distance(a.p, b.p) > (a.length + b.length + a.width + b.width) / 2 + 0.4) return false
    const delta = C.Cartesian3.subtract(b.p, a.p, new C.Cartesian3())
    for (const axis of [a.forward, a.right, b.forward, b.right]) {
      const first = Math.abs(C.Cartesian3.dot(axis, a.forward)) * a.length / 2 +
        Math.abs(C.Cartesian3.dot(axis, a.right)) * a.width / 2
      const second = Math.abs(C.Cartesian3.dot(axis, b.forward)) * b.length / 2 +
        Math.abs(C.Cartesian3.dot(axis, b.right)) * b.width / 2
      if (Math.abs(C.Cartesian3.dot(delta, axis)) >= first + second + 0.2) return false
    }
    return true
  }

  _leader(vehicle, cars) {
    let leader = null, distance = Infinity
    for (const other of cars) {
      if (other === vehicle || other.route !== vehicle.route) continue
      let ahead = other.distance - vehicle.distance
      if (vehicle.route.closed !== false && ahead <= 0) ahead += vehicle.route.length
      if (ahead >= 0 && ahead < distance) { leader = other; distance = ahead }
    }
    return { leader, available: leader ? Math.max(0, distance - clearance(vehicle, leader)) : Infinity }
  }

  _entryRoom(vehicle, route, cars) {
    let room = Infinity
    for (const other of cars) {
      if (other === vehicle || other.route !== route) continue
      room = Math.min(room, other.distance - clearance(vehicle, other))
      if (route.closed) room = Math.min(room, route.length - other.distance - clearance(vehicle, other))
    }
    return room
  }

  _releaseReservations() {
    for (const [node, reservation] of this.reservations) {
      const v = reservation.vehicle
      if (!onRoad(v) || (v.route === reservation.exit && v.distance >= (this.zones.get(reservation.exit)?.start ?? v.length / 2 + GAP))) {
        this.reservations.delete(node)
      }
    }
  }

  _nextRoute(vehicle) {
    if (vehicle.nextRoute) return vehicle.nextRoute
    const ids = this.network.successors.get(vehicle.route.id) || []
    if (!ids.length) return null
    // A stable hash and per-car visit counter keep forks reproducible across frame rates.
    let hash = 0
    for (const character of vehicle.id) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0
    vehicle.nextRoute = this.network.routes.get(ids[(hash + (vehicle.visits || 0)) % ids.length])
    return vehicle.nextRoute
  }

  _reserveJunctions(cars) {
    const eligible = new Set()
    for (const vehicle of cars) {
      if (vehicle.state !== 'driving' || vehicle.route.closed || this._leader(vehicle, cars).leader) continue
      const next = this._nextRoute(vehicle)
      const stop = vehicle.route.length - this._holdDistance(vehicle)
      if (vehicle.speed === 0 && vehicle.currentSpeed === 0 && vehicle.distance <= stop) continue
      const approach = Math.max(10, vehicle.currentSpeed ** 2 / (2 * DECELERATION) + GAP)
      if (vehicle.distance < stop - approach) continue
      eligible.add(vehicle)
      if (!this.requests.has(vehicle)) this.requests.set(vehicle, this.time)
    }
    for (const vehicle of this.requests.keys()) if (!eligible.has(vehicle)) this.requests.delete(vehicle)
    const requests = [...eligible].sort((a, b) => this._requestOrder(a, b))
    for (const vehicle of requests) {
      const node = vehicle.route.to
      if (this.reservations.has(node)) continue
      if (cars.some(other => other !== vehicle && other.route.from === node &&
        other.distance < (this.zones.get(other.route)?.start ?? other.length / 2 + GAP))) continue
      const preferred = vehicle.nextRoute
      if (!preferred) {
        if (cars.some(other => other !== vehicle && this._physicalOverlap(vehicle, vehicle.route, vehicle.route.length, other))) continue
        this.reservations.set(node, { vehicle, entry: vehicle.route, exit: null })
        continue
      }
      // A blocked preferred fork must not create a permanent circular wait
      // when another legal successor can safely release this approach.
      const alternatives = (this.network.successors.get(vehicle.route.id) || [])
        .filter(id => id !== preferred.id).map(id => this.network.routes.get(id))
      for (const exit of [preferred, ...alternatives]) {
        if (this._corridorBlocked(vehicle, exit, cars) || !this._corridorTurn(vehicle, exit)) continue
        if (this._entryRoom(vehicle, exit, cars) < (this.zones.get(exit)?.start ?? vehicle.length / 2 + GAP)) continue
        if (cars.some(other => other !== vehicle && this._physicalOverlap(vehicle, exit, 0, other))) continue
        // Another junction may already be admitting a car onto the same lane.
        if ([...this.reservations.values()].some(reservation => reservation.exit === exit)) continue
        vehicle.nextRoute = exit
        this.reservations.set(node, { vehicle, entry: vehicle.route, exit })
        break
      }
    }
  }

  _depart(vehicle, events) {
    vehicle.departedRoute = vehicle.route
    vehicle.departedPosition = this.C.Cartesian3.clone(vehicle.route.positions.at(-1))
    vehicle.state = 'waiting'
    vehicle.currentSpeed = 0
    vehicle.waitReason = 'entry'
    vehicle.nextRoute = null
    vehicle.generation++
    this.requests.delete(vehicle)
    for (const [node, reservation] of this.reservations) {
      if (reservation.vehicle === vehicle) this.reservations.delete(node)
    }
    this.totals.despawned++
    events.push({ type: 'despawn', vehicle })
  }

  _spawnWaiting(events) {
    for (const vehicle of this.vehicles) {
      if (vehicle.state !== 'waiting') continue
      const routes = this.network ? this.network.spawnRoutes.map(id => this.network.routes.get(id)) : [vehicle.homeRoute]
      for (const route of routes) {
        if (vehicle.departedRoute && route === vehicle.departedRoute) continue
        if (vehicle.departedPosition && this.C.Cartesian3.distance(route.positions[0], vehicle.departedPosition) < vehicle.length + GAP * 2) continue
        if (this.reservations.has(route.from)) continue
        if ([...this.reservations.values()].some(reservation => reservation.exit === route)) continue
        if (this._corridorBlocked(vehicle, route, this.vehicles.filter(onRoad)) || !this._corridorTurn(vehicle, route)) continue
        if (this._entryRoom(vehicle, route, this.vehicles.filter(onRoad)) < 0) continue
        if (this.vehicles.some(other => other !== vehicle && onRoad(other) && this._physicalOverlap(vehicle, route, 0, other))) continue
        vehicle.route = route
        vehicle.distance = 0
        vehicle.currentSpeed = 0
        vehicle.state = 'spawning'
        vehicle.waitReason = 'loading'
        vehicle.generation++
        this.totals.spawned++
        events.push({ type: 'spawn', vehicle })
        break
      }
    }
  }

  _step(events) {
    // Pairwise checks reuse poses within this tick, including after conflict rollback.
    this.collisionFootprints.clear()
    this.time += STEP
    const frameSnapshot = new Map(this.vehicles.map(vehicle => [vehicle, {
      route: vehicle.route, distance: vehicle.distance, state: vehicle.state, currentSpeed: vehicle.currentSpeed
    }]))
    this.blockedCorridors.clear()
    this._releaseReservations()
    const cars = this.vehicles.filter(onRoad)
    if (this.network) this._reserveJunctions(cars)
    const movements = new Map()
    for (const vehicle of cars) {
      if (vehicle.state === 'spawning') continue
      const { leader, available } = this._leader(vehicle, cars)
      let limit = available, boundaryLimit = Infinity, leaderSpeed = leader?.currentSpeed ?? 0
      vehicle.waitReason = leader ? 'following' : null
      if (this.network && !vehicle.route.closed) {
        const next = this._nextRoute(vehicle)
        const reservation = this.reservations.get(vehicle.route.to)
        if (reservation?.vehicle !== vehicle) {
          const stopRoom = Math.max(0, vehicle.route.length - this._holdDistance(vehicle) - vehicle.distance)
          boundaryLimit = stopRoom
          if (stopRoom < limit) { limit = stopRoom; leaderSpeed = 0; vehicle.waitReason = 'junction' }
        } else if (next) {
          const exitRoom = Math.max(0, this._entryRoom(vehicle, next, cars))
          boundaryLimit = vehicle.route.length - vehicle.distance + exitRoom
          limit = Math.min(limit, boundaryLimit)
        }
      }
      let desired = vehicle.speed
      if (Number.isFinite(limit)) desired = Math.min(desired,
        limit / HEADWAY, Math.sqrt(leaderSpeed ** 2 + 2 * DECELERATION * limit))
      if (limit < 0.02 && leaderSpeed === 0) desired = 0
      const speed = Math.max(0, Math.min(vehicle.currentSpeed + ACCELERATION * STEP,
        Math.max(desired, vehicle.currentSpeed - DECELERATION * STEP)))
      const move = Math.max(0, Math.min(speed * STEP, boundaryLimit))
      movements.set(vehicle, { vehicle, move, speed, leader, available })
    }
    // Solve the hard spacing limits together so a moving platoon can use the
    // space its leader clears, including a closed-loop chain and abrupt stops.
    for (let pass = 0; pass < movements.size; pass++) {
      let changed = false
      for (const movement of movements.values()) {
        if (!movement.leader) continue
        const maximum = movement.available + (movements.get(movement.leader)?.move ?? 0)
        if (movement.move > maximum) { movement.move = maximum; changed = true }
      }
      if (!changed) break
    }
    for (const { vehicle, move, speed } of movements.values()) {
      vehicle._previousTrafficRoute = vehicle.route
      vehicle._previousTrafficDistance = vehicle.distance
      vehicle.currentSpeed = move < speed * STEP - 1e-9 ? move / STEP : speed
      vehicle.distance += move
      if (vehicle.route.closed !== false) vehicle.distance %= vehicle.route.length
      else if (vehicle.distance >= vehicle.route.length - 1e-9) {
        const next = this._nextRoute(vehicle)
        if (!next) this._depart(vehicle, events)
        else {
          vehicle.distance = Math.max(0, vehicle.distance - vehicle.route.length)
          vehicle.route = next
          vehicle.nextRoute = null
          vehicle.visits = (vehicle.visits || 0) + 1
          this.requests.delete(vehicle)
        }
      }
    }
    // Roads supplied by GIS may contain crossings that were not declared as a
    // shared node. Keep the physical safety invariant even for those inputs:
    // the vehicle that advanced farther yields and retries on the next step.
    for (let pass = 0; pass < this.vehicles.length; pass++) {
      const activeAfterMove = this.vehicles.filter(onRoad)
      let repaired = false
      for (let a = 0; a < activeAfterMove.length && !repaired; a++) for (let b = a + 1; b < activeAfterMove.length; b++) {
        const first = activeAfterMove[a], second = activeAfterMove[b]
        if (!this._physicalOverlap(first, first.route, first.distance, second)) continue
        const firstMove = movements.get(first)?.move || 0, secondMove = movements.get(second)?.move || 0
        const yieldVehicle = firstMove >= secondMove ? first : second
        const snapshot = frameSnapshot.get(yieldVehicle)
        if (!snapshot) continue
        yieldVehicle.route = snapshot.route
        yieldVehicle.distance = snapshot.distance
        yieldVehicle.currentSpeed = 0
        yieldVehicle.waitReason = 'physical-conflict'
        repaired = true
        break
      }
      if (!repaired) break
    }
    for (const vehicle of this.vehicles) {
      delete vehicle._previousTrafficRoute
      delete vehicle._previousTrafficDistance
    }
    this._releaseReservations()
    this._spawnWaiting(events)
    // Spawns can occur after movement; apply the same frame-level guard to
    // the newly admitted endpoint occupants before exposing the next frame.
    for (let pass = 0; pass < this.vehicles.length; pass++) {
      const activeAfterSpawn = this.vehicles.filter(onRoad)
      let repaired = false
      for (let a = 0; a < activeAfterSpawn.length && !repaired; a++) for (let b = a + 1; b < activeAfterSpawn.length; b++) {
        const first = activeAfterSpawn[a], second = activeAfterSpawn[b]
        if (!this._physicalOverlap(first, first.route, first.distance, second)) continue
        const snapshot = frameSnapshot.get(first) || frameSnapshot.get(second)
        const yieldVehicle = snapshot === frameSnapshot.get(first) ? first : second
        if (!snapshot) continue
        yieldVehicle.route = snapshot.route; yieldVehicle.distance = snapshot.distance
        yieldVehicle.state = 'waiting'; yieldVehicle.currentSpeed = 0; yieldVehicle.waitReason = 'physical-conflict'
        repaired = true
        break
      }
      if (!repaired) break
    }
  }

  advance(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) throw new Error('Traffic simulation time must be non-negative')
    const events = []
    if (this.destroyed) return events
    this.accumulator += seconds
    while (this.accumulator + 1e-10 >= STEP) {
      this.accumulator = Math.max(0, this.accumulator - STEP)
      this._step(events)
    }
    return events
  }

  activate(vehicle) {
    if (this.destroyed || vehicle.state !== 'spawning') return
    vehicle.state = 'driving'
    vehicle.currentSpeed = 0
    vehicle.waitReason = null
  }

  getDiagnostics() {
    const count = predicate => this.vehicles.filter(predicate).length
    const activeCorridors = new Set(this.vehicles.filter(onRoad).map(v => v.route.corridor).filter(Boolean))
    for (const reservation of this.reservations.values()) {
      if (!onRoad(reservation.vehicle)) continue
      for (const route of [reservation.entry, reservation.exit]) if (route?.corridor) activeCorridors.add(route.corridor)
    }
    return { ...this.totals, waiting: count(v => v.state === 'waiting'),
      spawning: count(v => v.state === 'spawning'), following: count(v => v.waitReason === 'following'),
      junctionWaiting: count(v => v.waitReason === 'junction'), reservations: this.reservations.size,
      spawnReservations: count(v => v.state === 'spawning'), activeCorridors: activeCorridors.size,
      blockedCorridors: this.blockedCorridors.size }
  }

  destroy() {
    this.destroyed = true
    this.reservations.clear()
    this.requests.clear()
    this.zones.clear()
    this.blockedCorridors.clear()
    this.vehicles = []
    this.collisionFootprints.clear()
    this.network = null
  }
}
