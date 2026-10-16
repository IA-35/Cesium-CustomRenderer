// 把新图书馆 GLB 的玻璃材质改为不透明金属感镜面，并直接写回 GLB 二进制。
// 用法：node scripts/fix-library-glass.cjs <输入.glb> [输出.glb]
// 默认输出覆盖输入（调用前请自行备份）。改动只针对材质名含 glass / 窗 / skylight 的槽位。
const fs = require('node:fs')

const inPath = process.argv[2]
const outPath = process.argv[3] || inPath
if (!inPath) { console.error('用法: node scripts/fix-library-glass.cjs <input.glb> [output.glb]'); process.exit(1) }

const buf = fs.readFileSync(inPath)
if (buf.readUInt32LE(0) !== 0x46546C67) { console.error('不是 GLB 文件'); process.exit(1) }

// 解析 chunk
let jsonChunk = null, jsonOffset = 0, jsonLength = 0
let binChunk = null
let off = 12
while (off < buf.length) {
  const len = buf.readUInt32LE(off)
  const type = buf.readUInt32LE(off + 4)
  if (type === 0x4E4F534A) { // JSON
    jsonChunk = buf.slice(off + 8, off + 8 + len)
    jsonOffset = off + 8
    jsonLength = len
  } else if (type === 0x004E4942) { // BIN
    binChunk = buf.slice(off + 8, off + 8 + len)
  }
  off += 8 + len
}
if (!jsonChunk) { console.error('未找到 JSON chunk'); process.exit(1) }

const gltf = JSON.parse(jsonChunk.toString('utf8'))
const materials = gltf.materials || []

// 目标：玻璃材质（名字含 glass / 窗 / skylight / 玻璃）
const isGlass = name => /glass|skylight|窗|玻璃/i.test(name || '')
const glassIndices = []
materials.forEach((m, i) => { if (isGlass(m.name)) glassIndices.push(i) })

if (glassIndices.length === 0) { console.log('未找到玻璃材质，跳过。'); process.exit(0) }

let changed = 0
for (const i of glassIndices) {
  const m = materials[i]
  const pbr = m.pbrMetallicRoughness || (m.pbrMetallicRoughness = {})
  const before = { metallic: pbr.metallicFactor, rough: pbr.roughnessFactor, alphaMode: m.alphaMode }
  pbr.metallicFactor = 0.9
  pbr.roughnessFactor = 0.1
  if (m.alphaMode && m.alphaMode !== 'OPAQUE') { delete m.alphaMode; changed++ }
  if (m.alphaCutoff !== undefined) { delete m.alphaCutoff; changed++ }
  if (pbr.baseColorFactor && pbr.baseColorFactor.length === 4) pbr.baseColorFactor[3] = 1
  changed++
  console.log(`  槽位 ${i} ${m.name}: metallic ${before.metallic}->0.9, rough ${before.rough}->0.1, alphaMode ${before.alphaMode || 'OPAQUE'}`)
}

// 重新序列化 JSON，并做 4 字节对齐（空格填充）
let jsonBuf = Buffer.from(JSON.stringify(gltf), 'utf8')
while (jsonBuf.length % 4 !== 0) jsonBuf = Buffer.concat([jsonBuf, Buffer.from(' ')])

// 重新组装 GLB：12 头 + JSON chunk(8+len) + BIN chunk(8+len)
const jsonChunkLen = jsonBuf.length
const binLen = binChunk ? binChunk.length : 0
const totalLen = 12 + 8 + jsonChunkLen + (binChunk ? 8 + binLen : 0)

const out = Buffer.alloc(totalLen)
out.writeUInt32LE(0x46546C67, 0)
out.writeUInt32LE(2, 4)
out.writeUInt32LE(totalLen, 8)
let w = 12
out.writeUInt32LE(jsonChunkLen, w); out.writeUInt32LE(0x4E4F534A, w + 4); w += 8
jsonBuf.copy(out, w); w += jsonChunkLen
if (binChunk) {
  out.writeUInt32LE(binLen, w); out.writeUInt32LE(0x004E4942, w + 4); w += 8
  binChunk.copy(out, w); w += binLen
}

fs.writeFileSync(outPath, out)
console.log(`完成：${glassIndices.length} 个玻璃材质改为镜面，输出 ${outPath}`)
console.log(`  原 JSON ${jsonLength} -> 新 ${jsonChunkLen} 字节；总长 ${buf.length} -> ${totalLen} 字节`)
