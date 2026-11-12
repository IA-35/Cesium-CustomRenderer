// Minimal PNG (gray+alpha) and GLB 2.0 writers for the procedural grass species.
// No third-party image/glTF dependency is needed for these tiny assets.
const zlib = require('node:zlib')

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/**
 * Encodes an 8-bit gray+alpha PNG.
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} grayAlpha Interleaved [gray, alpha] per pixel, row-major from the top.
 */
function encodeGrayAlphaPng(width, height, grayAlpha) {
  if (grayAlpha.length !== width * height * 2) throw new Error('PNG pixel buffer size mismatch')
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 4 // colour type: grayscale + alpha
  const rows = Buffer.alloc(height * (width * 2 + 1))
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 2 + 1)
    rows[rowStart] = 0 // filter: none
    Buffer.from(grayAlpha.buffer, grayAlpha.byteOffset + y * width * 2, width * 2).copy(rows, rowStart + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

const align4 = buffer => {
  const padding = (4 - (buffer.length % 4)) % 4
  return padding ? Buffer.concat([buffer, Buffer.alloc(padding)]) : buffer
}

/**
 * Writes a single-mesh, single-material GLB with an embedded PNG base colour.
 * @param {object} mesh {positions: Float32Array, normals: Float32Array, uvs: Float32Array, indices: Uint16Array}
 * @param {Buffer} png Embedded base colour image.
 * @param {object} options {name, alphaCutoff}
 */
function writeGlb(mesh, png, options) {
  const views = []
  const chunks = []
  let offset = 0
  const addView = (data, target) => {
    const bytes = align4(Buffer.from(data.buffer, data.byteOffset, data.byteLength))
    views.push({ buffer: 0, byteOffset: offset, byteLength: data.byteLength, ...(target ? { target } : {}) })
    chunks.push(bytes)
    offset += bytes.length
    return views.length - 1
  }
  const vertexCount = mesh.positions.length / 3
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < mesh.positions.length; i++) {
    min[i % 3] = Math.min(min[i % 3], mesh.positions[i])
    max[i % 3] = Math.max(max[i % 3], mesh.positions[i])
  }
  const position = addView(mesh.positions, 34962)
  const normal = addView(mesh.normals, 34962)
  const uv = addView(mesh.uvs, 34962)
  const index = addView(mesh.indices, 34963)
  const image = addView(png)
  const json = {
    asset: { version: '2.0', generator: 'CCR prepare-grass-species' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: options.name }],
    meshes: [{ name: options.name, primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
    materials: [{
      name: `${options.name}-material`,
      alphaMode: 'MASK',
      alphaCutoff: options.alphaCutoff,
      doubleSided: true,
      pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 },
    }],
    textures: [{ source: 0, sampler: 0 }],
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }],
    images: [{ bufferView: image, mimeType: 'image/png', name: 'grass-species-atlas' }],
    accessors: [
      { bufferView: position, componentType: 5126, count: vertexCount, type: 'VEC3', min, max },
      { bufferView: normal, componentType: 5126, count: vertexCount, type: 'VEC3' },
      { bufferView: uv, componentType: 5126, count: vertexCount, type: 'VEC2' },
      { bufferView: index, componentType: 5123, count: mesh.indices.length, type: 'SCALAR' },
    ],
    bufferViews: views,
    buffers: [{ byteLength: offset }],
  }
  let jsonBytes = Buffer.from(JSON.stringify(json), 'utf8')
  const jsonPadding = (4 - (jsonBytes.length % 4)) % 4
  jsonBytes = Buffer.concat([jsonBytes, Buffer.alloc(jsonPadding, 0x20)])
  const binary = Buffer.concat(chunks)
  const header = Buffer.alloc(12)
  header.write('glTF', 0, 'ascii')
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(12 + 8 + jsonBytes.length + 8 + binary.length, 8)
  const chunkHeader = (length, type) => {
    const buffer = Buffer.alloc(8)
    buffer.writeUInt32LE(length, 0)
    buffer.writeUInt32LE(type, 4)
    return buffer
  }
  return Buffer.concat([header, chunkHeader(jsonBytes.length, 0x4e4f534a), jsonBytes, chunkHeader(binary.length, 0x004e4942), binary])
}

module.exports = { crc32, encodeGrayAlphaPng, writeGlb }
