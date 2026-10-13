// Example-only adaptation: survey the campus ground, preserving road topology
// and horizontal coordinates. The renderer SDK keeps its strict height contract.
export async function prepareCampusTraffic(C, scene, data, manifestUrl, objectsToExclude = [], options = {}) {
  if (typeof scene.clampToHeightMostDetailed !== 'function') throw new Error('Campus ground height sampling is not supported')
  const prepared = structuredClone(data)
  const features = (prepared.network || prepared.routes)?.features
  if (!Array.isArray(features) || !features.length) throw new Error('Campus traffic requires road lines')
  const samples = new Map(), roads = [], spacing = options.spacing ?? 10
  const key = point => `${point[0].toFixed(9)},${point[1].toFixed(9)}`
  const check = () => { if (options.isCancelled?.()) throw new Error('Campus traffic placement cancelled') }
  check()
  for (const feature of features) {
    const coordinates = feature.geometry.coordinates, distances = [0], anchors = []
    for (let index = 1; index < coordinates.length; index++) {
      distances.push(distances[index - 1] + C.Cartesian3.distance(C.Cartesian3.fromDegrees(...coordinates[index - 1]),
        C.Cartesian3.fromDegrees(...coordinates[index])))
    }
    let previous = -Infinity
    for (let index = 0; index < coordinates.length; index++) {
      if (index !== coordinates.length - 1 && distances[index] - previous < spacing) continue
      const point = coordinates[index], id = key(point)
      if (!samples.has(id)) samples.set(id, { point, position: C.Cartesian3.fromDegrees(...point), height: undefined })
      anchors.push({ index, distance: distances[index], sample: samples.get(id) })
      previous = distances[index]
    }
    roads.push({ coordinates, distances, anchors })
  }
  const all = [...samples.values()]
  for (let index = 0; index < all.length; index += 128) {
    check()
    const batch = all.slice(index, index + 128)
    const grounded = await scene.clampToHeightMostDetailed(batch.map(sample => C.Cartesian3.clone(sample.position)), objectsToExclude)
    check()
    for (let i = 0; i < batch.length; i++) {
      if (!grounded?.[i]) continue
      const height = C.Cartographic.fromCartesian(grounded[i])?.height
      if (Number.isFinite(height)) batch[i].height = height
    }
  }
  const valid = all.filter(sample => Number.isFinite(sample.height)), missing = all.filter(sample => !Number.isFinite(sample.height))
  if (!valid.length) throw new Error('No campus ground height could be surveyed')
  const measured = new Set(valid)
  // Shared junction samples get a single estimate across all adjacent roads.
  for (const road of roads) {
    for (let i = 0; i < road.anchors.length; i++) {
      const anchor = road.anchors[i]
      if (measured.has(anchor.sample)) continue
      let before = i - 1, after = i + 1
      while (before >= 0 && !measured.has(road.anchors[before].sample)) before--
      while (after < road.anchors.length && !measured.has(road.anchors[after].sample)) after++
      if (before < 0 || after >= road.anchors.length) continue
      const a = road.anchors[before], b = road.anchors[after], span = b.distance - a.distance
      if (!anchor.sample.estimate || span < anchor.sample.estimate.span) {
        anchor.sample.estimate = { span, height: a.sample.height +
          (b.sample.height - a.sample.height) * (anchor.distance - a.distance) / span }
      }
    }
  }
  let nearestFallbackSamples = 0, maximumFallbackDistance = 0, interpolatedVertices = 0
  for (const sample of missing) {
    if (sample.estimate) { sample.height = sample.estimate.height; continue }
    let nearest = valid[0], distance = Infinity
    for (const candidate of valid) {
      const current = C.Cartesian3.distanceSquared(sample.position, candidate.position)
      if (current < distance) { nearest = candidate; distance = current }
    }
    sample.height = nearest.height
    nearestFallbackSamples++
    maximumFallbackDistance = Math.max(maximumFallbackDistance, Math.sqrt(distance))
  }
  for (const road of roads) {
    let segment = 0
    for (let index = 0; index < road.coordinates.length; index++) {
      while (segment + 1 < road.anchors.length - 1 && road.anchors[segment + 1].index < index) segment++
      const a = road.anchors[segment], b = road.anchors[Math.min(segment + 1, road.anchors.length - 1)]
      const ratio = b.distance > a.distance ? (road.distances[index] - a.distance) / (b.distance - a.distance) : 0
      road.coordinates[index][2] = a.sample.height + (b.sample.height - a.sample.height) * ratio + .03
      const sample = samples.get(key(road.coordinates[index]))
      if (!sample || !measured.has(sample)) interpolatedVertices++
    }
  }
  for (const vehicle of prepared.vehicles) vehicle.url = new URL(vehicle.url, manifestUrl).href
  prepared.placement = { groundSamples: all.length, measuredSamples: valid.length, missingSamples: missing.length,
    interpolatedVertices, nearestFallbackSamples, maximumFallbackDistance,
    minimumGroundHeight: Math.min(...valid.map(sample => sample.height)), maximumGroundHeight: Math.max(...valid.map(sample => sample.height)),
    heightOffset: .03, spacing }
  check()
  return prepared
}
