// Convert the survey team's Web Mercator (EPSG:3857) grass polygons to WGS84
// (EPSG:4326) and emit a compact asset the runtime can sample directly.
//
// The source file is a plain FeatureCollection whose coordinates are metres in
// Web Mercator. Its per-feature SHAPE_Area/SHAPE_Leng come from the original
// ArcGIS feature class and are in degree units, so they are discarded here and
// recomputed: keeping them would mean shipping an attribute that contradicts the
// geometry it describes.
//
// Usage: node scripts/prepare-grass-polygons.cjs [--input <path>] [--output <path>]
const fs = require('node:fs')
const path = require('node:path')
const { toWgs84 } = require('@turf/projection')

const root = path.resolve(__dirname, '..')
const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = argv.indexOf(name)
  return index === -1 ? fallback : argv[index + 1]
}

const inputPath = path.resolve(argOf('--input', path.join(root, 'assets/grass/草地面.3857.json')))
const outputPath = path.resolve(argOf('--output', path.join(root, 'assets/grass/polygons.json')))

// Spherical ring area in square metres, via the authalic-radius approximation.
// Used only for reporting and for weighting the runtime's instance budget.
const earthRadius = 6371008.8
function ringAreaSquareMetres(ring) {
  if (ring.length < 3) return 0
  const toRadians = Math.PI / 180
  let total = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    total += (ring[i][0] - ring[j][0]) * toRadians * (2 + Math.sin(ring[i][1] * toRadians) + Math.sin(ring[j][1] * toRadians))
  }
  return Math.abs(total * earthRadius * earthRadius / 2)
}

function assertMercator(coordinates) {
  // Guard the CRS assumption instead of silently producing garbage coordinates:
  // a WGS84 longitude can never exceed 180.
  const walk = value => {
    if (typeof value[0] === 'number') {
      if (Math.abs(value[0]) > 180) return true
      return false
    }
    return value.some(walk)
  }
  if (!walk(coordinates)) throw new Error('Input does not look like EPSG:3857; a longitude exceeds 180 degrees')
}

function main() {
  if (!fs.existsSync(inputPath)) throw new Error(`Input GeoJSON not found: ${inputPath}`)
  const source = JSON.parse(fs.readFileSync(inputPath, 'utf8'))
  if (source.type !== 'FeatureCollection' || !Array.isArray(source.features)) {
    throw new Error('Input must be a GeoJSON FeatureCollection')
  }

  const polygons = []
  let totalArea = 0
  let vertexCount = 0
  let holeCount = 0

  for (const feature of source.features) {
    const geometry = feature?.geometry
    if (!geometry) continue
    if (geometry.type !== 'Polygon') throw new Error(`Unsupported geometry type: ${geometry.type}`)
    assertMercator(geometry.coordinates)

    const projected = toWgs84(feature)
    const rings = projected.geometry.coordinates
    const outer = rings[0]
    if (!Array.isArray(outer) || outer.length < 4) continue

    const holes = rings.slice(1).filter(ring => Array.isArray(ring) && ring.length >= 4)
    holeCount += holes.length

    // GeoJSON repeats the first vertex to close the ring; the samplers in
    // EzTreeVegetationInstances treat rings as implicitly closed, so drop it.
    const strip = ring => ring.slice(0, -1).map(point => [
      Number(point[0].toFixed(9)),
      Number(point[1].toFixed(9)),
    ])

    const area = Math.max(0, ringAreaSquareMetres(outer) - holes.reduce((sum, ring) => sum + ringAreaSquareMetres(ring), 0))
    totalArea += area
    vertexCount += outer.length - 1 + holes.reduce((sum, ring) => sum + ring.length - 1, 0)

    polygons.push({
      id: feature.properties?.OBJECTID ?? polygons.length + 1,
      area,
      outer: strip(outer),
      ...(holes.length ? { holes: holes.map(strip) } : {}),
    })
  }

  if (polygons.length === 0) throw new Error('No usable polygons were produced')

  // Sampling happens in local ENU metres around this origin, matching the
  // surveyed tree manifest so both datasets share one frame of reference.
  const allPoints = polygons.flatMap(polygon => polygon.outer)
  const longitude = allPoints.reduce((sum, point) => sum + point[0], 0) / allPoints.length
  const latitude = allPoints.reduce((sum, point) => sum + point[1], 0) / allPoints.length

  const output = {
    schemaVersion: 1,
    source: path.basename(inputPath),
    sourceCrs: 'EPSG:3857',
    coordinateSystem: {
      order: ['longitude', 'latitude'],
      ellipsoid: 'WGS84',
      origin: { longitude: Number(longitude.toFixed(9)), latitude: Number(latitude.toFixed(9)) },
    },
    summary: {
      polygonCount: polygons.length,
      vertexCount,
      holeCount,
      areaSquareMetres: Number(totalArea.toFixed(2)),
      areaHectares: Number((totalArea / 10000).toFixed(4)),
    },
    polygons,
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, JSON.stringify(output))
  const modelDirectory = path.join(path.dirname(outputPath), 'eztree/models')
  fs.mkdirSync(modelDirectory, { recursive: true })
  fs.copyFileSync(
    path.join(root, 'vendor/cesium-ez-tree/assets/models/grass.glb'),
    path.join(modelDirectory, 'grass.glb'),
  )

  console.log(`wrote ${path.relative(root, outputPath)}`)
  console.log(`  polygons ${output.summary.polygonCount}  vertices ${vertexCount}  holes ${holeCount}`)
  console.log(`  area ${output.summary.areaSquareMetres} m^2 (${output.summary.areaHectares} ha)`)
  console.log(`  origin ${output.coordinateSystem.origin.longitude}, ${output.coordinateSystem.origin.latitude}`)
  console.log(`  runtime ${path.relative(root, path.join(modelDirectory, 'grass.glb'))}`)
}

try {
  main()
} catch (error) {
  console.error(`[prepare-grass-polygons] ${error.message}`)
  process.exitCode = 1
}
