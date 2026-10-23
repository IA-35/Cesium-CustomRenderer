// Offline asset preparation using the unmodified official EZ-Tree generator.
const fs = require('node:fs')
const path = require('node:path')
const webpack = require('webpack')
const { parseGlb } = require('./prepare-fixed-tree-assets.cjs')
const root = path.resolve(__dirname, '..')
const upstream = 'dcf309bd86bd521083d9c70f01f2de45fdc7c457'

async function loadGenerator() {
  const output = path.join(root, 'build/.generated/official-ez-tree')
  const compiler = webpack({ mode: 'none', target: 'node', devtool: false,
    module: { rules: [{ test: /\.js$/, resolve: { fullySpecified: false } }] },
    entry: path.join(root, 'vendor/ez-tree-generator/src/lib/index.js'),
    output: { path: output, filename: 'generator.cjs', library: { type: 'commonjs2' } },
    externals: { three: 'commonjs three' }, performance: { hints: false } })
  await new Promise((resolve, reject) => compiler.run((error, stats) => {
    compiler.close(() => {})
    if (error || stats.hasErrors()) reject(error || new Error(stats.toString({ all: false, errors: true })))
    else resolve()
  }))
  return require(path.join(output, 'generator.cjs'))
}

function packTree(levels, leafPng, height, bounds, leafTint, materialName = 'pine-needles') {
  const json = { asset: { version: '2.0', generator: `dgreenheck/ez-tree@${upstream}` },
    scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], accessors: [], bufferViews: [], buffers: [],
    materials: [
      { name: 'bark', pbrMetallicRoughness: { baseColorFactor: [0.22, 0.12, 0.055, 1], metallicFactor: 0, roughnessFactor: 1 } },
      { name: materialName, alphaMode: 'MASK', alphaCutoff: 0.35, doubleSided: true,
        extras: { roundedLeafNormals: true },
        pbrMetallicRoughness: { baseColorTexture: { index: 0 }, baseColorFactor: leafTint, metallicFactor: 0, roughnessFactor: 1 } },
    ], textures: [{ source: 0 }], images: [] }
  const chunks = []
  let byteLength = 0
  const append = bytes => {
    const index = json.bufferViews.length
    json.bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: bytes.length })
    chunks.push(bytes); byteLength += bytes.length
    const padding = (4 - byteLength % 4) % 4
    if (padding) { chunks.push(Buffer.alloc(padding)); byteLength += padding }
    return index
  }
  const accessor = (array, type, componentType, size) => {
    const result = { bufferView: append(Buffer.from(array.buffer, array.byteOffset, array.byteLength)), componentType, count: array.length / size, type }
    if (type === 'VEC3') {
      result.min = [Infinity, Infinity, Infinity]; result.max = [-Infinity, -Infinity, -Infinity]
      for (let i = 0; i < array.length; i++) {
        result.min[i % 3] = Math.min(result.min[i % 3], array[i]); result.max[i % 3] = Math.max(result.max[i % 3], array[i])
      }
    }
    return json.accessors.push(result) - 1
  }
  const scale = height / (bounds.max - bounds.min)
  levels.forEach((level, lod) => {
    const primitives = [level.branches, level.leaves].map((geometry, material) => {
      const positions = new Float32Array(geometry.attributes.position.array)
      for (let i = 0; i < positions.length; i++) positions[i] = (positions[i] - (i % 3 === 1 ? bounds.min : 0)) * scale
      // Three.js textures flip Y on upload. GLB images do not; export the matching UVs.
      const uv = new Float32Array(geometry.attributes.uv.array)
      for (let i = 1; i < uv.length; i += 2) uv[i] = 1 - uv[i]
      return { attributes: {
        POSITION: accessor(positions, 'VEC3', 5126, 3),
        NORMAL: accessor(geometry.attributes.normal.array, 'VEC3', 5126, 3),
        TEXCOORD_0: accessor(uv, 'VEC2', 5126, 2),
      }, indices: accessor(geometry.index.array, 'SCALAR', geometry.index.array.BYTES_PER_ELEMENT === 2 ? 5123 : 5125, 1), material }
    })
    json.scenes[0].nodes.push(json.nodes.length)
    json.nodes.push({ mesh: json.meshes.length, extras: { ccrLod: lod } })
    json.meshes.push({ primitives })
  })
  json.images.push({ bufferView: append(leafPng), mimeType: 'image/png' })
  json.buffers.push({ byteLength })
  const encoded = Buffer.from(JSON.stringify(json)), jsonBytes = Buffer.concat([encoded, Buffer.alloc((4 - encoded.length % 4) % 4, 32)])
  const header = Buffer.alloc(20), binHeader = Buffer.alloc(8)
  header.write('glTF'); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + jsonBytes.length + byteLength, 8)
  header.writeUInt32LE(jsonBytes.length, 12); header.writeUInt32LE(0x4e4f534a, 16)
  binHeader.writeUInt32LE(byteLength); binHeader.writeUInt32LE(0x004e4942, 4)
  return Buffer.concat([header, jsonBytes, binHeader, ...chunks])
}

async function prepare() {
  const { Tree } = await loadGenerator()
  const { render: renderLeaf } = require('./leaf-textures.cjs')
  const output = path.join(root, 'assets/vegetation/ez-tree')
  fs.mkdirSync(output, { recursive: true })
  const pinePng = fs.readFileSync(path.join(root, 'vendor/ez-tree-generator/src/app/public/textures/leaves/pine.png'))
  if (pinePng.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Missing PNG data for official pine texture')
  const leafPng = { pine: pinePng, ginkgo: renderLeaf('ginkgo', 256), sakura: renderLeaf('sakura', 256) }
  const details = [{ sectionStride: 2, segmentFactor: 0.5 },
    { sectionStride: 3, segmentFactor: 0.5, leafStride: 2, leafScale: 1.5, billboard: 'single' },
    { sectionStride: 6, segmentFactor: 0.5, leafStride: 8, leafScale: 2.2, billboard: 'single' },
    { sectionStride: 12, segmentFactor: 0.4, leafStride: 36, leafScale: 3.8, billboard: 'single' }]
  // The first three keep the fixed-point ids so points.json resolves unchanged; the
  // last two only feed the polygon scatter, whose type list is this typeMap's keys.
  const species = [
    { id: 'pine-02b', type: '松柏', leaf: 'pine', material: 'pine-needles', preset: 'Pine Small', form: 'columnar', height: 10.5, seed: 13977, tint: [0.82, 0.92, 0.78, 1], configure(options) {
      options.branch.length[0] = 48; options.branch.length[1] = 10
      options.branch.start[1] = 0.06; options.branch.children[0] = 104
      options.leaves.count = 26; options.leaves.size = 1.15; options.leaves.sizeVariance = 0.42
    } },
    { id: 'pine-02c', type: '松树', leaf: 'pine', material: 'pine-needles', preset: 'Pine Medium', form: 'spreading', height: 11.5, seed: 24831, tint: [0.95, 1, 0.84, 1], configure(options) {
      options.branch.length[0] = 48; options.branch.length[1] = 29
      options.branch.start[1] = 0.22; options.branch.children[0] = 76
      options.leaves.count = 34; options.leaves.size = 1.7; options.leaves.sizeVariance = 0.48
    } },
    { id: 'pine-02i', type: '松树01', leaf: 'pine', material: 'pine-needles', preset: 'Oak Medium', form: 'rounded', height: 9.5, seed: 38617, tint: [0.75, 0.88, 0.68, 1], configure(options) {
      options.branch.start[1] = 0.38; options.branch.length[1] = 22
      options.branch.length[2] = 12; options.branch.length[3] = 6
      options.branch.children[0] = 6; options.branch.children[1] = 3; options.branch.children[2] = 2
      options.leaves.count = 24; options.leaves.size = 2.8; options.leaves.sizeVariance = 0.6
    } },
    // Ginkgo: tall, wide, flat-fan leaves. Wider crown and fewer, larger cards keep
    // the fan shape legible instead of turning into a green haze.
    { id: 'ginkgo-01', type: '银杏', leaf: 'ginkgo', material: 'ginkgo-leaves', preset: 'Oak Medium', form: 'rounded', height: 12, seed: 57103, tint: [1, 0.86, 0.24, 1], configure(options) {
      options.branch.length[0] = 44; options.branch.length[1] = 26
      options.branch.start[1] = 0.42; options.branch.angle[1] = 58
      options.branch.length[2] = 13; options.branch.length[3] = 7
      options.branch.children[0] = 6; options.branch.children[1] = 3; options.branch.children[2] = 2
      options.branch.radius[0] = 1.5
      options.leaves.count = 26; options.leaves.size = 3.4; options.leaves.sizeVariance = 0.35
    } },
    // Cherry: small understory tree, pink blossom cards. Halved height and a
    // shallower crown read as a planted ornamental, not a canopy tree.
    { id: 'sakura-01', type: '樱花', leaf: 'sakura', material: 'sakura-blossom', preset: 'Oak Small', form: 'rounded', height: 6.5, seed: 62219, tint: [1, 0.62, 0.78, 1], configure(options) {
      options.branch.length[0] = 30; options.branch.length[1] = 18
      options.branch.start[1] = 0.5; options.branch.angle[1] = 58
      options.branch.length[2] = 10; options.branch.length[3] = 6
      options.branch.children[0] = 5; options.branch.children[1] = 3; options.branch.children[2] = 2
      options.branch.radius[0] = 1.1
      options.leaves.count = 30; options.leaves.size = 2.2; options.leaves.sizeVariance = 0.3
    } },
  ]
  const report = []
  for (const profile of species) {
    const tree = new Tree()
    tree.loadPreset(profile.preset)
    tree.options.seed = profile.seed
    profile.configure(tree.options)
    tree.generate()
    const levels = details.map(detail => tree.createGeometry(detail))
    const bounds = { min: Infinity, max: -Infinity }
    for (const level of levels) for (const geometry of [level.branches, level.leaves]) {
      const a = geometry.attributes.position.array
      for (let j = 1; j < a.length; j += 3) { bounds.min = Math.min(bounds.min, a[j]); bounds.max = Math.max(bounds.max, a[j]) }
    }
    const height = profile.height
    const bytes = packTree(levels, leafPng[profile.leaf], height, bounds, profile.tint, profile.material)
    const { json } = parseGlb(bytes)
    const triangles = json.meshes.map(mesh => mesh.primitives.reduce((n, p) => n + json.accessors[p.indices].count / 3, 0))
    if (triangles[0] > 14000 || triangles[3] > 900) throw new Error(`Tree budget exceeded for ${profile.id}: ${triangles}`)
    fs.writeFileSync(path.join(output, `${profile.id}.glb`), bytes)
    report.push({ id: profile.id, species: profile.type, form: profile.form,
      generatorPreset: profile.preset, height, url: `${profile.id}.glb`, triangles, bytes: bytes.length })
    for (const level of levels) { level.branches.dispose(); level.leaves.dispose() }
  }
  const original = JSON.parse(fs.readFileSync(path.join(root, 'assets/vegetation/manifest.json')))
  const generator = { repository: 'https://github.com/dgreenheck/ez-tree', commit: upstream }
  // Street points only name the three pine types; the extra keys are what makes the
  // polygon scatter rotate through five species.
  const typeMap = { ...original.typeMap, 银杏: 'ginkgo-01', 樱花: 'sakura-01' }
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({ ...original, typeMap, points: '../points.json', generator, prototypes: report }, null, 2) + '\n')
  fs.copyFileSync(path.join(root, 'vendor/ez-tree-generator/LICENSE'), path.join(output, 'LICENSE'))
  console.log(JSON.stringify({ generator, typeMap, prototypes: report }, null, 2))
}
if (require.main === module) prepare().catch(error => { console.error(error); process.exitCode = 1 })
