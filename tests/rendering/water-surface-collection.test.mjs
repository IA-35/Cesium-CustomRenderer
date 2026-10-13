import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'
import { createWaterSurfaceCollection } from '../../src/instances/WaterSurfaceCollection.js'

const require = createRequire(import.meta.url)
const { prepareWaterPolygons, cgcs2000ToWgs84 } = require('../../scripts/prepare-water-polygons.cjs')

test('converts the supplied CGCS2000 Gauss-Kruger polygons to the Nanhu campus', t => {
  const [longitude, latitude] = cgcs2000ToWgs84([534353.1654559544, 4625457.601857945])
  assert.ok(Math.abs(longitude - 123.414) < 0.01)
  assert.ok(Math.abs(latitude - 41.7636) < 0.001)

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-water-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const output = path.join(directory, 'polygons.json')
  const prepared = prepareWaterPolygons({ input: 'assets/水面.json', output })
  assert.equal(prepared.schemaVersion, 1)
  assert.equal(prepared.sourceCrs, 'EPSG:4550')
  assert.equal(prepared.features.length, 2)
  assert.ok(prepared.summary.areaSquareMetres > 700)
  assert.deepEqual(prepared.features.map(feature => feature.properties.height), [0.6, 0.85])
  assert.ok(prepared.features.every(feature => feature.properties.scale === 1.06))
  for (const feature of prepared.features) {
    assert.ok(feature.id)
    assert.equal(feature.geometry.type, 'Polygon')
    for (const ring of feature.geometry.coordinates) {
      assert.ok(ring.length >= 4)
      assert.deepEqual(ring[0], ring.at(-1))
      assert.ok(ring.every(([lon, lat]) => lon > 123 && lon < 124 && lat > 41 && lat < 42))
    }
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), prepared)
})

function harness() {
  const added = []; const removed = []
  class Color {
    constructor(red, green, blue, alpha) { Object.assign(this, { red, green, blue, alpha }) }
  }
  class Cartesian3 {
    constructor(longitude = 0, latitude = 0, height = 0) { Object.assign(this, { longitude, latitude, height }) }
    static fromDegrees(longitude, latitude, height = 0) { return new Cartesian3(longitude, latitude, height) }
    static fromDegreesArrayHeights(values) {
      return Array.from({ length: values.length / 3 }, (_, i) => new Cartesian3(...values.slice(i * 3, i * 3 + 3)))
    }
  }
  class Cartographic {
    static fromDegrees(longitude, latitude) { return { longitude, latitude, height: 0 } }
  }
  class PolygonHierarchy { constructor(positions, holes = []) { Object.assign(this, { positions, holes }) } }
  class PolygonGeometry { constructor(options) { Object.assign(this, options) } }
  class GeometryInstance { constructor(options) { Object.assign(this, options) } }
  class Primitive { constructor(options) { Object.assign(this, options); this.show = options.show; this.ready = true } }
  class MaterialAppearance {
    static MaterialSupport = { ALL: { vertexFormat: 'all' } }
    constructor(options) { Object.assign(this, options) }
  }
  const Cesium = {
    Color, Cartesian3, Cartographic, PolygonHierarchy, PolygonGeometry, GeometryInstance, Primitive, MaterialAppearance,
    Material: { fromType(type, uniforms) { return { type, uniforms } } },
    buildModuleUrl(value) { return `/cesium/${value}` },
  }
  const scene = {
    sampleHeight() { throw new Error('fixed water must not call sampleHeight') },
    primitives: { add(value) { added.push(value); return value }, remove(value) { removed.push(value); return true } },
    requestRender() {},
  }
  return { Cesium, viewer: { scene }, added, removed }
}

test('renders dynamic standard Water at per-feature fixed heights without ground sampling', async () => {
  const h = harness()
  const data = {
    schemaVersion: 1,
    sourceCrs: 'EPSG:4550', targetCrs: 'EPSG:4326',
    features: [
      { id: 'water-1', properties: { height: 0.6 }, geometry: { type: 'Polygon', coordinates: [[[123.41, 41.76], [123.411, 41.76], [123.411, 41.761], [123.41, 41.76]]] } },
      { id: 'water-2', properties: { height: 0.85 }, geometry: { type: 'Polygon', coordinates: [[[123.414, 41.764], [123.415, 41.764], [123.415, 41.765], [123.414, 41.764]]] } },
    ],
  }
  const water = createWaterSurfaceCollection({
    Cesium: h.Cesium, viewer: h.viewer, dataUrl: 'https://example.test/water.json',
    fetchJson: async () => structuredClone(data),
  })
  await water.readyPromise

  assert.equal(h.added.length, 1)
  assert.equal(water.primitive.geometryInstances.length, 2)
  const heights = water.primitive.geometryInstances.map(instance => instance.geometry.polygonHierarchy.positions[0].height)
  assert.deepEqual(heights, [0.6, 0.85])
  assert.equal(water.primitive.appearance.materialSupport, h.Cesium.MaterialAppearance.MaterialSupport.ALL)
  assert.equal(water.primitive.appearance.material.type, 'Water')
  const uniforms = water.primitive.appearance.material.uniforms
  assert.match(uniforms.normalMap, /waterNormalsSmall\.jpg$/)
  assert.ok(uniforms.animationSpeed > 0)
  assert.ok(uniforms.frequency > 0 && uniforms.amplitude > 0 && uniforms.specularIntensity > 0)
  assert.equal(water.getDiagnostics().features, 2)
  assert.equal(water.getDiagnostics().heightMode, 'per-feature-fixed')
  assert.equal(water.getDiagnostics().minimumHeight, 0.6)
  assert.equal(water.getDiagnostics().maximumHeight, 0.85)

  water.setVisible(false)
  assert.equal(water.primitive.show, false)
  water.destroy(); water.destroy()
  assert.equal(h.removed.length, 1)
  assert.equal(water.getDiagnostics().state, 'destroyed')
})

test('campus loads prepared water by default with an explicit opt-out and diagnostics', () => {
  const source = fs.readFileSync(new URL('../../examples/campus.js', import.meta.url), 'utf8')
  assert.match(source, /const waterEnabled = !\['0', 'none'\]\.includes\(waterParam\)/)
  assert.match(source, /createWaterSurfaceCollection\(/)
  assert.match(source, /window\.campus\.waterReady = loadWater\(\)/)
  assert.match(source, /\?water=none/)
  assert.match(source, /water\?\.destroy\(\)/)
})
