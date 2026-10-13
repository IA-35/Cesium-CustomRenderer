import { prepareTrafficRoutes } from './trafficRoute.js'

export async function prepareTrafficNetwork(C, data, options = {}) {
  if (data?.type !== 'FeatureCollection' || !Array.isArray(data.features) || !data.features.length) {
    throw new Error('Traffic network requires a GeoJSON FeatureCollection')
  }
  for (const feature of data.features) {
    const p = feature?.properties
    if (!p || ['from', 'to'].some(key => typeof p[key] !== 'string' || !p[key]) ||
      (p.priority !== undefined && !Number.isFinite(p.priority)) ||
      (p.spawn !== undefined && typeof p.spawn !== 'boolean') ||
      (p.corridor !== undefined && (typeof p.corridor !== 'string' || !p.corridor.trim())) ||
      (p.next !== undefined && (!Array.isArray(p.next) || p.next.some(id => typeof id !== 'string' || !id)))) {
      throw new Error(`Invalid traffic network metadata: ${feature?.id}`)
    }
  }
  const routes = await prepareTrafficRoutes(C, data, { ...options, allowOpen: true })
  const nodes = new Map(), successors = new Map()
  const endpoint = (id, position, route, incoming) => {
    let node = nodes.get(id)
    if (!node) { node = { id, position: C.Cartesian3.clone(position), incoming: [], outgoing: [] }; nodes.set(id, node) }
    if (C.Cartesian3.distance(node.position, position) > 0.01) throw new Error(`Traffic node ${id} has inconsistent endpoints`)
    node[incoming ? 'incoming' : 'outgoing'].push(route.id)
  }
  for (const feature of data.features) {
    const route = routes.get(feature.id), p = feature.properties
    Object.assign(route, { from: p.from, to: p.to, priority: p.priority ?? 0 })
    if (p.corridor !== undefined) route.corridor = p.corridor
    if (route.closed !== (route.from === route.to)) throw new Error(`Traffic lane ${route.id} has inconsistent closed-node topology`)
    endpoint(route.from, route.positions[0], route, false)
    endpoint(route.to, route.positions.at(-1), route, true)
  }
  const corridors = new Map()
  for (const route of routes.values()) {
    if (!route.corridor) continue
    if (!corridors.has(route.corridor)) corridors.set(route.corridor, [])
    corridors.get(route.corridor).push(route)
  }
  for (const [id, lanes] of corridors) {
    const [a, b] = lanes
    if (lanes.length !== 2 || a.closed || b.closed || a.from !== b.to || a.to !== b.from ||
      a.positions.length !== b.positions.length || a.positions.some((position, i) =>
        C.Cartesian3.distance(position, b.positions[b.positions.length - 1 - i]) > 0.01)) {
      throw new Error(`Traffic corridor ${id} requires two reverse lanes on the same centreline`)
    }
  }
  for (const feature of data.features) {
    const route = routes.get(feature.id)
    const ids = feature.properties.next ?? nodes.get(route.to).outgoing
    for (const id of ids) {
      if (!routes.has(id) || routes.get(id).from !== route.to) throw new Error(`Invalid next lane ${id} from ${route.id}`)
    }
    successors.set(route.id, [...new Set(ids)].filter(id => {
      const next = routes.get(id)
      return next.to !== route.from || (next.closed && next.id === route.id)
    }).sort())
  }
  for (const node of nodes.values()) {
    const incident = [...new Set([...node.incoming, ...node.outgoing])].map(id => routes.get(id))
    if (incident.some(route => route.closed) && incident.length > 1) {
      throw new Error(`Traffic node ${node.id} shares a closed loop with other lanes; split the loop into open directed lanes`)
    }
  }
  const explicit = data.features.filter(feature => feature.properties.spawn === true).map(feature => feature.id)
  const spawnRoutes = (explicit.length ? explicit : [...routes.values()]
    .filter(route => !nodes.get(route.from).incoming.length).map(route => route.id)).sort()
  if (!spawnRoutes.length) throw new Error('Traffic network requires viable spawn entries; mark entry lanes with spawn:true')
  return { routes, nodes, successors, spawnRoutes }
}
