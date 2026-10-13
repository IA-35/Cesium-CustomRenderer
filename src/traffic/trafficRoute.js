// WGS84 input is compiled once; animation samples distance in ECEF metres.
function compileRoute(C, id, positions, allowOpen = false) {
  const points = positions.filter((point, index) => index === 0 || C.Cartesian3.distance(point, positions[index - 1]) > 1e-6)
  if (points.length < 2) throw new Error(`Traffic route ${id} requires a non-degenerate line`)
  const closed = C.Cartesian3.distance(points[0], points.at(-1)) <= 0.01
  if (!allowOpen && !closed) throw new Error(`Traffic route ${id} must be closed`)
  if (closed && (points.length < 4 || new Set(points.slice(0, -1).map(point => `${point.x},${point.y},${point.z}`)).size < 3)) {
    throw new Error(`Traffic route ${id} requires three distinct vertices`)
  }
  if (closed) points[points.length - 1] = C.Cartesian3.clone(points[0])
  const distances = [0]
  for (let i = 1; i < points.length; i++) distances.push(distances[i - 1] + C.Cartesian3.distance(points[i - 1], points[i]))
  return { id, positions: points, distances, length: distances.at(-1), closed,
    before: new C.Cartesian3(), after: new C.Cartesian3() }
}

export function prepareTrafficRoutes(C, data, options = {}) {
  if (data?.type !== 'FeatureCollection' || !Array.isArray(data.features) || !data.features.length) {
    throw new Error('Traffic routes require a GeoJSON FeatureCollection')
  }
  const input = new Map()
  for (const feature of data.features) {
    const id = feature?.id
    if (typeof id !== 'string' || !id || feature.type !== 'Feature' || feature.geometry?.type !== 'LineString') {
      throw new Error('Traffic route requires a string id and LineString geometry')
    }
    if (input.has(id)) throw new Error(`Duplicate traffic route: ${id}`)
    const coordinates = feature.geometry.coordinates
    if (!Array.isArray(coordinates) || coordinates.length < (options.allowOpen ? 2 : 4)) throw new Error(`Invalid traffic route: ${id}`)
    const positions = coordinates.map(point => {
      if (!Array.isArray(point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1]) ||
        Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90 ||
        (point[2] !== undefined && !Number.isFinite(point[2])) ||
        (!options.clampToGround && !Number.isFinite(point[2]))) throw new Error(`Invalid coordinate or height in traffic route ${id}`)
      return C.Cartesian3.fromDegrees(point[0], point[1], point[2] ?? 0)
    })
    // Validate closure before issuing any height requests.
    compileRoute(C, id, positions, options.allowOpen)
    input.set(id, positions)
  }
  const compile = () => new Map([...input].map(([id, points]) => [id, compileRoute(C, id, points, options.allowOpen)]))
  if (!options.clampToGround) return compile()
  return (async () => {
    if (typeof options.scene?.clampToHeightMostDetailed !== 'function') throw new Error('Traffic road height sampling is not supported')
    for (const [id, points] of input) {
      const grounded = await options.scene.clampToHeightMostDetailed(points, options.objectsToExclude || [])
      if (!grounded || grounded.length !== points.length || grounded.some(point => !point ||
        ![point.x, point.y, point.z].every(Number.isFinite))) throw new Error(`Traffic road height sampling failed: ${id}`)
      input.set(id, grounded)
    }
    return compile()
  })()
}

function positionAt(C, route, distance, result) {
  const along = route.closed === false ? Math.max(0, Math.min(route.length, distance))
    : ((distance % route.length) + route.length) % route.length
  let low = 0, high = route.distances.length - 1
  while (low + 1 < high) {
    const middle = (low + high) >> 1
    if (route.distances[middle] <= along) low = middle
    else high = middle
  }
  return C.Cartesian3.lerp(route.positions[low], route.positions[low + 1],
    (along - route.distances[low]) / (route.distances[low + 1] - route.distances[low]), result)
}

export function sampleTrafficRoute(C, route, distance, position, direction) {
  const along = route.closed === false ? Math.max(0, Math.min(route.length, distance)) : distance
  positionAt(C, route, along, position)
  const ahead = Math.min(1, route.length * 0.01)
  positionAt(C, route, along - ahead, route.before)
  positionAt(C, route, along + ahead, route.after)
  C.Cartesian3.subtract(route.after, route.before, direction)
  if (C.Cartesian3.magnitudeSquared(direction) < 1e-12) C.Cartesian3.subtract(route.after, position, direction)
  C.Cartesian3.normalize(direction, direction)
  return position
}
