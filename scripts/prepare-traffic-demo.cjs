// Original CC0 demo geometry: Y-up / Z-forward glTF cars and an ENU road loop.
const fs = require('node:fs'), path = require('node:path')
const C = require('cesium/Build/Cesium/index.cjs')
const folder = path.join(__dirname, '../examples/traffic-assets')
const networkOnly = process.argv.includes('--network-only')
fs.mkdirSync(folder, { recursive: true })
function mesh() { return { positions: [], normals: [], indices: [] } }
function box(target, center, size) {
  const faces = [[0, 1, 2], [0, -1, 2], [1, 1, 0], [1, -1, 0], [2, 1, 0], [2, -1, 0]]
  for (const [axis, sign, u] of faces) {
    const v = 3 - axis - u, normal = [0, 0, 0], first = target.positions.length / 3
    normal[axis] = sign
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]]
    const crossSign = ((u + 1) % 3 === v ? 1 : -1) * sign
    if (crossSign < 0) corners.reverse()
    for (const [a, b] of corners) {
      const point = [...center]; point[axis] += size[axis] / 2 * sign
      point[u] += size[u] / 2 * a; point[v] += size[v] / 2 * b
      target.positions.push(...point); target.normals.push(...normal)
    }
    target.indices.push(first, first + 1, first + 2, first, first + 2, first + 3)
  }
}
function writeGlb(file, meshes, materials, packedCar = false) {
  if (packedCar) {
    const merged = { ...mesh(), colors: [], texcoords: [] }
    meshes.forEach((data, part) => {
      const first = merged.positions.length / 3
      merged.positions.push(...data.positions); merged.normals.push(...data.normals)
      merged.indices.push(...data.indices.map(index => first + index))
      for (let i = 0; i < data.positions.length / 3; i++) {
        merged.colors.push(...materials[part][0])
        merged.texcoords.push((part + .5) / 4, .5)
      }
    })
    meshes = [merged]
  }
  const chunks = [], views = [], accessors = []; let offset = 0
  const add = (array, componentType, type, target) => {
    const bytes = Buffer.from(array.buffer), index = views.length
    views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target })
    chunks.push(bytes); offset += bytes.length
    const padding = (4 - offset % 4) % 4
    if (padding) { chunks.push(Buffer.alloc(padding)); offset += padding }
    const accessor = { bufferView: index, componentType, count: array.length / ({ VEC3: 3, VEC2: 2 }[type] || 1), type }
    if (type === 'VEC3') {
      accessor.min = [0, 1, 2].map(i => Math.min(...Array.from(array).filter((_, j) => j % 3 === i)))
      accessor.max = [0, 1, 2].map(i => Math.max(...Array.from(array).filter((_, j) => j % 3 === i)))
    }
    accessors.push(accessor); return accessors.length - 1
  }
  const primitives = meshes.map((data, material) => ({ attributes: {
    POSITION: add(new Float32Array(data.positions), 5126, 'VEC3', 34962),
    NORMAL: add(new Float32Array(data.normals), 5126, 'VEC3', 34962) },
    indices: add(new Uint16Array(data.indices), 5123, 'SCALAR', 34963), material }))
  if (packedCar) {
    primitives[0].attributes.COLOR_0 = add(new Float32Array(meshes[0].colors), 5126, 'VEC3', 34962)
    primitives[0].attributes.TEXCOORD_0 = add(new Float32Array(meshes[0].texcoords), 5126, 'VEC2', 34962)
  }
  const gltf = { asset: { version: '2.0', generator: 'CCR original traffic demo' }, scene: 0,
    scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives }],
    buffers: [{ byteLength: offset }], bufferViews: views, accessors,
    materials: materials.map(([color, metallic = 0, roughness = 0.8]) => ({ pbrMetallicRoughness: {
      baseColorFactor: [...color, 1], metallicFactor: metallic, roughnessFactor: roughness } })) }
  if (packedCar) {
    // Four constant material texels: G=roughness*300, B=metallic*300.
    // Multiplying sampled bytes by .85 (=255/300) preserves the original factors.
    gltf.materials = [{ pbrMetallicRoughness: { baseColorFactor: [1,1,1,1],
      metallicFactor: .85, roughnessFactor: .85, metallicRoughnessTexture: { index: 0 } } }]
    gltf.images = [{ uri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAABCAYAAAD5PA/NAAAAGklEQVR4nGP4X2Tz/7+H9///Hxj+///A8B8AXSkLGklfs/MAAAAASUVORK5CYII=' }]
    gltf.samplers = [{ magFilter: 9728, minFilter: 9728, wrapS: 33071, wrapT: 33071 }]
    gltf.textures = [{ source: 0, sampler: 0 }]
  }
  let json = Buffer.from(JSON.stringify(gltf)); json = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 32)])
  const binary = Buffer.concat(chunks), header = Buffer.alloc(20), binHeader = Buffer.alloc(8)
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + json.length + binary.length, 8)
  header.writeUInt32LE(json.length, 12); header.writeUInt32LE(0x4e4f534a, 16)
  binHeader.writeUInt32LE(binary.length, 0); binHeader.writeUInt32LE(0x004e4942, 4)
  fs.writeFileSync(path.join(folder, file), Buffer.concat([header, json, binHeader, binary]))
}
if (!networkOnly) for (const [name, color] of [['blue', [.08, .29, .4]], ['ivory', [.83, .81, .68]], ['orange', [.88, .28, .08]]]) {
  const body = mesh(), windows = mesh(), tires = mesh(), lamps = mesh()
  box(body, [0, .67, 0], [1.8, .62, 4.3]); box(body, [0, 1.09, -.25], [1.52, .55, 2.3])
  box(windows, [0, 1.18, -.25], [1.54, .3, 1.98])
  for (const x of [-.86, .86]) for (const z of [-1.34, 1.34]) box(tires, [x, .34, z], [.26, .68, .68])
  for (const x of [-.58, .58]) box(lamps, [x, .69, 2.16], [.42, .16, .035])
  writeGlb(`car-${name}.glb`, [body, windows, tires, lamps], [[color, .2, .38], [[.035, .07, .09], .25, .24], [[.035, .038, .04]], [[.96, .91, .65]]], true)
}
if (process.argv.includes('--cars-only')) process.exit(0)
function loop(inset = 0) {
  const points = [], radius = 22 - inset
  for (const [x, y, start] of [[38, 12, 0], [-38, 12, 90], [-38, -12, 180], [38, -12, 270]]) {
    for (let step = 0; step <= 12; step++) {
      const angle = (start + step * 7.5) * Math.PI / 180
      points.push([x + radius * Math.cos(angle), y + radius * Math.sin(angle)])
    }
  }
  points.push([...points[0]]); return points
}
const ground = mesh(), road = mesh(), markings = mesh()
box(ground, [0, -.16, 0], [140, .2, 190])
function ribbon(target, outer, inner, height) {
  for (let i = 0; i < outer.length; i++) for (const point of [outer[i], inner[i]]) {
    target.positions.push(point[1], height, point[0]); target.normals.push(0, 1, 0)
  }
  for (let i = 0; i < outer.length - 1; i++) {
    const a = i * 2; target.indices.push(a, a + 2, a + 3, a, a + 3, a + 1)
  }
}
ribbon(road, loop(-4), loop(8), .015)
ribbon(markings, loop(-3), loop(-2.8), .025)
ribbon(markings, loop(6.8), loop(7), .025)
if (!networkOnly) writeGlb('ground.glb', [ground, road, markings], [[[.39, .48, .38]], [[.09, .115, .13]], [[.74, .75, .64]]])
const origin = { longitude: 123.42, latitude: 41.77, height: 0 }
const matrix = C.Transforms.eastNorthUpToFixedFrame(C.Cartesian3.fromDegrees(origin.longitude, origin.latitude, 0))
const geographic = points => points.map(([east, north]) => {
  const world = C.Matrix4.multiplyByPoint(matrix, new C.Cartesian3(east, north, .03), new C.Cartesian3())
  const point = C.Cartographic.fromCartesian(world)
  return [C.Math.toDegrees(point.longitude), C.Math.toDegrees(point.latitude), point.height]
})
const routes = { type: 'FeatureCollection', features: [loop(0), loop(4).reverse()].map((points, i) => ({
  type: 'Feature', id: `lane-${i + 1}`, properties: {}, geometry: { type: 'LineString', coordinates: geographic(points) } })) }
const manifest = { schemaVersion: 1, origin, routes, vehicles: Array.from({ length: 24 }, (_, i) => ({
  id: `car-${i + 1}`, routeId: `lane-${i < 12 ? 1 : 2}`, url: `car-${['blue', 'ivory', 'orange'][i % 3]}.glb`,
  speed: Number((6 + ((i * 7) % 24) * .2).toFixed(1)) })) }
if (!networkOnly) fs.writeFileSync(path.join(folder, 'traffic.json'), JSON.stringify(manifest, null, 2) + '\n')

// A cross and a T junction, with four separate entry locations and dead ends.
const nodePoints = { W: [-90, 0], C: [0, 0], E: [90, 0], N: [0, 70], S: [0, -70], Q: [75, 70] }
const streets = [['W', 'C'], ['C', 'E'], ['C', 'N'], ['C', 'S'], ['N', 'Q']]
const networkGround = mesh(), networkRoad = mesh(), networkMarkings = mesh()
box(networkGround, [0, -.16, 0], [220, .2, 260])
for (const [from, to] of streets) {
  const a = nodePoints[from], b = nodePoints[to], dx = Math.abs(b[0] - a[0]), dy = Math.abs(b[1] - a[1])
  box(networkRoad, [(a[1] + b[1]) / 2, .005, (a[0] + b[0]) / 2], [dy + 10, .02, dx + 10])
  const length = Math.hypot(dx, dy)
  for (let along = 12; along < length - 10; along += 7) {
    const east = a[0] + (b[0] - a[0]) * along / length
    const north = a[1] + (b[1] - a[1]) * along / length
    box(networkMarkings, [north, .023, east], [dy ? 3 : .15, .01, dx ? 3 : .15])
  }
}
writeGlb('network-ground.glb', [networkGround, networkRoad, networkMarkings],
  [[[.39, .48, .38]], [[.09, .115, .13]], [[.74, .75, .64]]])
const spawnNodes = new Set(['W', 'E', 'S', 'Q'])
const networkFeatures = streets.flatMap(([a, b]) => [[a, b], [b, a]]).map(([from, to]) => {
  const start = nodePoints[from], end = nodePoints[to], dx = end[0] - start[0], dy = end[1] - start[1]
  const length = Math.hypot(dx, dy), right = [dy / length * 2.4, -dx / length * 2.4]
  const points = [0, 12, length - 12, length].map((along, i) => [
    start[0] + dx * along / length + right[0] * (i === 0 || i === 3 ? 0 : 1),
    start[1] + dy * along / length + right[1] * (i === 0 || i === 3 ? 0 : 1)])
  return { type: 'Feature', id: `${from.toLowerCase()}-${to.toLowerCase()}`,
    properties: { from, to, spawn: spawnNodes.has(from), priority: from === 'W' || from === 'E' ? 1 : 0 },
    geometry: { type: 'LineString', coordinates: geographic(points) } }
})
const counts = networkFeatures.map((_, index) => Array.from({ length: 24 }, (_, i) => i).filter(i => i % networkFeatures.length === index).length)
const networkManifest = { schemaVersion: 1, origin, network: { type: 'FeatureCollection', features: networkFeatures },
  vehicles: Array.from({ length: 24 }, (_, i) => {
    const laneIndex = i % networkFeatures.length, feature = networkFeatures[laneIndex]
    const positions = feature.geometry.coordinates.map(p => C.Cartesian3.fromDegrees(...p))
    const length = positions.slice(1).reduce((total, p, j) => total + C.Cartesian3.distance(positions[j], p), 0)
    return { id: `car-${i + 1}`, routeId: feature.id, url: `car-${['blue', 'ivory', 'orange'][i % 3]}.glb`,
      speed: Number((6 + ((i * 7) % 24) * .2).toFixed(1)),
      offset: length * (Math.floor(i / networkFeatures.length) + .5) / counts[laneIndex], length: 4.3, width: 1.8 }
  }) }
fs.writeFileSync(path.join(folder, 'network.json'), JSON.stringify(networkManifest, null, 2) + '\n')
console.log(`Traffic demo assets: ${folder}`)
