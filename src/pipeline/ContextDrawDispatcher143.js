// One context.draw wrapper for CCR handlers. Render mutation stays in handlers;
// observers are readonly and cannot change the draw decision.
const installations = new WeakMap()
const allowed = new Set(['pass', 'replace', 'skip', 'continue'])

// 每层重入深度复用一个事件对象：handler 可能在 draw 里再发起 draw（补画派生命令），
// 所以按深度分配，不能全局共用一个。native / aroundDraw / deferRestore 在构造时绑定一次，
// handler 可以把它们单独传走（DeferredGeometry、TransparentForward 就这样用），
// 但事件对象和 overrides 数组只在本次 draw 内有效，不能跨 draw 保存。
class DrawEvent {
  constructor(dispatcher) {
    this.dispatcher = dispatcher; this.context = dispatcher.context
    this.scopes = []; this.restores = []; this.overrides = []; this.args = null
    this.native = (...next) => this.invoke(next.length ? next : this.args, 0)
    this.aroundDraw = fn => { if (typeof fn === 'function') this.scopes.push(fn) }
    this.deferRestore = fn => { if (typeof fn === 'function') this.restores.push(fn); return fn }
    this.end()
  }
  begin(args) {
    this.args = args; this.command = args[0]; this.passState = args[1]
    for (let i = 2; i < args.length; i++) this.overrides.push(args[i])
  }
  // 清掉引用，避免池里的事件对象拖住上一帧的命令和 framebuffer。
  end() {
    this.args = null; this.command = undefined; this.passState = undefined; this.phase = undefined
    this.error = undefined; this.restoreError = undefined; this.decision = undefined; this.result = undefined
    // 截断数组走 V8 慢路径，空数组跳过（绝大多数 draw 三个都是空的）。
    if (this.scopes.length) this.scopes.length = 0
    if (this.restores.length) this.restores.length = 0
    if (this.overrides.length) this.overrides.length = 0
  }
  invoke(next, index) {
    return index === this.scopes.length ? this.dispatcher.native.apply(this.context, next)
      : this.scopes[index](() => this.invoke(next, index + 1))
  }
}

export default class ContextDrawDispatcher143 {
  constructor(context, { label = 'CCR' } = {}) {
    if (!context || typeof context.draw !== 'function') throw new Error('ContextDrawDispatcher143 requires a Cesium context')
    if (installations.has(context)) return installations.get(context)
    this.context = context; this.label = label; this.native = context.draw; this.handlers = []; this.observers = []
    this.bypassDepth = 0
    this.events = []; this.depth = 0
    this.installed = false; this.destroyed = false; this.generation = 0
    this.stats = { drawHookInstallations: 0, drawHookInvocations: 0, nativeFallbackDraws: 0, shortCircuits: 0, handlerErrors: 0, observerErrors: 0,
      programBinds: null, materialBinds: null, textureBinds: null, uniformUploads: null }
    this._bindTracking = null
    this.wrapper = (...args) => this._dispatch(args)
    installations.set(context, this)
  }
  // Phase 0/6: bind counters live in one place instead of being estimated per module.
  // Each counter wraps the GL entry point that actually issues that kind of bind.
  startBindTracking() {
    if (this._bindTracking) return this._bindTracking
    const gl = this.context?._gl
    if (!gl) return null
    const counters = { programBinds: 0, drawCalls: 0, materialBinds: null, textureBinds: 0, uniformUploads: 0 }
    // drawElements/drawArrays count draw submissions, not material binds; useProgram is the
    // program bind a batch is supposed to amortise; bindTexture and uniform* are uploads.
    const bindings = [
      ['programBinds', 'useProgram'],
      ['drawCalls', 'drawElements'],
      ['drawCalls', 'drawArrays'],
      // Cesium submits most primitives through the instanced entry points; counting only the
      // non-instanced pair under-reports the real submission count.
      ['drawCalls', 'drawElementsInstanced'],
      ['drawCalls', 'drawArraysInstanced'],
      ['textureBinds', 'bindTexture'],
      ...['1f','2f','3f','4f','1i','2i','3i','4i','1ui','2ui','3ui','4ui',
        '1fv','2fv','3fv','4fv','1iv','2iv','3iv','4iv','1uiv','2uiv','3uiv','4uiv',
        'Matrix2fv','Matrix3fv','Matrix4fv','Matrix2x3fv','Matrix2x4fv','Matrix3x2fv',
        'Matrix3x4fv','Matrix4x2fv','Matrix4x3fv'].map(suffix => ['uniformUploads', `uniform${suffix}`])
    ]
    const restores = []
    for (const [counter, method] of bindings) {
      const original = gl[method]
      if (typeof original !== 'function') continue
      gl[method] = function (...args) { counters[counter]++; return original.apply(this, args) }
      restores.push(() => { gl[method] = original })
    }
    this._bindTracking = { counters, stop: () => { for (const restore of restores.reverse()) restore(); this._bindTracking = null } }
    return this._bindTracking
  }
  stopBindTracking() {
    const tracking = this._bindTracking
    if (!tracking) return null
    const snapshot = { ...tracking.counters }
    tracking.stop()
    return snapshot
  }
  readBindCounters() { return this._bindTracking ? { ...this._bindTracking.counters } : null }
  install() {
    if (this.destroyed) throw new Error('ContextDrawDispatcher143 is destroyed')
    if (this.installed) return this
    if (this.context.draw !== this.native && this.context.draw !== this.wrapper) this.foreign = this.context.draw
    this.native = this.foreign || this.context.draw
    this.context.draw = this.wrapper; this.context._ccrDrawDispatcher = this; this.installed = true; this.generation++; this.stats.drawHookInstallations++
    return this
  }
  addHandler(fn, { name = `handler-${this.handlers.length}`, priority = 0, enabled = true } = {}) {
    if (typeof fn !== 'function') throw new Error('ContextDrawDispatcher143 handler must be a function')
    const record = { fn, name, priority, enabled, active: true }
    this.handlers.push(record); this.handlers.sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name))
    return () => { record.active = false; record.fn = null; this.handlers = this.handlers.filter(item => item !== record) }
  }
  addObserver(fn, { name = `observer-${this.observers.length}`, priority = 0, enabled = true } = {}) {
    if (typeof fn !== 'function') throw new Error('ContextDrawDispatcher143 observer must be a function')
    const record = { fn, name, priority, enabled, active: true }; this.observers.push(record); this.observers.sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name))
    return () => { record.active = false; record.fn = null; this.observers = this.observers.filter(item => item !== record) }
  }
  _dispatch(args) {
    if (this.bypassDepth > 0 || !this.installed || this.destroyed) return this.native.apply(this.context, args)
    this.stats.drawHookInvocations++
    const handlers = this.handlers, observers = this.observers
    if (!handlers.length && !observers.length) { this.stats.nativeFallbackDraws++; return this.native.apply(this.context, args) }
    const event = this.events[this.depth] ??= new DrawEvent(this)
    event.begin(args)
    this.depth++
    let decision = 'continue', result
    try {
      for (const record of handlers) {
        if (!record.active || !record.enabled) continue
        try {
          const returned = record.fn(event)
          if (allowed.has(returned)) decision = returned
          if (returned === 'pass' || returned === 'replace' || returned === 'skip') break
        } catch (error) { record.enabled = false; this.stats.handlerErrors++; event.error = error; break }
      }
      if (decision === 'pass' || decision === 'continue') {
        this.stats.nativeFallbackDraws++
        result = event.scopes.length ? event.invoke(args, 0) : this.native.apply(this.context, args)
      }
      else if (decision === 'skip' || decision === 'replace') this.stats.shortCircuits++
      return result
    } finally {
      const restores = event.restores
      for (let i = restores.length - 1; i >= 0; i--) try { restores[i]() } catch (error) { event.restoreError = error }
      if (observers.length) {
        // 观察者只读：直接把本次事件交给它，不再展开复制。
        event.decision = decision; event.result = result
        for (const record of observers) {
          if (!record.active || !record.enabled) continue
          try { record.fn(event) } catch { record.enabled = false; this.stats.observerErrors++ }
        }
      }
      event.end()
      this.depth--
    }
  }
  withBypass(fn) {
    if (typeof fn !== 'function') throw new Error('ContextDrawDispatcher143.withBypass requires a function')
    this.bypassDepth++
    try { return fn() } finally { this.bypassDepth-- }
  }
  uninstall() {
    if (!this.installed) return
    if (this.context.draw === this.wrapper) this.context.draw = this.foreign || this.native
    if (this.context._ccrDrawDispatcher === this) delete this.context._ccrDrawDispatcher
    this.installed = false; this.generation++
  }
  getDiagnostics() { const measured = this.readBindCounters(); return { label: this.label, installed: this.installed, destroyed: this.destroyed, generation: this.generation, activeHandlers: this.handlers.filter(item => item.active && item.enabled).map(item => item.name), activeObservers: this.observers.filter(item => item.active && item.enabled).map(item => item.name), bindTracking: !!measured, ...this.stats, ...(measured || {}) } }
  destroy() {
    if (this.destroyed) return
    this.uninstall(); this.stopBindTracking(); this.handlers = []; this.observers = []; this.destroyed = true; if (installations.get(this.context) === this) installations.delete(this.context)
  }
}

export function getContextDrawDispatcher143(context) { return installations.get(context) }
