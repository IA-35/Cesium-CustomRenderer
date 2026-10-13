#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const proj4 = require('proj4')

const root = path.resolve(__dirname, '..')
const SOURCE_CRS = 'EPSG:4550'
const TARGET_CRS = 'EPSG:4326'
const SOURCE_PROJ4 = '+proj=tmerc +lat_0=0 +lon_0=123 +k=1 +x_0=500000 +y_0=0 +ellps=GRS80 +units=m +no_defs'
const WATER_SCALE = 1.06
const WATER_HEIGHTS = Object.freeze({ 2: 0.6, 3: 0.85 })

function cgcs2000ToWgs84(coordinate) {
  if (!Array.isArray(coordinate) || coordinate.length < 2 || !coordinate.slice(0, 2).every(Number.isFinite)) {
    throw new Error('Water coordinates must contain finite UTM easting and northing')
  }
  return proj4(SOURCE_PROJ4, TARGET_CRS, coordinate.slice(0, 2))
}

function ringArea(ring) {
  let twiceArea = 0
  for (let index = 0; index < ring.length - 1; index++) {
    twiceArea += ring[index][0] * ring[index + 1][1] - ring[index + 1][0] * ring[index][1]
  }
  return Math.abs(twiceArea) * 0.5
}

function ringCentroid(ring) {
  const points = ring.slice(0, -1)
  return points.reduce((sum, point) => [sum[0] + point[0] / points.length, sum[1] + point[1] / points.length], [0, 0])
}

function scaleRing(ring, center, scale) {
  return ring.map(point => [
    center[0] + (point[0] - center[0]) * scale,
    center[1] + (point[1] - center[1]) * scale,
  ])
}

function validateRing(ring, featureId) {
  if (!Array.isArray(ring) || ring.length < 4) throw new Error(`Water feature ${featureId} has an invalid ring`)
  const first = ring[0]
  const last = ring.at(-1)
  if (first[0] !== last[0] || first[1] !== last[1]) throw new Error(`Water feature ${featureId} ring is not closed`)
  ring.forEach(cgcs2000ToWgs84)
  return ring
}

function prepareWaterPolygons({ input, output }) {
  const inputPath = path.resolve(root, input)
  const outputPath = path.resolve(root, output)
  const source = JSON.parse(fs.readFileSync(inputPath, 'utf8'))
  if (source.type !== 'FeatureCollection' || !Array.isArray(source.features)) {
    throw new Error('Water source must be a GeoJSON FeatureCollection')
  }

  let areaSquareMetres = 0
  let pointCount = 0
  const features = source.features.map((feature, index) => {
    const featureId = feature.properties?.OBJECTID ?? index + 1
    const height = WATER_HEIGHTS[featureId]
    if (!Number.isFinite(height)) throw new Error(`Water feature ${featureId} has no configured height`)
    if (feature.geometry?.type !== 'Polygon') throw new Error(`Water feature ${featureId} must be a Polygon`)
    const rings = feature.geometry.coordinates.map(ring => validateRing(ring, featureId))
    const center = ringCentroid(rings[0])
    const scaledRings = rings.map(ring => scaleRing(ring, center, WATER_SCALE))
    areaSquareMetres += ringArea(scaledRings[0]) - scaledRings.slice(1).reduce((sum, ring) => sum + ringArea(ring), 0)
    pointCount += scaledRings.reduce((sum, ring) => sum + ring.length, 0)
    return {
      id: `water-${featureId}`,
      geometry: { type: 'Polygon', coordinates: scaledRings.map(ring => ring.map(cgcs2000ToWgs84)) },
      properties: { objectId: featureId, height, scale: WATER_SCALE },
    }
  })

  const prepared = {
    schemaVersion: 1,
    source: path.basename(inputPath),
    sourceCrs: SOURCE_CRS,
    targetCrs: TARGET_CRS,
    summary: { featureCount: features.length, pointCount, areaSquareMetres: Number(areaSquareMetres.toFixed(3)) },
    features,
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, `${JSON.stringify(prepared, null, 2)}\n`)
  return prepared
}

function parseArgs(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, '')
    if (!key || !argv[index + 1]) throw new Error(`Missing value for ${argv[index] || 'argument'}`)
    result[key] = argv[index + 1]
  }
  return result
}

if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2))
    const result = prepareWaterPolygons({
      input: options.input || 'assets/水面.json',
      output: options.output || 'assets/water/polygons.json',
    })
    console.log(JSON.stringify(result.summary))
  } catch (error) {
    console.error(error.stack || error.message)
    process.exitCode = 1
  }
}

module.exports = { prepareWaterPolygons, cgcs2000ToWgs84 }
