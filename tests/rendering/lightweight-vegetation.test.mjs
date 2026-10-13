import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { createGrassCollection } from '../../src/instances/GrassCollection.js'
import { stableTreeVariation } from '../../src/instances/fixedTreeData.js'

const require = createRequire(import.meta.url)
const C = require('cesium/Build/Cesium/index.cjs')
const { parseGlb } = require('../../scripts/prepare-fixed-tree-assets.cjs')

test('neighboring tree identifiers produce stable rotations spread around the full circle', () => {
  const variations = Array.from({ length: 100 }, (_, i) => stableTreeVariation(`tree-${i}`))
  const headings = variations.map(variation => variation.heading)
  const sectors = new Set(headings.map(heading => Math.floor(heading / (Math.PI * 2) * 12)))
  assert.ok(sectors.size >= 10, `Rotations cluster in only ${sectors.size} sectors`)
  assert.ok(Math.min(...variations.map(variation => variation.heightScale)) >= 0.82)
  assert.ok(Math.max(...variations.map(variation => variation.heightScale)) <= 1.18)
  assert.ok(Math.min(...variations.map(variation => variation.crownScale)) >= 0.84)
  assert.ok(Math.max(...variations.map(variation => variation.crownScale)) <= 1.2)
  assert.ok(variations.some(variation => Math.abs(variation.heightScale - variation.crownScale) > 0.08), 'Height and crown width must vary independently')
  assert.deepEqual(stableTreeVariation('tree-7'), stableTreeVariation('tree-7'))
})

test('official tree prototypes preserve all points with bounded, decreasing geometry LODs', () => {
  const filename = new URL('../../assets/vegetation/ez-tree/manifest.json', import.meta.url)
  assert.ok(fs.existsSync(filename), 'Official lightweight prototypes have not been generated')
  const manifest = JSON.parse(fs.readFileSync(filename))
  const original = JSON.parse(fs.readFileSync(new URL('../../assets/vegetation/manifest.json', import.meta.url)))
  assert.equal(manifest.pointCount, original.pointCount)
  assert.deepEqual(manifest.typeMap, original.typeMap)
  assert.match(manifest.generator.repository, /dgreenheck\/ez-tree$/)
  assert.deepEqual(new Set(manifest.prototypes.map(prototype => prototype.form)), new Set(['columnar', 'spreading', 'rounded']))
  for (const prototype of manifest.prototypes) {
    const { json: gltf, binary } = parseGlb(fs.readFileSync(new URL(prototype.url, filename)))
    const image = gltf.bufferViews[gltf.images[0].bufferView]
    const imageBytes = binary.subarray(image.byteOffset, image.byteOffset + image.byteLength)
    assert.equal(imageBytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'Embedded foliage must be an actual PNG, not an LFS pointer')
    const counts = [0, 0, 0, 0]
    for (const node of gltf.nodes) {
      assert.ok(Number.isInteger(node.extras.ccrLod))
      for (const primitive of gltf.meshes[node.mesh].primitives) {
        counts[node.extras.ccrLod] += gltf.accessors[primitive.indices].count / 3
        const positions = gltf.accessors[primitive.attributes.POSITION]
        assert.ok(positions.min[1] >= -0.001)
        assert.ok(positions.max[1] <= prototype.height + 0.001)
      }
    }
    assert.ok(counts[0] <= 14000, `Near geometry exceeds budget: ${counts}`)
    assert.ok(counts[3] <= 900, `Far geometry exceeds budget: ${counts}`)
    assert.ok(prototype.height >= 8.5, 'Street trees must not retain the undersized 4.3 metre prototype')
    const leafUV = gltf.accessors[gltf.meshes[0].primitives[1].attributes.TEXCOORD_0]
    const uvOffset = gltf.bufferViews[leafUV.bufferView].byteOffset
    assert.equal(binary.readFloatLE(uvOffset + 4), 0, 'Leaf tip must sample the top of the GLB image')
    assert.equal(binary.readFloatLE(uvOffset + 12), 1, 'Leaf attachment must sample the image base')
    assert.ok(counts.every((count, i) => count > 0 && (!i || count < counts[i - 1])), counts)
    const positions = gltf.meshes[0].primitives.map(p => gltf.accessors[p.attributes.POSITION])
    const width = Math.max(...positions.map(p => p.max[0])) - Math.min(...positions.map(p => p.min[0]))
    if (prototype.form === 'columnar') assert.ok(width / prototype.height < 0.48, 'Columnar evergreen must retain a narrow upright crown')
    if (prototype.form === 'spreading') assert.ok(width / prototype.height > 0.55, 'Spreading pine must have a broad crown')
    if (prototype.form === 'rounded') assert.ok(width / prototype.height > 0.65, 'Rounded campus tree must have a full crown')
  }
})

test('lightweight grass uses textured short clumps above ground without adding a green ground plane', async () => {
  const added = [], removed = [], listeners = []
  const scene = {
    primitives: { add(p) { added.push(p); return p }, remove(p) { removed.push(p); return true } },
    postRender: { addEventListener(fn) { listeners.push(fn); return () => {} } }, requestRender() {},
    sampleHeightSupported: true,
    sampleHeight() { return 1.8 },
  }
  const requests = []
  const runtime = {
    configureEzTree() {},
    createEzTreeVegetationInstances(o) {
      requests.push(o)
      return Array.from({ length: o.grassCount }, () => ({ kind: 'grass', translation: new C.Cartesian3(), scale: new C.Cartesian3(5, 5, 5), color: C.Color.GREEN }))
    },
    EzTreePrimitive: class {
      constructor(o) { Object.assign(this, o); this._resources = { gltfRecordsBuilt: true, gltfAssetRecords: [], records: [], meshResources: [], pendingTextureCount: 0 } }
    },
  }
  const collection = createGrassCollection({ Cesium: C, viewer: { scene }, profile: 'lightweight', maxInstances: 200,
    polygonsUrl: 'https://example.test/grass/polygons.json', ezTreeRuntime: runtime,
    fetchJson: async () => ({ schemaVersion: 1, coordinateSystem: { origin: { longitude: 123, latitude: 41 } },
      summary: { areaHectares: 0.01 }, polygons: [{ id: 1, area: 100, outer: [[123,41],[123.001,41],[123.001,41.001],[123,41.001]],
        holes: [[[123.0002,41.0002],[123.0004,41.0002],[123.0004,41.0004]]] }] }),
  })
  await new Promise(resolve => setTimeout(resolve, 20))
  listeners.forEach(fn => fn())
  await collection.readyPromise
  assert.ok(requests[0].grassCount >= 100, 'Near coverage must be at least one clump per square metre')
  assert.equal(collection.primitive.grassAssets[0].id, 'grass-light')
  assert.equal(collection.primitive.grassAssets[0].alphaFromColor, false)
  assert.ok(collection.primitive.instances.every(instance => instance.color.green > instance.color.red && instance.color.green > instance.color.blue), 'Grayscale grass texture needs a green tint')
  const root = C.Matrix4.multiplyByPoint(collection._modelMatrix, collection.primitive.instances[0].translation, new C.Cartesian3())
  assert.ok(Math.abs(C.Cartographic.fromCartesian(root).height - 1.82) < 0.001, 'Short grass must sit above the sampled surface')
  assert.equal(collection.getDiagnostics().groundSamples, 1)
  assert.ok(collection.primitive.maximumGrassDistance <= 250)
  assert.equal(added.length, 1, 'Only grass geometry is allowed; do not add a ground plane')
  collection.setVisible(false)
  assert.equal(collection.primitive.show, false)
  collection.destroy()
  assert.equal(removed.length, 1)
  const { json: gltf } = parseGlb(fs.readFileSync(new URL('../../vendor/cesium-ez-tree/assets/models/grass.glb', import.meta.url)))
  assert.equal(gltf.meshes[0].primitives.reduce((sum, p) => sum + gltf.accessors[p.indices].count / 3, 0), 6)
})
