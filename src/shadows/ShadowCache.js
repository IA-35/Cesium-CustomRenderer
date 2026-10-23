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
// 快速比对时 uniform 值的抽查轮数：每次刷新复查 1/N 的投影体，N 次刷新覆盖全部。
// 默认阴影每 2 帧刷新，静态投影体的材质变化最迟约 16 帧（60 fps 下约 0.27 s）后反映到阴影；
// 需要立刻生效时调用 invalidate()。
export const UNIFORM_CHECK_ROUNDS = 8

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
    // 快速比对的已提交快照：按提交顺序的命令引用与逐条记录（与 records 池在 commit 时互换，不复制）。
    this.orderCommands = []; this.orderRecords = []; this.nextOrderCommands = []; this.scratch = []
    this.pendingKeep = false; this.uniformCursor = 0
  }
  // 带蒙皮、形变或自定义顶点变换的 Shader，以及尚未初始化 uniform 列表的程序，不能静态缓存。
  // program 应是真正写深度的那个程序：阴影 pass 传投影程序，因为 command.shaderProgram 可能已被
  // 接收体换成从不绑定的接收程序（其 _manualUniforms 永远为空）。
  static cacheable(command, program = command.shaderProgram) {
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
  // 记录 = 固定字段（几何、程序、状态、绘制范围、模型矩阵）+ 活动 uniform 值。
  fixedFields(out, command, program) {
    out.push(command.vertexArray ? this.identity(command.vertexArray) : 0, program.id, command.renderState?.id, command.count, command.offset,
      command.instanceCount, command.primitiveType, command.pass)
    this.push(out, command.modelMatrix)
  }
  uniformValues(out, command, program) {
    for (const uniform of program._manualUniforms) this.push(out, command.uniformMap[uniform.name]())
  }
  record(index, command, program) {
    const out = this.records[index] ??= []
    out.length = 0
    this.fixedFields(out, command, program)
    this.uniformValues(out, command, program)
    return out
  }
  // 命令对象与顺序都没变时的快速比对：逐条比固定字段，uniform 值只复查轮到的一片。
  // 任何不一致都返回 false，由调用方退回完整签名（完整签名对顺序变化与等价替换仍然正确）。
  sameAsCommitted(commands, programOf) {
    const refs = this.orderCommands, stored = this.orderRecords, n = commands.length
    if (refs.length !== n) return false
    const slice = Math.ceil(n / UNIFORM_CHECK_ROUNDS), start = n ? this.uniformCursor % n : 0, out = this.scratch
    for (let i = 0; i < n; i++) {
      const command = commands[i]
      if (command !== refs[i]) return false
      const program = programOf(command), previous = stored[i]
      out.length = 0
      this.fixedFields(out, command, program)
      const sampled = (i - start + n) % n < slice
      if (sampled) this.uniformValues(out, command, program)
      if (sampled ? out.length !== previous.length : out.length > previous.length) return false
      for (let k = 0; k < out.length; k++) if (!same(out[k], previous[k])) return false
    }
    this.uniformCursor = start + slice
    return true
  }
  // 返回 true 表示已提交的深度内容仍可复用；无论结果如何，随后都可调用 commit 记录本次状态。
  // programOf 给出每条命令实际写深度的程序（见 cacheable），默认取 command.shaderProgram。
  matches(matrix, size, commands, programOf = command => command.shaderProgram) {
    const header = this.nextHeader
    header.length = 0
    header.push(this.revision, size, commands.length)
    for (let i = 0; i < MATRIX_LENGTH; i++) header.push(matrix?.[i])
    this.pendingHeaderSame = false; this.pendingDetail = false; this.pendingKeep = false
    for (const command of commands) if (!ShadowCache.cacheable(command, programOf(command))) return false
    if (!this.valid || !sameValues(header, this.header)) return false
    this.pendingHeaderSame = true
    if (this.detailValid && this.sameAsCommitted(commands, programOf)) { this.pendingKeep = true; return true }
    // Opaque/MASK depth writes with LEQUAL produce the same minimum depth
    // regardless of the main camera's tile traversal order.
    const sorted = this.sorted
    sorted.length = 0
    for (let i = 0; i < commands.length; i++) sorted.push(this.record(i, commands[i], programOf(commands[i])))
    sorted.sort(compareRecords)
    const detail = this.nextDetail
    detail.length = 0
    for (const item of sorted) { detail.push(item.length); for (const value of item) detail.push(value) }
    const order = this.nextOrderCommands
    order.length = 0
    for (const command of commands) order.push(command)
    if (this.detailValid && sameValues(detail, this.detail)) {
      // 完整签名命中（如仅顺序变化）：明细不变，直接采用本次顺序作为快速比对快照。
      // 调用方命中时通常不 commit，这里不采用的话之后每次都会退回完整签名。
      ;[this.orderRecords, this.records] = [this.records, this.orderRecords]
      ;[this.orderCommands, this.nextOrderCommands] = [this.nextOrderCommands, this.orderCommands]
      this.pendingKeep = true
      return true
    }
    this.pendingDetail = true
    return false
  }
  commit() {
    ;[this.header, this.nextHeader] = [this.nextHeader, this.header]
    if (this.pendingDetail) {
      ;[this.detail, this.nextDetail] = [this.nextDetail, this.detail]
      ;[this.orderRecords, this.records] = [this.records, this.orderRecords]
      ;[this.orderCommands, this.nextOrderCommands] = [this.nextOrderCommands, this.orderCommands]
    }
    // 快速比对命中时已提交的明细与快照原样有效。
    this.detailValid = this.pendingDetail || (this.pendingKeep && this.detailValid)
    this.pendingKeep = false
    this.valid = true
  }
}
