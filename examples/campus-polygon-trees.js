import getEzTreeRuntime from '../vendor/cesium-ez-tree/runtime.js'

const area = ring => Math.abs(ring.reduce((sum, p, i) => {
  const next = ring[(i + 1) % ring.length]
  return sum + p.x * next.y - next.x * p.y
}, 0)) / 2

function inside([x, y], ring) {
  let result = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j]
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) result = !result
  }
  return result
}

export function buildPolygonTreeData(C, source, template) {
  if (source?.type !== 'FeatureCollection' || !Array.isArray(source.features)) {
    throw new Error('Tree polygons must be a GeoJSON FeatureCollection')
  }
  const origin = template.coordinateSystem.origin
  const modelMatrix = C.Transforms.eastNorthUpToFixedFrame(C.Cartesian3.fromDegrees(origin.longitude, origin.latitude))
  const inverse = C.Matrix4.inverseTransformation(modelMatrix, new C.Matrix4())
  const polygons = source.features.flatMap((feature, polygonIndex) => {
    const geometry = feature.geometry
    const parts = geometry?.type === 'Polygon' ? [geometry.coordinates]
      : geometry?.type === 'MultiPolygon' ? geometry.coordinates : []
    return parts.map(rings => {
      const local = rings.map(ring => {
        if (ring.length < 4) throw new Error('Tree Polygon rings require at least four coordinates')
        return ring.map(([lon, lat]) => {
          if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) {
            throw new Error('Tree polygons require WGS84 longitude/latitude coordinates')
          }
          const p = C.Matrix4.multiplyByPoint(inverse, C.Cartesian3.fromDegrees(lon, lat), new C.Cartesian3())
          return { x: p.x, y: p.y }
        })
      })
      const [outer, ...holes] = local
      return { polygonIndex, rings, outer, holes, area: Math.max(0, area(outer) - holes.reduce((sum, ring) => sum + area(ring), 0)) }
    })
  })
  if (!polygons.length) throw new Error('Tree GeoJSON contains no Polygon features')
  const totalArea = polygons.reduce((sum, polygon) => sum + polygon.area, 0)
  // Match the business scene: 35 trees/hectare, capped at 2000, with repeatable placement.
  const budget = Math.min(2000, Math.round(totalArea / 10000 * 35))
  const shares = polygons.map((polygon, index) => {
    const exact = totalArea ? budget * polygon.area / totalArea : 0
    return { index, count: Math.floor(exact), fraction: exact - Math.floor(exact) }
  })
  const ranked = [...shares].sort((a, b) => b.fraction - a.fraction || a.index - b.index)
  const remainder = budget - shares.reduce((sum, share) => sum + share.count, 0)
  for (let i = 0; i < remainder; i++) ranked[i].count++
  const runtime = getEzTreeRuntime(C), objects = [], types = Object.keys(template.typeMap)
  polygons.forEach((polygon, index) => {
    const instances = runtime.createEzTreeVegetationInstances({
      modelMatrix, polygon: { positions: polygon.outer, holes: polygon.holes },
      seed: 20260929 + index, treeCount: shares[index].count,
      grassCount: 0, flowerCount: 0, rockCount: 0
    })
    instances.forEach((instance, instanceIndex) => {
      const p = instance.translation
      const world = C.Matrix4.multiplyByPoint(modelMatrix, p, new C.Cartesian3())
      const cartographic = C.Cartographic.fromCartesian(world)
      const geographicPosition = [C.Math.toDegrees(cartographic.longitude), C.Math.toDegrees(cartographic.latitude)]
      // Reject the upstream sampler's centroid fallback against the original geographic rings.
      if (!inside(geographicPosition, polygon.rings[0]) || polygon.rings.slice(1).some(ring => inside(geographicPosition, ring))) return
      objects.push({
        type: types[objects.length % types.length], object: `polygon-tree-${index}-${instanceIndex}`,
        polygonIndex: polygon.polygonIndex, relativePosition: [p.x, p.y],
        geographicPosition
      })
    })
  })
  const points = {
    schemaVersion: 1, source: 'DS_NH_plantpolygon.json', sourceCrs: 'EPSG:4326',
    coordinateSystem: template.coordinateSystem,
    summary: { polygonCount: polygons.length, areaSquareMetres: totalArea, areaHectares: totalArea / 10000, objectCount: objects.length },
    objects
  }
  return { points, manifest: { ...template, points: 'polygon-tree-points.json', pointCount: objects.length } }
}
