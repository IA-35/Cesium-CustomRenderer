// 把图书馆的无贴图玻璃材质改为纯镜面（metallic=1, rough≈0）。
// 只改 pbr-glass-clear 与 pbr-glass-skylight 两个槽位，其余（含带窗贴图的 M_nhtsg_窗1）不动。
// 用法：node scripts/fix-library-mirror.cjs <in.glb> <out.glb>
const fs = require('node:fs')
const inPath = process.argv[2]
const outPath = process.argv[3] || inPath
if (!inPath || !outPath) { console.error('用法: node scripts/fix-library-mirror.cjs <in.glb> <out.glb>'); process.exit(1) }

const buf = fs.readFileSync(inPath)
if (buf.readUInt32LE(0) !== 0x46546C67) { console.error('不是 GLB'); process.exit(1) }

let off = 12, json = null, bin = null
while (off < buf.length) {
  const len = buf.readUInt32LE(off), t = buf.readUInt32LE(off + 4)
  if (t === 0x4E4F534A) json = JSON.parse(buf.slice(off + 8, off + 8 + len).toString('utf8'))
  else if (t === 0x004E4942) bin = buf.slice(off + 8, off + 8 + len)
  off += 8 + len
}
if (!json) { console.error('未找到 JSON chunk'); process.exit(1) }

const targets = ['pbr-glass-clear-1.001', 'pbr-glass-skylight.001']
let changed = 0
json.materials.forEach((m, i) => {
  if (!targets.includes(m.name)) return
  const pbr = m.pbrMetallicRoughness || (m.pbrMetallicRoughness = {})
  pbr.metallicFactor = 1
  pbr.roughnessFactor = 0
  // 镜面不吸收颜色，但保留一个极浅的中性 baseColor 避免纯黑边缘
  pbr.baseColorFactor = [0.95, 0.95, 0.95, 1]
  delete m.alphaMode; delete m.alphaCutoff
  changed++
  console.log(`槽 ${i} ${m.name}: metallic=${pbr.metallicFactor}, rough=${pbr.roughnessFactor}`)
})
if (!changed) { console.error('未找到目标玻璃材质'); process.exit(1) }

let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8')
while (jsonBuf.length % 4) jsonBuf = Buffer.concat([jsonBuf, Buffer.from(' ')])
const total = 12 + 8 + jsonBuf.length + (bin ? 8 + bin.length : 0)
const out = Buffer.alloc(total)
out.writeUInt32LE(0x46546C67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(total, 8)
let w = 12
out.writeUInt32LE(jsonBuf.length, w); out.writeUInt32LE(0x4E4F534A, w + 4); w += 8
jsonBuf.copy(out, w); w += jsonBuf.length
if (bin) { out.writeUInt32LE(bin.length, w); out.writeUInt32LE(0x004E4942, w + 4); w += 8; bin.copy(out, w) }
fs.writeFileSync(outPath, out)
console.log(`输出: ${outPath} | ${buf.length} -> ${total} 字节`)
