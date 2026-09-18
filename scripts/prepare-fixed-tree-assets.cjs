#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')

const PROTOTYPES = [
  { id: 'pine-02b', file: '松树02b_LOD.glb', nodePrefix: 'SM_Tree_Set_02b', height: 8.7 },
  { id: 'pine-02c', file: '松树02c_LOD.glb', nodePrefix: 'SM_Tree_Set_02c', height: 9.5 },
  { id: 'pine-02i', file: '松树02i_LOD.glb', nodePrefix: 'SM_Tree_Set_02i', height: 4.3 }
]
const TYPE_MAP = { 松柏: 'pine-02b', 松树: 'pine-02c', 松树01: 'pine-02i' }

function parseGlb(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'glTF') throw new Error('Invalid GLB header')
  if (bytes.readUInt32LE(4) !== 2) throw new Error('Only GLB 2.0 is supported')
  const declaredLength = bytes.readUInt32LE(8)
  if (declaredLength !== bytes.length) throw new Error(`GLB length mismatch: declared ${declaredLength}, actual ${bytes.length}`)
  let offset = 12; let json = null; let binary = null
  while (offset < bytes.length) {
    const length = bytes.readUInt32LE(offset); const type = bytes.readUInt32LE(offset + 4); offset += 8
    if (offset + length > bytes.length) throw new Error('GLB chunk exceeds file length')
    const chunk = bytes.subarray(offset, offset + length); offset += length
    if (type === 0x4e4f534a) json = JSON.parse(chunk.toString('utf8').replace(/\0+$/g, '').trimEnd())
    if (type === 0x004e4942) binary = Buffer.from(chunk)
  }
  if (!json || !binary) throw new Error('GLB must contain JSON and BIN chunks')
  return { json, binary }
}

function validatePointExport(data) {
  const order = data?.coordinateSystem?.geographicPositionOrder
  if (JSON.stringify(order) !== JSON.stringify(['longitude', 'latitude'])) throw new Error('Point export must declare [longitude, latitude] order')
  const origin = data.coordinateSystem?.origin
  if (!Number.isFinite(origin?.longitude) || !Number.isFinite(origin?.latitude)) throw new Error('Point export has no finite WGS84 origin')
  if (!Array.isArray(data.objects)) throw new Error('Point export objects must be an array')
  if (data.summary?.objectCount !== data.objects.length) throw new Error('Point export objectCount does not match objects')
  const ids = new Set(); const positions = new Set(); const counts = {}
  for (const item of data.objects) {
    if (!Object.hasOwn(TYPE_MAP, item.type)) throw new Error(`Unknown tree type: ${item.type}`)
    if (typeof item.object !== 'string' || item.object.length === 0) throw new Error('Tree object id must be a non-empty string')
    if (ids.has(item.object)) throw new Error(`Duplicate object id: ${item.object}`)
    ids.add(item.object)
    if (!Array.isArray(item.relativePosition) || item.relativePosition.length !== 2 || !item.relativePosition.every(Number.isFinite)) throw new Error(`Invalid ENU position: ${item.object}`)
    if (!Array.isArray(item.geographicPosition) || item.geographicPosition.length !== 2 || !item.geographicPosition.every(Number.isFinite)) throw new Error(`Invalid geographic position: ${item.object}`)
    const key = item.geographicPosition.map(value => value.toFixed(9)).join(',')
    if (positions.has(key)) throw new Error(`Duplicate geographic position: ${key}`)
    positions.add(key); counts[item.type] = (counts[item.type] || 0) + 1
  }
  if (data.summary?.countsByType) {
    for (const [type, count] of Object.entries(counts)) {
      if (data.summary.countsByType[type] !== count) throw new Error(`Point count mismatch for ${type}`)
    }
  }
  return data
}

function accessorByteOffset(gltf, accessor) {
  const view = gltf.bufferViews?.[accessor.bufferView]
  if (!view || (view.buffer ?? 0) !== 0) throw new Error('POSITION accessor must reference the GLB binary buffer')
  return { offset: (view.byteOffset || 0) + (accessor.byteOffset || 0), stride: view.byteStride || 12 }
}

function scalePositions(gltf, binary, scale) {
  const output = Buffer.from(binary); const scaled = new Set()
  for (const mesh of gltf.meshes || []) for (const primitive of mesh.primitives || []) {
    const index = primitive.attributes?.POSITION
    if (!Number.isInteger(index) || scaled.has(index)) continue
    const accessor = gltf.accessors?.[index]
    if (!accessor || accessor.componentType !== 5126 || accessor.type !== 'VEC3' || accessor.sparse) throw new Error(`POSITION accessor ${index} must be dense FLOAT VEC3`)
    const layout = accessorByteOffset(gltf, accessor)
    for (let vertex = 0; vertex < accessor.count; vertex++) {
      const offset = layout.offset + vertex * layout.stride
      for (let component = 0; component < 3; component++) output.writeFloatLE(output.readFloatLE(offset + component * 4) * scale, offset + component * 4)
    }
    if (accessor.min) accessor.min = accessor.min.map(value => value * scale)
    if (accessor.max) accessor.max = accessor.max.map(value => value * scale)
    scaled.add(index)
  }
  return output
}

function extractImage(gltf, binary) {
  if (gltf.images?.length !== 1) throw new Error(`Expected one embedded leaf image, found ${gltf.images?.length || 0}`)
  const image = gltf.images[0]; const view = gltf.bufferViews?.[image.bufferView]
  if (!view || image.mimeType !== 'image/png') throw new Error('Expected one embedded PNG leaf image')
  const start = view.byteOffset || 0
  return Buffer.from(binary.subarray(start, start + view.byteLength))
}

function normalizeVegetationMaterials(gltf) {
  const removed = new Set(['KHR_materials_specular', 'KHR_materials_ior'])
  gltf.extensionsUsed = (gltf.extensionsUsed || []).filter(name => !removed.has(name))
  if (gltf.extensionsRequired) gltf.extensionsRequired = gltf.extensionsRequired.filter(name => !removed.has(name))
  for (const material of gltf.materials || []) {
    if (material.extensions) {
      for (const name of removed) delete material.extensions[name]
      if (Object.keys(material.extensions).length === 0) delete material.extensions
    }
    const pbr = material.pbrMetallicRoughness || (material.pbrMetallicRoughness = {})
    pbr.metallicFactor = 0
    if (material.alphaMode === 'MASK') {
      material.alphaCutoff = 0.35
      pbr.roughnessFactor = 0.8
    } else {
      pbr.baseColorFactor = [0.18, 0.09, 0.04, 1]
      pbr.roughnessFactor = 0.9
    }
  }
}

function normalizePrototype(input, definition, outputDirectory) {
  const { json: source, binary } = parseGlb(input)
  const gltf = structuredClone(source)
  const rootIndex = gltf.scenes?.[gltf.scene ?? 0]?.nodes?.[0]
  const root = gltf.nodes?.[rootIndex]
  if (!root) throw new Error(`${definition.file}: missing scene root`)
  const scale = root.scale
  if (!Array.isArray(scale) || scale.length !== 3 || !scale.every(value => Number.isFinite(value)) || Math.abs(scale[0] - scale[1]) > 1e-8 || Math.abs(scale[0] - scale[2]) > 1e-8) throw new Error(`${definition.file}: root scale must be uniform`)
  const lodNodes = Array.from({ length: 4 }, (_, lod) => gltf.nodes.findIndex(node => node.name === `${definition.nodePrefix}_LOD${lod}`))
  if (lodNodes.some(index => index < 0) || new Set(lodNodes).size !== 4) throw new Error(`${definition.file}: expected named LOD0-LOD3 nodes`)
  const normalizedBinary = scalePositions(gltf, binary, scale[0])
  normalizeVegetationMaterials(gltf)
  delete root.scale
  // EzTree's existing GLB loader consumes all four meshes once. Each primitive
  // carries its geometry level; the upstream command cache selects one per cell.
  const ezGltf = structuredClone(gltf)
  lodNodes.forEach((node, level) => { ezGltf.nodes[node].extras = { ...ezGltf.nodes[node].extras, ccrLod: level } })
  const jsonBytes = Buffer.from(JSON.stringify(ezGltf))
  const jsonPadded = Buffer.concat([jsonBytes, Buffer.alloc((4 - jsonBytes.length % 4) % 4, 32)])
  const binPadded = Buffer.concat([normalizedBinary, Buffer.alloc((4 - normalizedBinary.length % 4) % 4)])
  const header = Buffer.alloc(20)
  header.write('glTF'); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + jsonPadded.length + binPadded.length, 8)
  header.writeUInt32LE(jsonPadded.length, 12); header.write('JSON', 16)
  const binHeader = Buffer.alloc(8); binHeader.writeUInt32LE(binPadded.length); binHeader.writeUInt32LE(0x004e4942, 4)
  fs.mkdirSync(path.join(outputDirectory, definition.id), { recursive: true })
  fs.writeFileSync(path.join(outputDirectory, definition.id, 'tree.glb'), Buffer.concat([header, jsonPadded, binHeader, binPadded]))
  gltf.buffers[0] = { byteLength: normalizedBinary.length, uri: 'model.bin' }
  const leaf = extractImage(gltf, binary)
  delete gltf.images[0].bufferView; delete gltf.images[0].mimeType; gltf.images[0].uri = 'leaf.png'
  const prototypeDirectory = path.join(outputDirectory, definition.id)
  fs.mkdirSync(prototypeDirectory, { recursive: true })
  fs.writeFileSync(path.join(prototypeDirectory, 'model.bin'), normalizedBinary)
  fs.writeFileSync(path.join(prototypeDirectory, 'leaf.png'), leaf)
  const lods = []
  for (let lod = 0; lod < 4; lod++) {
    const descriptor = structuredClone(gltf)
    descriptor.nodes[rootIndex].children = [lodNodes[lod]]
    descriptor.extras = { ...(descriptor.extras || {}), ccrPrototype: definition.id, ccrLod: lod }
    const file = `lod${lod}.gltf`
    fs.writeFileSync(path.join(prototypeDirectory, file), `${JSON.stringify(descriptor)}\n`)
    lods.push({ level: lod, url: `${definition.id}/${file}` })
  }
  return { id: definition.id, source: definition.file, url: `${definition.id}/tree.glb`, height: definition.height, lods }
}

async function prepareFixedTreeAssets({ modelsDirectory, pointsFile, outputDirectory }) {
  if (!modelsDirectory || !pointsFile || !outputDirectory) throw new Error('modelsDirectory, pointsFile and outputDirectory are required')
  const points = validatePointExport(JSON.parse(fs.readFileSync(pointsFile, 'utf8')))
  fs.mkdirSync(outputDirectory, { recursive: true })
  const barkDirectory = path.join(outputDirectory, 'eztree/bark')
  fs.mkdirSync(barkDirectory, { recursive: true })
  fs.copyFileSync(path.join(__dirname, '../vendor/cesium-ez-tree/assets/bark/pine_color_1k.jpg'), path.join(barkDirectory, 'pine_color_1k.jpg'))
  const prototypes = PROTOTYPES.map(definition => normalizePrototype(fs.readFileSync(path.join(modelsDirectory, definition.file)), definition, outputDirectory))
  fs.writeFileSync(path.join(outputDirectory, 'points.json'), `${JSON.stringify(points)}\n`)
  const manifest = {
    schemaVersion: 1,
    points: 'points.json',
    pointCount: points.objects.length,
    coordinateSystem: points.coordinateSystem,
    typeMap: TYPE_MAP,
    prototypes
  }
  fs.writeFileSync(path.join(outputDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

function args(argv) {
  const result = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '')
    if (!key || !argv[i + 1]) throw new Error(`Missing value for ${argv[i] || 'argument'}`)
    result[key] = argv[i + 1]
  }
  return result
}

if (require.main === module) {
  const options = args(process.argv.slice(2))
  prepareFixedTreeAssets({ modelsDirectory: options.models, pointsFile: options.points, outputDirectory: options.output })
    .then(manifest => console.log(JSON.stringify({ output: path.resolve(options.output), points: manifest.pointCount, prototypes: manifest.prototypes.length, lods: manifest.prototypes.reduce((sum, item) => sum + item.lods.length, 0) })))
    .catch(error => { console.error(error.stack || error.message); process.exitCode = 1 })
}

module.exports = { PROTOTYPES, TYPE_MAP, parseGlb, validatePointExport, normalizeVegetationMaterials, normalizePrototype, prepareFixedTreeAssets }
