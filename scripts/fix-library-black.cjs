// 修复图书馆 GLB 的「发黑」问题：把缺省 metallicFactor 的材质显式设为 0。
// 传统 FBX/Blender 导出省略 metallicFactor，glTF 默认 1，Cesium 渲染成黑色金属。
// 只改缺省金属度且无金属度贴图的槽位，其余（玻璃、主体、贴图）一律不动。
// 用法：node scripts/fix-library-black.cjs <源.glb> <输出.glb>
const fs = require('node:fs')
const inPath = process.argv[2]
const outPath = process.argv[3] || inPath
if (!inPath || !outPath) { console.error('用法: node scripts/fix-library-black.cjs <in.glb> <out.glb>'); process.exit(1) }

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

let fixed = 0
const fixedIndices = []
json.materials.forEach((m, i) => {
  const pbr = m.pbrMetallicRoughness || (m.pbrMetallicRoughness = {})
  if ((pbr.metallicFactor === undefined || pbr.metallicFactor === 1) && !pbr.metallicRoughnessTexture) {
    pbr.metallicFactor = 0
    fixed++
    fixedIndices.push(i)
  }
})
console.log(`修复 ${fixed} 个发黑材质槽位:`, JSON.stringify(fixedIndices))

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
