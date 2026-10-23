export default class UniformBuffer143 {
  constructor(gl, byteLength) {
    if (!Number.isSafeInteger(byteLength) || byteLength <= 0 || byteLength % 16 ||
        byteLength > gl.getParameter(gl.MAX_UNIFORM_BLOCK_SIZE)) throw new Error('Invalid uniform buffer size')
    this.gl = gl
    this.byteLength = byteLength
    this.shadow = new Uint8Array(byteLength)
    this.initialized = false
    this.uploads = 0
    this.uploadedBytes = 0
    this.buffer = gl.createBuffer()
    if (!this.buffer) throw new Error('Uniform buffer allocation failed')
    const previous = gl.getParameter(gl.UNIFORM_BUFFER_BINDING)
    try {
      gl.bindBuffer(gl.UNIFORM_BUFFER, this.buffer)
      gl.bufferData(gl.UNIFORM_BUFFER, byteLength, gl.DYNAMIC_DRAW)
      if (gl.getBufferParameter && gl.getBufferParameter(gl.UNIFORM_BUFFER, gl.BUFFER_SIZE) !== byteLength) throw new Error('Uniform buffer storage allocation failed')
    } catch (error) {
      this.destroy()
      throw error
    } finally { gl.bindBuffer(gl.UNIFORM_BUFFER, previous) }
  }

  update(data) {
    if (this.destroyed) throw new Error('Uniform buffer is destroyed')
    if (!ArrayBuffer.isView(data) || data.byteLength !== this.byteLength) throw new Error('Uniform buffer data size mismatch')
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    let start = 0, end = bytes.length
    if (this.initialized) {
      while (start < end && bytes[start] === this.shadow[start]) start++
      if (start === end) return 0
      while (end > start && bytes[end - 1] === this.shadow[end - 1]) end--
      start = Math.floor(start / 4) * 4
      end = Math.ceil(end / 4) * 4
    }
    const gl = this.gl, previous = gl.getParameter(gl.UNIFORM_BUFFER_BINDING)
    try {
      gl.bindBuffer(gl.UNIFORM_BUFFER, this.buffer)
      gl.bufferSubData(gl.UNIFORM_BUFFER, start, bytes.subarray(start, end))
      this.shadow.set(bytes.subarray(start, end), start)
      this.initialized = true
      this.uploads++
      this.uploadedBytes += end - start
      return end - start
    } finally { gl.bindBuffer(gl.UNIFORM_BUFFER, previous) }
  }

  withBinding(point, callback) {
    if (this.destroyed) throw new Error('Uniform buffer is destroyed')
    const gl = this.gl, mirror = bindingMirror(gl)
    if (!Number.isInteger(point) || point < 0 || point >= mirror.limit) throw new Error('Invalid uniform binding point')
    const previous = mirror.genericBinding(), saved = mirror.point(point)
    try {
      gl.bindBufferBase(gl.UNIFORM_BUFFER, point, this.buffer)
      mirror.points.set(point, { buffer: this.buffer, offset: 0, size: 0 })
      return callback()
    } finally {
      // bindBufferBase/Range 同时改变通用绑定，所以最后恢复它；镜像随每次 GL 调用同步更新。
      if (saved.buffer && saved.size > 0) gl.bindBufferRange(gl.UNIFORM_BUFFER, point, saved.buffer, saved.offset, saved.size)
      else gl.bindBufferBase(gl.UNIFORM_BUFFER, point, saved.buffer)
      mirror.points.set(point, saved)
      gl.bindBuffer(gl.UNIFORM_BUFFER, previous)
      mirror.generic = previous
    }
  }

  getDiagnostics() { return { bytes: this.destroyed ? 0 : this.byteLength, uploads: this.uploads, uploadedBytes: this.uploadedBytes, initialized: this.initialized } }
  isDestroyed() { return !!this.destroyed }
  destroy() {
    if (this.destroyed) return
    if (this.buffer) this.gl.deleteBuffer(this.buffer)
    this.buffer = undefined
    this.destroyed = true
  }
}

export function uniformBuffersSupported(context){
  const gl=context?._gl
  return !!context?.webgl2&&['createBuffer','deleteBuffer','bindBuffer','bufferData','bufferSubData','getParameter',
    'getUniformBlockIndex','getProgramParameter','uniformBlockBinding','bindBufferBase','bindBufferRange',
    'getIndexedParameter','getActiveUniformBlockParameter'].every(key=>typeof gl?.[key]==='function')
}

// A shader program's uniform-block layout is immutable once linked: block indices,
// data sizes and the active-block count never change for the life of the program.
// Cache only that static part so repeated binds (per draw for the sun frame, per
// frame for AO/SSR/environment) stop re-querying the driver. Current binding values
// are intentionally re-read each call because they are mutated and restored here.
const blockLayoutCache = new WeakMap() // WebGLProgram -> { count, blocks: Map<name, {block,size}|null>, bindings: Map<block, point> }

// UBO 绑定状态的 JS 镜像（每个 GL 上下文一份）：每项第一次用到时向驱动查询一次，
// 之后由本文件的每次 set/restore 同步更新，每次 draw 不再同步回读驱动。
// 成立前提：Cesium 1.143 从不调用 uniformBlockBinding/bindBufferBase/bindBufferRange，
// 本文件是这些状态的唯一写入方且总会恢复；外部代码若在两次调用之间改了这些绑定，镜像会过期。
// 嵌套调用也正确：镜像记录的是当前值（可能是外层刚设的），不是「静止」值。
const bindingMirrors = new WeakMap() // WebGL2RenderingContext -> mirror
function bindingMirror(gl) {
  let mirror = bindingMirrors.get(gl)
  if (!mirror) {
    mirror = {
      limit: gl.getParameter(gl.MAX_UNIFORM_BUFFER_BINDINGS),
      generic: undefined,
      points: new Map(), // point -> { buffer, offset, size }
      genericBinding() {
        if (this.generic === undefined) this.generic = gl.getParameter(gl.UNIFORM_BUFFER_BINDING)
        return this.generic
      },
      point(index) {
        let state = this.points.get(index)
        if (!state) {
          state = { buffer: gl.getIndexedParameter(gl.UNIFORM_BUFFER_BINDING, index),
            offset: gl.getIndexedParameter(gl.UNIFORM_BUFFER_START, index), size: gl.getIndexedParameter(gl.UNIFORM_BUFFER_SIZE, index) }
          this.points.set(index, state)
        }
        return state
      },
    }
    bindingMirrors.set(gl, mirror)
  }
  return mirror
}
function blockBinding(gl, program, layout, block) {
  let point = layout.bindings.get(block)
  if (point === undefined) {
    point = gl.getActiveUniformBlockParameter(program, block, gl.UNIFORM_BLOCK_BINDING)
    layout.bindings.set(block, point)
  }
  return point
}

export function withUniformBlocks(gl, programs, bindings, callback) {
  const limit = bindingMirror(gl).limit
  if (bindings.length > limit) throw new Error('Not enough uniform buffer bindings')
  const mappings = [], used = new Set(), occupied = new Set()
  try {
    for (const program of new Set(programs)) {
      // Cesium lazily links programs; this getter initializes without binding it.
      void program.allUniforms
      if (!program._program) throw new Error('Uniform block program not initialized')
      let layout = blockLayoutCache.get(program._program)
      if (!layout) {
        layout = { count: gl.getProgramParameter(program._program, gl.ACTIVE_UNIFORM_BLOCKS), blocks: new Map(), bindings: new Map() }
        blockLayoutCache.set(program._program, layout)
      }
      const requested = new Set()
      bindings.forEach(({ name, buffer }, index) => {
        if (buffer.gl !== gl || buffer.isDestroyed()) throw new Error('Unavailable uniform buffer')
        let entry = layout.blocks.get(name)
        if (entry === undefined) {
          const block = gl.getUniformBlockIndex(program._program, name)
          entry = (block === gl.INVALID_INDEX || block === 0xffffffff) ? null
            : { block, size: gl.getActiveUniformBlockParameter(program._program, block, gl.UNIFORM_BLOCK_DATA_SIZE) }
          layout.blocks.set(name, entry)
        }
        if (!entry) return
        if (entry.size !== buffer.byteLength) throw new Error(`Uniform block ${name} layout size ${entry.size} differs from ${buffer.byteLength}`)
        const previous = blockBinding(gl, program._program, layout, entry.block)
        mappings.push({ program: program._program, layout, block: entry.block, previous, index, applied: false })
        requested.add(entry.block)
        used.add(index)
      })
      for (let block = 0; block < layout.count; block++) {
        if (!requested.has(block)) occupied.add(blockBinding(gl, program._program, layout, block))
      }
    }
    const indices = [...used]
    const points = new Map()
    let point = limit - 1
    for (const index of indices) {
      while (point >= 0 && occupied.has(point)) point--
      if (point < 0) throw new Error('No free uniform buffer binding points')
      points.set(index, point--)
    }
    for (const mapping of mappings) {
      gl.uniformBlockBinding(mapping.program, mapping.block, points.get(mapping.index))
      mapping.layout.bindings.set(mapping.block, points.get(mapping.index))
      mapping.applied = true
    }
    const bind = index => index === indices.length ? callback()
      : bindings[indices[index]].buffer.withBinding(points.get(indices[index]), () => bind(index + 1))
    return bind(0)
  } finally {
    for (const { program, layout, block, previous, applied } of mappings.reverse()) {
      if (!applied) continue
      gl.uniformBlockBinding(program, block, previous)
      layout.bindings.set(block, previous)
    }
  }
}
