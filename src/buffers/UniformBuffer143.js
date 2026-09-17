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
    const gl = this.gl
    if (!Number.isInteger(point) || point < 0 || point >= gl.getParameter(gl.MAX_UNIFORM_BUFFER_BINDINGS)) throw new Error('Invalid uniform binding point')
    const previous = gl.getParameter(gl.UNIFORM_BUFFER_BINDING)
    const buffer = gl.getIndexedParameter(gl.UNIFORM_BUFFER_BINDING, point)
    const offset = gl.getIndexedParameter(gl.UNIFORM_BUFFER_START, point)
    const size = gl.getIndexedParameter(gl.UNIFORM_BUFFER_SIZE, point)
    try {
      gl.bindBufferBase(gl.UNIFORM_BUFFER, point, this.buffer)
      return callback()
    } finally {
      if (buffer && size > 0) gl.bindBufferRange(gl.UNIFORM_BUFFER, point, buffer, offset, size)
      else gl.bindBufferBase(gl.UNIFORM_BUFFER, point, buffer)
      gl.bindBuffer(gl.UNIFORM_BUFFER, previous)
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
const blockLayoutCache = new WeakMap() // WebGLProgram -> { count, blocks: Map<name, {block,size}|null> }

export function withUniformBlocks(gl, programs, bindings, callback) {
  const limit = gl.getParameter(gl.MAX_UNIFORM_BUFFER_BINDINGS)
  if (bindings.length > limit) throw new Error('Not enough uniform buffer bindings')
  const mappings = [], used = new Set(), occupied = new Set()
  try {
    for (const program of new Set(programs)) {
      // Cesium lazily links programs; this getter initializes without binding it.
      void program.allUniforms
      if (!program._program) throw new Error('Uniform block program not initialized')
      let layout = blockLayoutCache.get(program._program)
      if (!layout) {
        layout = { count: gl.getProgramParameter(program._program, gl.ACTIVE_UNIFORM_BLOCKS), blocks: new Map() }
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
        const previous = gl.getActiveUniformBlockParameter(program._program, entry.block, gl.UNIFORM_BLOCK_BINDING)
        mappings.push({ program: program._program, block: entry.block, previous, index, applied: false })
        requested.add(entry.block)
        used.add(index)
      })
      for (let block = 0; block < layout.count; block++) {
        if (!requested.has(block)) occupied.add(gl.getActiveUniformBlockParameter(program._program, block, gl.UNIFORM_BLOCK_BINDING))
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
      mapping.applied = true
    }
    const bind = index => index === indices.length ? callback()
      : bindings[indices[index]].buffer.withBinding(points.get(indices[index]), () => bind(index + 1))
    return bind(0)
  } finally {
    for (const { program, block, previous, applied } of mappings.reverse()) if (applied) gl.uniformBlockBinding(program, block, previous)
  }
}
