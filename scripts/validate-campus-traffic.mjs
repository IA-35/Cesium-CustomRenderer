import fs from 'node:fs'
import { createRequire } from 'node:module'
import { prepareTrafficNetwork } from '../src/traffic/trafficNetwork.js'
import TrafficSimulation from '../src/traffic/TrafficSimulation.js'
const C = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')
const data = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const network = await prepareTrafficNetwork(C, data.network)
const cars = data.vehicles.map(car => ({ ...car, route: network.routes.get(car.routeId), distance: car.offset, scale: 1 }))
const started = performance.now()
const simulation = new TrafficSimulation(C, cars, network)
console.log(JSON.stringify({ nodes: network.nodes.size, lanes: network.routes.size, entries: network.spawnRoutes.length,
  initializationMs: performance.now() - started, ...simulation.getDiagnostics() }))
simulation.destroy()
