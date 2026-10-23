// Static caching is opt-in: the caller promises textures and instance buffers
// are immutable, or calls invalidate after changing their contents. Dynamic is default.
//
// 签名分两级，全程复用数值数组，不生成字符串：
// 1. 头部：revision、贴图尺寸、caster 数量、光源 VP。任一不同即判定失效，跳过逐 caster 序列化。
//    相机移动或太阳移动时 VP 每次刷新都变，这一步就把整次签名省掉。
// 2. 明细：每个 caster 一条数值记录（资源身份、program/renderState id、绘制范围、模型矩阵、
//    活动 uniform 值），按字典序排序后与上次逐元素比较。
// 头部刚变化的那次刷新不记录明细，下一次头部一致时再补算并重画一次，之后才命中缓存。
const DEFORMING = /SKINNING|MORPH|CUSTOM_VERTEX/
const MATRIX_LENGTH = 16

const same = (a, b) => a === b || (a !== a && b !== b)

function sameValues(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (!same(a[i], b[i])) return false
  return true
}

function compareRecords(a, b) {
  const length = Math.min(a.length, b.length)
  for (let i = 0; i < length; i++) {
    const x = a[i], y = b[i]
    if (same(x, y)) continue
    if (typeof x === 'number' && typeof y === 'number') return x < y || y !== y ? -1 : 1
    return String(x) < String(y) ? -1 : 1
  }
  return a.length - b.length
}

export default class ShadowCache {
  constructor() {
    this.revision = 0; this.identities = new WeakMap(); this.nextId = 1
    this.header = []; this.detail = []; this.valid = false; this.detailValid = false
    // 下面这些是逐帧复用的暂存区，commit 时与已提交数组交换。
    this.nextHeader = []; this.nextDetail = []; this.records = []; this.sorted = []
    this.pendingHeaderSame = false; this.pendingDetail = false
  }
  // 带蒙皮、形变或自定义顶点变换的 Shader，以及尚未初始化 uniform 列表的程序，不能静态缓存。
  static cacheable(command) {
    const program = command.shaderProgram
    return !!program?._manualUniforms && !program.vertexShaderSource?.defines?.some(d => DEFORMING.test(d))
  }
  invalidate() { this.valid = false; this.detailValid = false; this.revision++ }
  identity(value) {
    let id = this.identities.get(value)
    if (id === undefined) { id = this.nextId++; this.identities.set(value, id) }
    return id
  }
  // OccluderCache143 复用的结构化取值：返回可 JSON 序列化的值，资源对象以身份编号表示。
  value(value) {
    if (value === null || typeof value !== 'object') return value
    if (Array.isArray(value) || ArrayBuffer.isView(value)) return Array.from(value, v => this.value(v))
    if (typeof value.x === 'number') return [value.x, value.y, value.z, value.w]
    if (typeof value.red === 'number') return [value.red, value.green, value.blue, value.alpha]
    if (typeof value[0] === 'number') return Array.from({ length: MATRIX_LENGTH }, (_, i) => value[i])
    return { resource: this.identity(value) }
  }
  push(out, value) {
    if (value === null || typeof value !== 'object') { out.push(value); return }
    if (Array.isArray(value) || ArrayBuffer.isView(value)) {
      out.push(value.length)
      for (let i = 0; i < value.length; i++) this.push(out, value[i])
      return
    }
    if (typeof value.x === 'number') { out.push(value.x, value.y, value.z, value.w); return }
    if (typeof value.red === 'number') { out.push(value.red, value.green, value.blue, value.alpha); return }
    if (typeof value[0] === 'number') { for (let i = 0; i < MATRIX_LENGTH; i++) out.push(value[i]); return }
    out.push(-this.identity(value))
  }
  record(index, command) {
    const out = this.records[index] ??= []
    out.length = 0
    const program = command.shaderProgram
    out.push(command.vertexArray ? this.identity(command.vertexArray) : 0, program.id, command.renderState?.id, command.count, command.offset,
      command.instanceCount, command.primitiveType, command.pass)
    this.push(out, command.modelMatrix)
    for (const uniform of program._manualUniforms) this.push(out, command.uniformMap[uniform.name]())
    return out
  }
  // 返回 true 表示已提交的深度内容仍可复用；无论结果如何，随后都可调用 commit 记录本次状态。
  matches(matrix, size, commands) {
    const header = this.nextHeader
    header.length = 0
    header.push(this.revision, size, commands.length)
    for (let i = 0; i < MATRIX_LENGTH; i++) header.push(matrix?.[i])
    this.pendingHeaderSame = false; this.pendingDetail = false
    for (const command of commands) if (!ShadowCache.cacheable(command)) return false
    if (!this.valid || !sameValues(header, this.header)) return false
    this.pendingHeaderSame = true
    // Opaque/MASK depth writes with LEQUAL produce the same minimum depth
    // regardless of the main camera's tile traversal order.
    const sorted = this.sorted
    sorted.length = 0
    for (let i = 0; i < commands.length; i++) sorted.push(this.record(i, commands[i]))
    sorted.sort(compareRecords)
    const detail = this.nextDetail
    detail.length = 0
    for (const item of sorted) { detail.push(item.length); for (const value of item) detail.push(value) }
    this.pendingDetail = true
    return this.detailValid && sameValues(detail, this.detail)
  }
  commit() {
    ;[this.header, this.nextHeader] = [this.nextHeader, this.header]
    if (this.pendingDetail) [this.detail, this.nextDetail] = [this.nextDetail, this.detail]
    this.detailValid = this.pendingDetail
    this.valid = true
  }
}
