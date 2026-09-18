import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

function aligned(value) { return (value + 3) & ~3 }

function syntheticTreeGlb(baseName) {
  const chunks = []
  const bufferViews = []
  const accessors = []
  const meshes = []
  const nodes = []
  let offset = 0
  for (let lod = 0; lod < 4; lod++) {
    const position = Buffer.from(new Float32Array([0, 0, 0, 100, 200, -100, -50, 300, 50]).buffer)
    chunks.push(position)
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: position.length, target: 34962 })
    accessors.push({ bufferView: lod, componentType: 5126, count: 3, type: 'VEC3', min: [-50, 0, -100], max: [100, 300, 50] })
    meshes.push({ name: `${baseName}.mesh.${lod}`, primitives: [
      { attributes: { POSITION: lod }, material: 0 },
      { attributes: { POSITION: lod }, material: 1 }
    ] })
    nodes.push({ name: `${baseName}_LOD${lod}`, mesh: lod })
    offset += position.length
  }
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+g8vVAAAAAElFTkSuQmCC', 'base64')
  const pngOffset = offset
  chunks.push(png)
  bufferViews.push({ buffer: 0, byteOffset: pngOffset, byteLength: png.length })
  offset += png.length
  nodes.push({ name: baseName, children: [0, 1, 2, 3], scale: [0.01, 0.01, 0.01] })
  const binary = Buffer.concat(chunks)
  const gltf = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [4] }],
    buffers: [{ byteLength: binary.length }], bufferViews, accessors, nodes, meshes,
    images: [{ bufferView: 4, mimeType: 'image/png', name: 'leaf' }],
    textures: [{ source: 0 }],
    extensionsUsed: ['KHR_materials_specular', 'KHR_materials_ior'],
    materials: [
      { name: 'trunk', extensions: { KHR_materials_specular: { specularColorFactor: [2, 2, 2] } }, pbrMetallicRoughness: { metallicFactor: 0.33, roughnessFactor: 0.7 } },
      { name: 'leaf', alphaMode: 'MASK', doubleSided: true, extensions: { KHR_materials_specular: { specularColorFactor: [1.5, 1.5, 1.5] }, KHR_materials_ior: { ior: 1 } }, pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.48 } }
    ]
  }
  let json = Buffer.from(JSON.stringify(gltf))
  json = Buffer.concat([json, Buffer.alloc(aligned(json.length) - json.length, 0x20)])
  const bin = Buffer.concat([binary, Buffer.alloc(aligned(binary.length) - binary.length)])
  const header = Buffer.alloc(12); header.write('glTF'); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8)
  const jsonHeader = Buffer.alloc(8); jsonHeader.writeUInt32LE(json.length); jsonHeader.write('JSON', 4)
  const binHeader = Buffer.alloc(8); binHeader.writeUInt32LE(bin.length); binHeader.writeUInt32LE(0x004e4942, 4)
  return Buffer.concat([header, jsonHeader, json, binHeader, bin])
}

test('prepares four mutually exclusive LOD descriptors with shared resources', async () => {
  const { prepareFixedTreeAssets } = require('../../scripts/prepare-fixed-tree-assets.cjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-tree-assets-'))
  const models = path.join(root, 'models'); const output = path.join(root, 'output')
  fs.mkdirSync(models)
  const definitions = [
    ['松树02b_LOD.glb', 'SM_Tree_Set_02b'],
    ['松树02c_LOD.glb', 'SM_Tree_Set_02c'],
    ['松树02i_LOD.glb', 'SM_Tree_Set_02i']
  ]
  for (const [file, base] of definitions) fs.writeFileSync(path.join(models, file), syntheticTreeGlb(base))
  const pointsFile = path.join(root, 'points.json')
  fs.writeFileSync(pointsFile, JSON.stringify({
    schemaVersion: 1,
    coordinateSystem: { origin: { latitude: 41.761969, longitude: 123.410315 }, local: 'ENU meters', geographicPositionOrder: ['longitude', 'latitude'] },
    summary: { objectCount: 3, countsByType: { 松柏: 1, 松树: 1, 松树01: 1 } },
    objects: [
      { type: '松柏', object: 'a', relativePosition: [0, 0], geographicPosition: [123.41, 41.76] },
      { type: '松树', object: 'b', relativePosition: [10, 0], geographicPosition: [123.411, 41.76] },
      { type: '松树01', object: 'c', relativePosition: [20, 0], geographicPosition: [123.412, 41.76] }
    ]
  }))

  const manifest = await prepareFixedTreeAssets({ modelsDirectory: models, pointsFile, outputDirectory: output })
  assert.equal(manifest.pointCount, 3)
  assert.deepEqual(manifest.typeMap, { 松柏: 'pine-02b', 松树: 'pine-02c', 松树01: 'pine-02i' })
  for (const prototype of manifest.prototypes) {
    assert.equal(prototype.lods.length, 4)
    assert.ok(fs.existsSync(path.join(output, prototype.id, 'model.bin')))
    assert.ok(fs.existsSync(path.join(output, prototype.id, 'leaf.png')))
    for (let lod = 0; lod < 4; lod++) {
      const gltf = JSON.parse(fs.readFileSync(path.join(output, prototype.id, `lod${lod}.gltf`), 'utf8'))
      const rootNode = gltf.nodes[gltf.scenes[gltf.scene].nodes[0]]
      assert.equal(rootNode.scale, undefined)
      assert.deepEqual(rootNode.children, [lod])
      assert.equal(gltf.buffers[0].uri, 'model.bin')
      assert.equal(gltf.images[0].uri, 'leaf.png')
      assert.equal(gltf.images[0].bufferView, undefined)
      assert.deepEqual(gltf.accessors[lod].min, [-0.5, 0, -1])
      assert.deepEqual(gltf.accessors[lod].max, [1, 3, 0.5])
      assert.deepEqual(gltf.extensionsUsed, [])
      assert.deepEqual(gltf.materials[0].pbrMetallicRoughness, {
        baseColorFactor: [0.18, 0.09, 0.04, 1], metallicFactor: 0, roughnessFactor: 0.9
      })
      assert.equal(gltf.materials[0].extensions, undefined)
      assert.equal(gltf.materials[1].alphaMode, 'MASK')
      assert.equal(gltf.materials[1].alphaCutoff, 0.35)
      assert.equal(gltf.materials[1].pbrMetallicRoughness.metallicFactor, 0)
      assert.equal(gltf.materials[1].pbrMetallicRoughness.roughnessFactor, 0.8)
      assert.equal(gltf.materials[1].extensions, undefined)
    }
    const normalized = fs.readFileSync(path.join(output, prototype.id, 'model.bin'))
    assert.deepEqual(Array.from(new Float32Array(normalized.buffer, normalized.byteOffset, 9)), [0, 0, 0, 1, 2, -1, -0.5, 3, 0.5])
  }
})

test('rejects duplicate object ids and inconsistent point summaries', () => {
  const { validatePointExport } = require('../../scripts/prepare-fixed-tree-assets.cjs')
  assert.throws(() => validatePointExport({
    coordinateSystem: { origin: { latitude: 41, longitude: 123 }, geographicPositionOrder: ['longitude', 'latitude'] },
    summary: { objectCount: 2 },
    objects: [
      { type: '松柏', object: 'same', relativePosition: [0, 0], geographicPosition: [123, 41] },
      { type: '松树', object: 'same', relativePosition: [1, 1], geographicPosition: [123.1, 41.1] }
    ]
  }), /duplicate object id/i)
})
