import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { createRequire } from 'node:module'
import { buildPolygonTreeData } from '../../examples/campus-polygon-trees.js'
import { validateFixedTreePoints } from '../../src/instances/fixedTreeData.js'

const C = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')
const read = file => JSON.parse(fs.readFileSync(new URL(file, import.meta.url), 'utf8'))
const source = read('../../examples/DS_NH_plantpolygon.json')
const template = read('../../assets/vegetation/ez-tree/manifest.json')

function inside([x, y], ring) {
  let result = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j]
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) result = !result
  }
  return result
}

test('surveyed polygon trees are deterministic, mixed, and strictly inside their source polygons', () => {
  const before = JSON.stringify(source), originalManifest = JSON.stringify(template)
  const built = buildPolygonTreeData(C, source, template)
  assert.deepEqual(built, buildPolygonTreeData(C, source, template))
  assert.equal(JSON.stringify(source), before)
  assert.equal(JSON.stringify(template), originalManifest)
  assert.equal(built.points.summary.polygonCount, 122)
  assert.ok(built.points.summary.areaHectares > 7 && built.points.summary.areaHectares < 9)
  assert.equal(built.points.objects.length, Math.round(built.points.summary.areaSquareMetres / 10000 * 35))
  assert.equal(built.manifest.pointCount, built.points.objects.length)
  assert.deepEqual(built.manifest.prototypes, template.prototypes)
  assert.deepEqual(built.manifest.typeMap, template.typeMap)
  assert.deepEqual([...new Set(built.points.objects.map(p => p.type))].sort(), Object.keys(template.typeMap).sort())
  validateFixedTreePoints(built.points, built.manifest.typeMap)
  for (const point of built.points.objects) {
    const feature = source.features[point.polygonIndex]
    assert.ok(inside(point.geographicPosition, feature.geometry.coordinates[0]), point.object)
    assert.ok(feature.geometry.coordinates.slice(1).every(ring => !inside(point.geographicPosition, ring)))
    const origin = built.points.coordinateSystem.origin
    const matrix = C.Transforms.eastNorthUpToFixedFrame(C.Cartesian3.fromDegrees(origin.longitude, origin.latitude))
    const local = C.Matrix4.multiplyByPoint(C.Matrix4.inverseTransformation(matrix, new C.Matrix4()),
      C.Cartesian3.fromDegrees(...point.geographicPosition), new C.Cartesian3())
    assert.ok(Math.hypot(local.x - point.relativePosition[0], local.y - point.relativePosition[1]) < 0.01)
  }
})

test('polygon sampling excludes holes and accepts MultiPolygon parts', () => {
  const outer = [[123, 41], [123.01, 41], [123.01, 41.01], [123, 41.01], [123, 41]]
  const hole = [[123.003, 41.003], [123.007, 41.003], [123.007, 41.007], [123.003, 41.007], [123.003, 41.003]]
  const data = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {},
    geometry: { type: 'MultiPolygon', coordinates: [[outer, hole]] } }] }
  const localTemplate = structuredClone(template)
  localTemplate.coordinateSystem.origin = { longitude: 123.005, latitude: 41.005 }
  const built = buildPolygonTreeData(C, data, localTemplate)
  assert.ok(built.points.objects.length > 0)
  assert.ok(built.points.objects.every(p => inside(p.geographicPosition, outer) && !inside(p.geographicPosition, hole)))
})

test('projected or missing polygon input is rejected before sampling', () => {
  assert.throws(() => buildPolygonTreeData(C, { type: 'FeatureCollection', features: [] }, template), /Polygon/)
  const data = structuredClone(source)
  data.features[0].geometry.coordinates[0][0] = [13700000, 5100000]
  assert.throws(() => buildPolygonTreeData(C, data, template), /WGS84/)
})
