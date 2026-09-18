// 3D Tiles 量化诊断：统计每个瓦片的 draw call（primitive）数、三角形数、材质共享率。
//
// 背景：Dongda 分层 3D Tiles（每栋楼每层一个瓦片）的性能瓶颈是 draw call 数量，
// 而不是调度。本脚本不依赖任何第三方 glTF 库，直接用 Node 解析 glTF 2.0 的
// JSON chunk（glb）与 b3dm 内嵌 glb，统计：
//   - 每个瓦片的 primitive 数（≈ draw call 数）
//   - 每个瓦片的三角形总数
//   - 每个瓦片的材质数量与「primitive↔材质」共享率（材质共享率越低，合批收益越大）
//   - 室内(SN) / 室外(SW) 归类（按文件名前缀）
//
// 用法：node scripts/diagnose-tileset-drawcalls.cjs [tileset 根目录]

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.argv[2] || 'G:/ZN/nginx-1.26.3/html/Dongda'

// 从 glb 二进制解析出 glTF JSON + 三角形统计。
// 返回 { nodes, meshes, materials, primitives, triangles, hasFeatureId }
function parseGlb(buffer) {
  const magic = buffer.slice(0, 4).toString('ascii')
  if (magic !== 'glTF') throw new Error(`not a glb: ${magic}`)
  const jsonLen = buffer.readUInt32LE(12)
  const gltf = JSON.parse(buffer.slice(20, 20 + jsonLen).toString('utf8'))

  let primitives = 0
  let triangles = 0
  const meshCount = (gltf.meshes || []).length
  const materialCount = (gltf.materials || []).length
  const materialUsage = new Set()
  let hasFeatureId = false

  for (const mesh of gltf.meshes || []) {
    for (const prim of mesh.primitives || []) {
      primitives++
      if (prim.indices != null) {
        const acc = gltf.accessors && gltf.accessors[prim.indices]
        if (acc) triangles += Math.floor(acc.count / 3)
      } else {
        const posAcc = gltf.accessors && prim.attributes && gltf.accessors[prim.attributes.POSITION]
        if (posAcc) triangles += Math.floor(posAcc.count / 3)
      }
      if (prim.material != null) materialUsage.add(prim.material)
      const attrs = prim.attributes || {}
      if (attrs._FEATURE_ID_0 != null || attrs._BATCHID != null) hasFeatureId = true
    }
  }

  return {
    nodes: (gltf.nodes || []).length,
    meshes: meshCount,
    materials: materialCount,
    primitives,
    triangles,
    materialUsage: materialUsage.size,
    hasFeatureId
  }
}

// 从 b3dm 解析内嵌 glb。b3dm 布局：
//   [0..4) magic 'b3dm' [4..8) version [8..12) byteLength
//   [12..16) featureTableJSONByteLength [16..20) featureTableBinaryByteLength
//   [20..24) batchTableJSONByteLength [24..28) batchTableBinaryByteLength
//   [28..28+featureTableJSON+featureTableBinary+batchTableJSON+batchTableBinary) 表
//   [之后..] 内嵌 glb
function parseB3dm(buffer) {
  const magic = buffer.slice(0, 4).toString('ascii')
  if (magic !== 'b3dm') throw new Error(`not a b3dm: ${magic}`)
  const ftJson = buffer.readUInt32LE(12)
  const ftBin = buffer.readUInt32LE(16)
  const btJson = buffer.readUInt32LE(20)
  const btBin = buffer.readUInt32LE(24)
  const glbStart = 28 + ftJson + ftBin + btJson + btBin
  const glb = buffer.slice(glbStart)
  return parseGlb(glb)
}

function classify(filePath) {
  // 室内/室外：这些 glb 文件名都是 NoLod_*.glb，楼层/部位信息在**目录名**里。
  // 上游 FBX 用 SN(室内)/SW(室外) 区分，但导出成 tiles 后目录名是 1F/2F/主体/屋顶。
  // 因此这里按「是否可识别楼层」归类，并单独标记「主体/屋顶」等结构件。
  const lower = filePath.toLowerCase().replace(/\\/g, '/')
  const dirs = lower.split('/')
  const parts = dirs.join('/')
  if (/室内|_sn|\.sn\b|sn[-_/]/.test(parts) && !/室外/.test(parts)) return 'indoor'
  if (/室外|_sw|\.sw\b|sw[-_/]/.test(parts)) return 'outdoor'
  // 楼层目录：1F/2F/3F... 或 1f/2f...（这些是从 FBX 的室内(SN)或室外(SW)导出的楼层）
  if (/\b\d+[fF]\b/.test(dirs[dirs.length - 2] || '')) return 'floor'
  if (/(主体|屋顶|roof|main)/.test(dirs[dirs.length - 2] || '')) return 'structure'
  return 'unknown'
}

function walkTilesets(root) {
  const tilesets = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const tj = path.join(root, entry.name, 'tileset.json')
    if (!fs.existsSync(tj)) continue
    tilesets.push(path.join(root, entry.name))
  }
  return tilesets
}

// 递归收集目录下所有 .glb / .b3dm 文件（外部 tileset 嵌套时瓦片散落在子目录）。
function collectTileFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) collectTileFiles(full, out)
    else if (/\.(glb|b3dm)$/i.test(entry.name)) out.push(full)
  }
  return out
}

function main() {
  const tilesets = walkTilesets(ROOT)
  const report = { root: ROOT, tilesets: [], totals: {} }

  let grandPrimitives = 0, grandTriangles = 0, grandTiles = 0
  let grandMaterials = 0, grandMaterialUsage = 0
  const byClass = { indoor: { tiles: 0, primitives: 0, triangles: 0 }, outdoor: { tiles: 0, primitives: 0, triangles: 0 }, floor: { tiles: 0, primitives: 0, triangles: 0 }, structure: { tiles: 0, primitives: 0, triangles: 0 }, unknown: { tiles: 0, primitives: 0, triangles: 0 } }

  for (const ts of tilesets) {
    const name = path.basename(ts)
    const tiles = []
    for (const full of collectTileFiles(ts)) {
      const f = path.relative(ts, full)
      try {
        const buffer = fs.readFileSync(full)
        const info = f.toLowerCase().endsWith('.b3dm') ? parseB3dm(buffer) : parseGlb(buffer)
        const cls = classify(f)
        tiles.push({ file: f, class: cls, ...info })
      } catch (error) {
        tiles.push({ file: f, error: error.message })
      }
    }
    const tsPrimitives = tiles.reduce((a, t) => a + (t.primitives || 0), 0)
    const tsTriangles = tiles.reduce((a, t) => a + (t.triangles || 0), 0)
    const tsMaterials = tiles.reduce((a, t) => a + (t.materials || 0), 0)
    const tsUsage = tiles.reduce((a, t) => a + (t.materialUsage || 0), 0)
    report.tilesets.push({
      name,
      tileCount: tiles.length,
      primitives: tsPrimitives,
      triangles: tsTriangles,
      materials: tsMaterials,
      materialUsage: tsUsage,
      tiles
    })
    grandPrimitives += tsPrimitives
    grandTriangles += tsTriangles
    grandMaterials += tsMaterials
    grandMaterialUsage += tsUsage
    grandTiles += tiles.length
    for (const t of tiles) {
      if (!t.primitives) continue
      byClass[t.class].tiles++
      byClass[t.class].primitives += t.primitives
      byClass[t.class].triangles += t.triangles
    }
  }

  report.totals = {
    tilesetCount: tilesets.length,
    tileCount: grandTiles,
    primitives: grandPrimitives,
    triangles: grandTriangles,
    materials: grandMaterials,
    materialUsage: grandMaterialUsage,
    materialSharingRatio: grandMaterials ? (grandMaterialUsage / grandMaterials) : 0,
    byClass
  }

  // 写报告
  const outDir = path.join(process.cwd(), 'docs/verification/tileset-diagnosis')
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, 'drawcall-report.json'), JSON.stringify(report, null, 2))

  // 命令行摘要
  console.log('=== 3D Tiles draw call 诊断 ===')
  console.log(`根目录: ${ROOT}`)
  console.log(`tileset 数: ${report.totals.tilesetCount}`)
  console.log(`瓦片(glb/b3dm) 数: ${report.totals.tileCount}`)
  console.log(`总 primitive(draw call) 数: ${report.totals.primitives}`)
  console.log(`总三角形数: ${report.totals.triangles.toLocaleString()}`)
  console.log(`总材质数: ${report.totals.materials}, 实际被引用: ${report.totals.materialUsage}`)
  console.log('')
  console.log('--- 按 tileset ---')
  for (const ts of report.tilesets) {
    console.log(`${ts.name.padEnd(22)} tiles=${String(ts.tileCount).padStart(2)}  drawcalls=${String(ts.primitives).padStart(5)}  tris=${ts.triangles.toLocaleString().padStart(10)}  materials=${ts.materials}`)
  }
  console.log('')
  console.log('--- 室内/室外归类 ---')
  for (const [cls, c] of Object.entries(report.totals.byClass)) {
    console.log(`${cls.padEnd(8)} tiles=${String(c.tiles).padStart(2)}  drawcalls=${String(c.primitives).padStart(5)}  tris=${c.triangles.toLocaleString().padStart(10)}`)
  }
  console.log('')
  console.log(`报告已写入: ${path.join(outDir, 'drawcall-report.json')}`)
}

main()
