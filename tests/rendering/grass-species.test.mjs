import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { createGrassCollection } from '../../src/instances/GrassCollection.js'
import { DEFAULT_GRASS_SPECIES, pickGrassSpecies, resolveGrassSpecies } from '../../src/instances/grassSpecies.js'
import { GRASS_SPECIES_ASSET_URLS } from '../../src/instances/grassSpeciesAssets.js'

const require = createRequire(import.meta.url)
const C = require('cesium/Build/Cesium/index.cjs')
const { parseGlb } = require('../../scripts/prepare-fixed-tree-assets.cjs')
const { SPECIES_MESHES, curvedCentreline } = require('../../scripts/grass-species/meshes.cjs')
const { createGrassAtlas } = require('../../scripts/grass-species/atlas.cjs')
const { prepareGrassSpecies } = require('../../scripts/prepare-grass-species.cjs')

const glbOf = species => parseGlb(Buffer.from(GRASS_SPECIES_ASSET_URLS[species].split(',')[1], 'base64'))

test('embedded species GLBs are valid alpha-masked, double-sided, textured meshes', () => {
  for (const { id } of DEFAULT_GRASS_SPECIES) {
    const { json } = glbOf(id)
    const material = json.materials[0]
    assert.equal(material.alphaMode, 'MASK', id)
    assert.equal(material.doubleSided, true, id)
    assert.equal(json.images[0].mimeType, 'image/png', id)
    assert.deepEqual(Object.keys(json.meshes[0].primitives[0].attributes).sort(), ['NORMAL', 'POSITION', 'TEXCOORD_0'])
    assert.ok(!json.nodes[0].matrix && !json.nodes[0].translation, 'runtime expects no node transforms')
  }
})

test('embedded assets match the generator output (regenerate with prepare-grass-species)', () => {
  const before = fs.readFileSync(new URL('../../src/instances/grassSpeciesAssets.js', import.meta.url), 'utf8')
  prepareGrassSpecies()
  const after = fs.readFileSync(new URL('../../src/instances/grassSpeciesAssets.js', import.meta.url), 'utf8')
  assert.equal(after, before, 'generator must be deterministic and the committed module up to date')
})

test('species meshes are real-size and stay within a modest triangle budget', () => {
  const limits = { lawn: [0.25, 0.35], tall: [0.55, 0.45], broadleaf: [0.08, 0.2], clover: [0.1, 0.16] }
  for (const [species, create] of Object.entries(SPECIES_MESHES)) {
    const mesh = create()
    let maxHeight = 0, maxRadius = 0
    for (let i = 0; i < mesh.positions.length; i += 3) {
      maxHeight = Math.max(maxHeight, mesh.positions[i + 1])
      maxRadius = Math.max(maxRadius, Math.hypot(mesh.positions[i], mesh.positions[i + 2]))
    }
    assert.ok(maxHeight <= limits[species][0], `${species} too tall: ${maxHeight}`)
    assert.ok(maxRadius <= limits[species][1] + 0.1, `${species} too wide: ${maxRadius}`)
    assert.ok(mesh.indices.length / 3 <= 128, `${species} exceeds the triangle budget`)
    assert.ok(Math.max(...mesh.indices) < mesh.positions.length / 3)
  }
})

test('lawn blades are scattered over the patch instead of sitting on a few card edges', () => {
  const mesh = SPECIES_MESHES.lawn()
  // The first 18 strips are 3-segment tuft cards (8 vertices); the base pair is the first two.
  const bases = new Set()
  for (let v = 0; v < 18 * 8; v += 8) {
    const x = (mesh.positions[v * 3] + mesh.positions[v * 3 + 3]) / 2
    const z = (mesh.positions[v * 3 + 2] + mesh.positions[v * 3 + 5]) / 2
    bases.add(`${Math.round(x * 50)},${Math.round(z * 50)}`)
  }
  assert.ok(bases.size >= 15, `expected scattered blade roots, got ${bases.size}`)
})

test('blade curves keep their length and bend smoothly instead of folding', () => {
  const length = 0.4
  const points = curvedCentreline({ base: [0, 0, 0], leanDirection: [1, 0, 0], length, bend: 2.4, segments: 5 })
  let total = 0
  const directions = []
  for (let i = 1; i < points.length; i++) {
    const d = points[i].map((value, axis) => value - points[i - 1][axis])
    const segment = Math.hypot(...d)
    total += segment
    directions.push(d.map(value => value / segment))
  }
  assert.ok(Math.abs(total - length) < length * 0.03, `arc length drifted: ${total}`)
  for (let i = 1; i < directions.length; i++) {
    const cosine = directions[i].reduce((sum, value, axis) => sum + value * directions[i - 1][axis], 0)
    assert.ok(cosine > Math.cos(0.75), `joint ${i} folds by ${Math.acos(cosine)} rad`)
  }
  assert.ok(points.at(-1)[1] < Math.max(...points.map(p => p[1])), 'a strongly bent blade droops at the tip')
})

test('blade normals fold along the midrib so the width is not shaded flat', () => {
  const mesh = SPECIES_MESHES.tall()
  const left = mesh.normals.slice(0, 3), right = mesh.normals.slice(3, 6)
  const cosine = left[0] * right[0] + left[1] * right[1] + left[2] * right[2]
  assert.ok(cosine < 0.9, `edge normals should differ, cos=${cosine}`)
})

test('atlas has opaque leaves and transparent background', () => {
  const { pixels } = createGrassAtlas()
  let opaque = 0, clear = 0
  for (let i = 1; i < pixels.length; i += 2) {
    if (pixels[i] === 255) opaque++
    if (pixels[i] === 0) clear++
  }
  assert.ok(opaque > 5000 && clear > 5000)
})

test('species mix contains every species, clusters weeds and honours zero weights', () => {
  const species = resolveGrassSpecies()
  const counts = {}
  const grid = new Map()
  for (let i = 0; i < 20000; i++) {
    const x = (i % 200) * 0.5, y = Math.floor(i / 200) * 0.5
    const picked = pickGrassSpecies(species, x, y, i, 7).id
    counts[picked] = (counts[picked] || 0) + 1
    grid.set(`${i % 200},${Math.floor(i / 200)}`, picked)
  }
  for (const { id } of DEFAULT_GRASS_SPECIES) assert.ok(counts[id] > 300, `${id} missing: ${counts[id]}`)
  assert.ok(counts.lawn > counts.tall && counts.lawn > counts.clover, 'lawn grass dominates')
  // Clustering: a clover clump's right neighbour is clover far more often than the global share.
  let pairs = 0, same = 0
  for (const [key, id] of grid) {
    if (id !== 'clover') continue
    const [gx, gy] = key.split(',').map(Number)
    const right = grid.get(`${gx + 1},${gy}`)
    if (!right) continue
    pairs++
    if (right === 'clover') same++
  }
  assert.ok(same / pairs > (counts.clover / 20000) * 1.8, 'weeds should grow in clusters')

  const noClover = resolveGrassSpecies([{ id: 'clover', weight: 0 }])
  assert.ok(!noClover.some(item => item.id === 'clover'))
  assert.throws(() => resolveGrassSpecies(DEFAULT_GRASS_SPECIES.map(({ id }) => ({ id, weight: 0 }))))
})

test('species palettes stay green-dominant', () => {
  for (const item of resolveGrassSpecies()) {
    for (const [name, colour] of Object.entries(item.variation.palette)) {
      assert.ok(colour[1] > colour[0] && colour[1] > colour[2], `${item.id}.${name} must stay green: ${colour}`)
    }
  }
})

function runtimeMock(requests) {
  return {
    configureEzTree() {},
    createEzTreeVegetationInstances(o) {
      requests.push(o)
      return Array.from({ length: o.grassCount }, (_, i) => ({ kind: 'grass',
        translation: new C.Cartesian3((i % 40) * 0.5, Math.floor(i / 40) * 0.5, 0),
        scale: new C.Cartesian3(o.grassScale * 5.5, o.grassScale * 5.5, o.grassScale * 5), rotation: 0, windPhase: 0 }))
    },
    EzTreePrimitive: class {
      constructor(o) { Object.assign(this, o); this._resources = { gltfRecordsBuilt: true, gltfAssetRecords: [], records: [], meshResources: [], pendingTextureCount: 0 } }
    },
  }
}

test('lightweight grass defaults to the embedded species mix with metre-scaled instances', async () => {
  const listeners = [], requests = []
  const scene = {
    primitives: { add(p) { return p }, remove() { return true } },
    postRender: { addEventListener(fn) { listeners.push(fn); return () => {} } }, requestRender() {},
    sampleHeightSupported: false,
  }
  const collection = createGrassCollection({ Cesium: C, viewer: { scene }, profile: 'lightweight', scale: 0.5, maxInstances: 1600,
    polygonsUrl: 'https://example.test/grass/polygons.json', ezTreeRuntime: runtimeMock(requests),
    fetchJson: async () => ({ schemaVersion: 1, coordinateSystem: { origin: { longitude: 123, latitude: 41 } },
      summary: { areaHectares: 0.04 }, polygons: [{ id: 1, area: 400, outer: [[123, 41], [123.0003, 41], [123.0003, 41.0002], [123, 41.0002]] }] }),
  })
  await new Promise(resolve => setTimeout(resolve, 20))
  listeners.forEach(fn => fn())
  await collection.readyPromise
  const diagnostics = collection.getDiagnostics()
  assert.equal(diagnostics.assetMode, 'species')
  assert.equal(requests[0].grassPatchiness, 1, 'lawns need uniform coverage (upstream 1.0 = no bare patches)')
  const assets = collection.primitive.grassAssets
  assert.ok(assets.length >= 3, 'several species are loaded')
  assert.ok(assets.every(asset => asset.url.startsWith('data:model/gltf-binary;base64,') && asset.alphaFromColor === false))
  assert.ok(collection.primitive.windStrength <= 0.08, 'metre-scaled meshes need gentler wind')
  for (const instance of collection.primitive.instances) {
    assert.ok(instance.scale.z > 0.3 && instance.scale.z < 2.5, `unexpected height scale ${instance.scale.z}`)
    assert.ok(assets.some(asset => asset.id === instance.asset))
  }
  collection.destroy()
})
