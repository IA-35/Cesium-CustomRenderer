import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {execFileSync} from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createGrassCollection } from '../../src/instances/GrassCollection.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')

const require = createRequire(import.meta.url)
const { toWgs84, toMercator } = require('@turf/projection')

function preparedFixture(t) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ccr-grass-'))
  t.after(()=>{const relative=path.relative(os.tmpdir(),directory);assert.ok(relative.startsWith('ccr-grass-')&&!relative.includes(path.sep));fs.rmSync(directory,{recursive:true,force:true})})
  const source=toMercator({type:'FeatureCollection',features:[{type:'Feature',properties:{OBJECTID:1,SHAPE_Area:1},geometry:{type:'Polygon',coordinates:[[
    [123.410,41.760],[123.414,41.760],[123.414,41.7638],[123.410,41.7638],[123.410,41.760]
  ]]}}]})
  const input=path.join(directory,'source.json'),outputPath=path.join(directory,'polygons.json')
  fs.writeFileSync(input,JSON.stringify(source))
  execFileSync(process.execPath,[path.join(root,'scripts/prepare-grass-polygons.cjs'),'--input',input,'--output',outputPath])
  return {source,output:JSON.parse(fs.readFileSync(outputPath,'utf8')),directory}
}

test('campus example enables prepared vegetation by default and keeps explicit opt-outs', () => {
  const source = fs.readFileSync(path.join(root, 'examples/campus.js'), 'utf8')
  assert.match(source, /const treeEnabled = !\['0', 'none'\]\.includes\(treeParam\)/)
  assert.match(source, /if \(treeEnabled\) \{[\s\S]*window\.campus\.treeReady = loadTrees\(\)/)
  assert.match(source, /\?trees=none/)
  assert.match(source, /const grassEnabled = !\['0', 'none'\]\.includes\(grassParam\)/)
  assert.match(source, /if \(grassEnabled\) \{[\s\S]*window\.campus\.grassReady = loadGrass\(\)/)
  assert.match(source, /\?grass=none/)
})

test('prepare-grass-polygons converts EPSG:3857 rings to WGS84 and recomputes area', t => {
  const {source,output,directory}=preparedFixture(t)

  assert.equal(output.schemaVersion, 1)
  assert.equal(output.sourceCrs, 'EPSG:3857')
  assert.equal(output.summary.polygonCount, source.features.length)
  assert.equal(output.polygons.length, source.features.length)
  assert.ok(fs.existsSync(path.join(directory, 'eztree/models/grass.glb')),
    'prepared grass runtime asset must be deployed beside polygons.json')

  // Every emitted coordinate must be a valid WGS84 pair, not a Mercator metre value.
  for (const polygon of output.polygons) {
    assert.ok(polygon.outer.length >= 3)
    for (const [longitude, latitude] of polygon.outer) {
      assert.ok(longitude > -180 && longitude < 180, `longitude out of range: ${longitude}`)
      assert.ok(latitude > -90 && latitude < 90, `latitude out of range: ${latitude}`)
    }
  }

  // Spot-check one full ring against an independent turf round trip.
  const first = source.features[0]
  const expected = toWgs84({
    type: 'Feature', properties: {},
    geometry: { type: 'LineString', coordinates: first.geometry.coordinates[0] },
  }).geometry.coordinates
  const produced = output.polygons[0].outer
  assert.equal(produced.length, expected.length - 1, 'closing vertex must be dropped')
  for (let i = 0; i < produced.length; i++) {
    assert.ok(Math.abs(produced[i][0] - expected[i][0]) < 1e-8, `longitude drift at ${i}`)
    assert.ok(Math.abs(produced[i][1] - expected[i][1]) < 1e-8, `latitude drift at ${i}`)
  }
})

test('converted polygons keep the known fixture metric area', t => {
  const {output}=preparedFixture(t)
  // Recomputed from the source metres; guards against a projection that silently
  // rescales or mirrors the dataset.
  assert.ok(output.summary.areaSquareMetres > 130000 && output.summary.areaSquareMetres < 150000,
    `area out of expected range: ${output.summary.areaSquareMetres}`)
  assert.ok(output.summary.areaHectares > 13 && output.summary.areaHectares < 15)
  assert.ok(output.polygons.every(polygon => polygon.area > 0))
})

test('converted origin stays inside the supplied polygon bounds', t => {
  const {output}=preparedFixture(t)
  const longitude=123.412,latitude=41.7619
  const origin = output.coordinateSystem.origin
  // ~0.01 degrees is about 1 km; the two datasets describe the same campus.
  assert.ok(Math.abs(origin.longitude - longitude) < 0.01)
  assert.ok(Math.abs(origin.latitude - latitude) < 0.01)
})

function harness(polygonData, options = {}) {
  const C = options.Cesium
  const instancesSeen = []
  const runtime = {
    configureEzTree() {},
    createEzTreeVegetationInstances(request) {
      instancesSeen.push(request)
      // Emit one turret per requested instance at the polygon centroid, keeping
      // the contract the real sampler provides.
      const ring = request.polygon.positions
      const cx = ring.reduce((sum, p) => sum + p[0], 0) / ring.length
      const cy = ring.reduce((sum, p) => sum + p[1], 0) / ring.length
      const out = []
      for (let i = 0; i < (request.grassCount || 0); i++) {
        out.push({
          kind: 'grass',
          translation: new C.Cartesian3(cx + i * 0.01, cy, 0),
          scale: new C.Cartesian3(1, 1, 1),
          rotation: 0,
          windPhase: 0.5,
          color: new C.Color(0.4, 0.6, 0.2, 1),
        })
      }
      return out
    },
    EzTreePrimitive: class {
      static loadPreset() { return { branch: { children: {}, sections: {}, segments: {} }, leaves: {} } }
      constructor(o) {
        Object.assign(this, o)
        this._instances = o.instances
        this._externalLodGroups = new Map()
        this._submittedRecords = []
        this._resources = {
          pendingTextureCount: 0, gltfRecordsBuilt: true, cachedCommandCount: options.cachedCommandCount ?? 1,
          gltfAssetRecords: [], barkTextureRecords: new Map(), meshResources: [], records: [],
          meshGpuMemoryBytes: 0, instanceGpuMemoryBytes: 0,
        }
      }
      destroy() { this.dead = true }
    },
  }
  return { runtime, instancesSeen }
}

function makeCesium() {
  class Cartesian3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z }
    static fromDegrees(longitude, latitude, height = 0) { return new Cartesian3(longitude, latitude, height) }
    static clone(v) { return new Cartesian3(v.x, v.y, v.z) }
  }
  class Matrix4 {
    static inverseTransformation() { return {} }
    static inverse(m, r) { return r || {} }
    static multiplyByPoint(_m, p, r) { Object.assign(r, p); return r }
  }
  return {
    Cartesian3, Matrix4,
    Color: class Color {
      constructor(red = 1, green = 1, blue = 1, alpha = 1) { this.red = red; this.green = green; this.blue = blue; this.alpha = alpha }
    },
    Transforms: { eastNorthUpToFixedFrame(o) { return { o } } },
  }
}

test('places grass inside each polygon and reports diagnostics', async () => {
  const C = makeCesium()
  const polygons = {
    schemaVersion: 1,
    coordinateSystem: { origin: { longitude: 123.4122, latitude: 41.763 } },
    summary: { areaHectares: 2 },
    polygons: [
      { id: 1, area: 15000, outer: [[123.410, 41.760], [123.414, 41.760], [123.414, 41.764], [123.410, 41.764]] },
      { id: 2, area: 5000, outer: [[123.420, 41.760], [123.421, 41.760], [123.421, 41.761], [123.420, 41.761]] },
    ],
  }
  const h = harness(polygons, { Cesium: C })
  const scene = {
    primitives: { add(m) { return m }, remove() { return true } },
    postRender: { addEventListener(fn) { listeners.push(fn); return () => {} } },
    requestRender() {},
  }
  const listeners = []
  const collection = createGrassCollection({
    Cesium: C, viewer: { scene }, polygonsUrl: 'https://example.test/grass/polygons.json',
    ezTreeRuntime: h.runtime, maxInstances: 100,
    fetchJson: async () => structuredClone(polygons),
  })
  await new Promise(resolve => setTimeout(resolve, 0))
  listeners.slice().forEach(fn => fn())
  await collection.readyPromise

  // One sampler call per polygon, not one call for the whole dataset.
  assert.equal(h.instancesSeen.length, 2)
  assert.ok(h.instancesSeen.every(request => request.treeCount === 0 && request.flowerCount === 0 && request.rockCount === 0))
  // The larger patch must receive the larger share of the budget.
  assert.ok(h.instancesSeen[0].grassCount > h.instancesSeen[1].grassCount)

  const diagnostics = collection.getDiagnostics()
  assert.equal(diagnostics.backend, 'cesium-ez-tree')
  assert.equal(diagnostics.source, 'grass')
  assert.equal(diagnostics.state, 'ready')
  assert.equal(diagnostics.polygons, 2)
  assert.equal(diagnostics.primitiveCount, 1)
  assert.equal(diagnostics.instances, h.instancesSeen.reduce((sum, r) => sum + r.grassCount, 0))
  assert.equal(diagnostics.heightMode, 'fixed')
  assert.equal(diagnostics.height, 3)
  assert.ok(collection.primitive._instances.every(instance => instance.translation.z === 3))
  assert.equal(diagnostics.groundFallbacks, 0)
  assert.equal(collection.primitive.kind, undefined)
  collection.destroy()
  assert.equal(collection.destroyed, true)
  assert.equal(collection.getDiagnostics().state, 'destroyed')
})

test('uses the upstream density scale and never calls scene clamping', async () => {
  const C = makeCesium()
  const polygons = {
    schemaVersion: 1,
    coordinateSystem: { origin: { longitude: 123.4122, latitude: 41.763 } },
    summary: { areaHectares: 1 },
    polygons: [{ id: 1, area: 10000, outer: [[123.410, 41.760], [123.414, 41.760], [123.414, 41.764], [123.410, 41.764]] }],
  }
  const h = harness(polygons, { Cesium: C })
  let clampCalls = 0
  const listeners = []
  const scene = {
    primitives: { add(m) { return m }, remove() { return true } },
    postRender: { addEventListener(fn) { listeners.push(fn); return () => {} } },
    requestRender() {},
    async clampToHeightMostDetailed() { clampCalls++; throw new Error('must not be called') },
  }
  const collection = createGrassCollection({
    Cesium: C, viewer: { scene }, polygonsUrl: 'https://example.test/grass/polygons.json',
    ezTreeRuntime: h.runtime, fetchJson: async () => structuredClone(polygons),
  })
  await new Promise(resolve => setTimeout(resolve, 0))
  listeners.slice().forEach(fn => fn())
  await collection.readyPromise
  assert.equal(clampCalls, 0)
  assert.equal(h.instancesSeen[0].grassCount, 450)
  assert.equal(collection.density, 0.045)
})

test('assigns the two host GLBs in a stable 50/50 mix with authored scale correction', async () => {
  const C = makeCesium()
  const polygons = {
    schemaVersion: 1,
    coordinateSystem: { origin: { longitude: 123.4122, latitude: 41.763 } },
    summary: { areaHectares: 1 },
    polygons: [{ id: 1, area: 10000, outer: [[123.410, 41.760], [123.414, 41.760], [123.414, 41.764], [123.410, 41.764]] }],
  }
  const create = async () => {
    const h = harness(polygons, { Cesium: C })
    const listeners = []
    const scene = {
      primitives: { add(m) { return m }, remove() { return true } },
      postRender: { addEventListener(fn) { listeners.push(fn); return () => {} } },
      requestRender() {},
    }
    const collection = createGrassCollection({
      Cesium: C, viewer: { scene }, polygonsUrl: 'https://example.test/grass/polygons.json',
      ezTreeRuntime: h.runtime, maxInstances: 100, fetchJson: async () => structuredClone(polygons),
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    listeners.slice().forEach(fn => fn())
    await collection.readyPromise
    return collection
  }
  const first = await create()
  assert.deepEqual(first.primitive.grassAssets.map(asset => asset.id), ['grass-10', 'grass-17'])
  assert.deepEqual(first.primitive.grassAssets.map(asset => asset.url), [
    'https://example.test/grass/grass-10.glb',
    'https://example.test/grass/grass-17.glb',
  ])
  const counts = Object.groupBy(first.primitive._instances, instance => instance.asset)
  assert.equal(counts['grass-10'].length, 50)
  assert.equal(counts['grass-17'].length, 50)
  assert.ok(counts['grass-10'].every(instance => Math.abs(instance.scale.x - 1.0734813213348389) < 1e-8))
  assert.ok(counts['grass-17'].every(instance => instance.scale.x === 1))
  const assignment = first.primitive._instances.map(instance => instance.asset)
  const second = await create()
  assert.deepEqual(second.primitive._instances.map(instance => instance.asset), assignment)
  first.destroy(); second.destroy()
})

test('becomes ready when assets finish outside the current camera range', async () => {
  const C = makeCesium()
  const polygons = {
    schemaVersion: 1,
    coordinateSystem: { origin: { longitude: 123.4122, latitude: 41.763 } },
    summary: { areaHectares: 0.1 },
    polygons: [{ id: 1, area: 1000, outer: [[123.410, 41.760], [123.411, 41.760], [123.411, 41.761], [123.410, 41.761]] }],
  }
  const h = harness(polygons, { Cesium: C, cachedCommandCount: 0 })
  const listeners = []
  const scene = {
    primitives: { add(m) { return m }, remove() { return true } },
    postRender: { addEventListener(fn) { listeners.push(fn); return () => {} } },
    requestRender() {},
  }
  const collection = createGrassCollection({
    Cesium: C, viewer: { scene }, polygonsUrl: 'https://example.test/grass/polygons.json',
    ezTreeRuntime: h.runtime, fetchJson: async () => structuredClone(polygons),
  })
  await new Promise(resolve => setTimeout(resolve, 0))
  listeners.slice().forEach(fn => fn())
  await Promise.race([
    collection.readyPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('collection stayed loading without visible commands')), 50)),
  ])
  assert.equal(collection.getDiagnostics().state, 'ready')
  assert.equal(collection.getDiagnostics().visibleBatches, 0)
})

test('rejects a malformed polygon asset instead of rendering nothing', async () => {
  const C = makeCesium()
  const scene = { primitives: { add() {}, remove() {} }, postRender: { addEventListener() { return () => {} } }, requestRender() {} }
  const collection = createGrassCollection({
    Cesium: C, viewer: { scene }, polygonsUrl: 'https://example.test/grass.json',
    ezTreeRuntime: harness({}, { Cesium: C }).runtime,
    fetchJson: async () => ({ schemaVersion: 99, polygons: [] }),
  })
  await assert.rejects(collection.readyPromise, /Invalid grass polygon asset/)
  assert.equal(collection.getDiagnostics().state, 'error')
})

test('destroy during loading rejects and never adds a primitive', async () => {
  const C = makeCesium()
  let release
  const added = []
  const scene = { primitives: { add(m) { added.push(m) }, remove() {} }, postRender: { addEventListener() { return () => {} } }, requestRender() {} }
  const collection = createGrassCollection({
    Cesium: C, viewer: { scene }, polygonsUrl: 'https://example.test/grass.json',
    ezTreeRuntime: harness({}, { Cesium: C }).runtime,
    fetchJson: () => new Promise(resolve => { release = resolve }),
  })
  collection.destroy()
  release({ schemaVersion: 1, coordinateSystem: {}, polygons: [] })
  await assert.rejects(collection.readyPromise, /destroyed/i)
  assert.equal(added.length, 0)
})
