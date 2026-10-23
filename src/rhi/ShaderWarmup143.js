// 着色器后台预热。
//
// Cesium 的 ShaderProgram 在第一次绑定时同步编译、链接，冷缓存下体积云单个程序要 3 秒以上，
// 整个环境首帧卡住近 10 秒（测量见 docs/01-architecture/RHI_CONSOLIDATION.md 第 9 节）。
// 浏览器会按着色器文本缓存编译结果：同一文本再次编译只需约 10 ms。这里用
// KHR_parallel_shader_compile 在后台编译与 Cesium 将来完全相同的文本，只轮询完成状态、
// 从不查询会阻塞的 LINK_STATUS，完成后立即删掉临时程序；之后 Cesium 自己编译时命中缓存。
//
// 预热只是加速，不改变正确性：没有扩展、上下文丢失、链接失败或超时都视为「就绪」，
// 交还给 Cesium 按原样同步编译（并由它报告真正的编译错误）。
const PARALLEL_COMPILE = 'KHR_parallel_shader_compile'
const DEFAULT_TIMEOUT_MS = 20000
// Cesium 1.143 Context.createViewportQuadCommand 使用的属性位置（模块内常量 viewportQuadAttributeLocations）。
const VIEWPORT_QUAD_ATTRIBUTES = Object.freeze({ position: 0, textureCoordinates: 1 })

// 后处理 stage 的最终着色器文本，与 PostProcessStage.createDrawCommand → createViewportQuadCommand
// → ShaderCache.getShaderProgram 的拼接方式逐字一致（tests/rendering/shader-warmup.test.mjs 对照 Cesium 校验）。
export function viewportQuadTexts143(C, context, fragmentShader, defines = ['']) {
  return {
    vertexShaderText: new C.ShaderSource({ sources: [C._shadersViewportQuadVS] }).createCombinedVertexShader(context),
    fragmentShaderText: new C.ShaderSource({ defines, sources: [fragmentShader] }).createCombinedFragmentShader(context),
    attributeLocations: VIEWPORT_QUAD_ATTRIBUTES,
  }
}

export default class ShaderWarmup143 {
  constructor(C, context, { now = () => performance.now(), timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.C = C; this.context = context; this.gl = context._gl
    this.extension = this.gl?.getExtension?.(PARALLEL_COMPILE) || null
    this.now = now; this.timeoutMs = timeoutMs
    this.pending = new Map()   // key -> { program, shaders, started, fragmentShaderText }
    this.ready = new Set()
    this.failed = 0; this.timedOut = 0; this.destroyed = false
  }

  get parallel() { return !!this.extension }

  // 返回预热 key；没有并行编译能力时返回 null（调用方无需等待）。
  warm({ vertexShaderText, fragmentShaderText, attributeLocations = {} }) {
    if (this.destroyed || !this.extension || this.gl.isContextLost()) return null
    const key = `${vertexShaderText}\u0000${fragmentShaderText}`
    if (this.ready.has(key) || this.pending.has(key)) return key
    const gl = this.gl, program = gl.createProgram(), shaders = []
    for (const [type, text] of [[gl.VERTEX_SHADER, vertexShaderText], [gl.FRAGMENT_SHADER, fragmentShaderText]]) {
      const shader = gl.createShader(type)
      gl.shaderSource(shader, text); gl.compileShader(shader); gl.attachShader(program, shader)
      shaders.push(shader)
    }
    // 属性绑定也是程序缓存 key 的一部分，必须与 Cesium 一致。
    for (const [name, index] of Object.entries(attributeLocations)) gl.bindAttribLocation(program, index, name)
    gl.linkProgram(program)
    this.pending.set(key, { program, shaders, started: this.now(), fragmentShaderText })
    return key
  }

  // 递归收集后处理 stage 树（composite 用 length/get，叶子有 fragmentShader），按当前帧的 LOG_DEPTH 预热。
  warmPostProcessStages(stages, { useLogDepth = false, context = this.context } = {}) {
    const keys = new Set(), defines = [useLogDepth ? 'LOG_DEPTH' : '']
    const visit = stage => {
      if (!stage) return
      if (typeof stage.length === 'number' && typeof stage.get === 'function') {
        for (let i = 0; i < stage.length; i++) visit(stage.get(i))
      } else if (typeof stage.fragmentShader === 'string') {
        const key = this.warm(viewportQuadTexts143(this.C, context, stage.fragmentShader, defines))
        if (key) keys.add(key)
      }
    }
    for (const stage of stages) visit(stage)
    return [...keys]
  }

  // 直接 createViewportQuadCommand(字符串) 的全屏着色器（无 stage defines）。
  warmViewportShaders(fragmentShaders, { context = this.context } = {}) {
    const keys = new Set()
    for (const fragmentShader of fragmentShaders) {
      const key = this.warm(viewportQuadTexts143(this.C, context, fragmentShader, []))
      if (key) keys.add(key)
    }
    return [...keys]
  }

  isReady(keys) {
    let ready = true
    for (const key of keys) if (!this.ready.has(key) && !this._settle(key)) ready = false
    return ready
  }

  _settle(key) {
    const entry = this.pending.get(key)
    if (!entry) return true
    const gl = this.gl
    if (this.destroyed || gl.isContextLost()) return this._finish(key, entry)
    if (gl.getProgramParameter(entry.program, this.extension.COMPLETION_STATUS_KHR) === true) {
      // 已完成，此时读 LINK_STATUS 不会阻塞。失败也算就绪：Cesium 会自己编译并报出真实错误。
      if (!gl.getProgramParameter(entry.program, gl.LINK_STATUS)) this.failed++
      return this._finish(key, entry)
    }
    if (this.now() - entry.started > this.timeoutMs) { this.timedOut++; return this._finish(key, entry) }
    return false
  }

  _finish(key, entry) {
    const gl = this.gl
    if (!gl.isContextLost()) {
      for (const shader of entry.shaders) gl.deleteShader(shader)
      gl.deleteProgram(entry.program)
    }
    this.pending.delete(key); this.ready.add(key)
    return true
  }

  getDiagnostics() {
    return { parallel: this.parallel, pending: this.pending.size, ready: this.ready.size, failed: this.failed, timedOut: this.timedOut }
  }

  destroy() {
    if (this.destroyed) return
    for (const [key, entry] of [...this.pending]) this._finish(key, entry)
    this.destroyed = true
  }
}
