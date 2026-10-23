const HOOKED = ['useProgram', 'activeTexture', 'bindTexture', 'deleteTexture', 'deleteProgram']
const trackers = new WeakMap()

// 包装函数在每个 gl 上只安装一次，此后常驻：没有活动作用域时直通原函数。
// 旧实现每个作用域都在 WebGL context 上新增再 delete 5 个自有属性，反复改对象形状
// 可能让 gl 退化成字典模式，拖慢 Cesium 所有 gl.xxx 调用。
// 作用域之间的 GL 状态不可信（外部代码可能绕过追踪），因此每次进入作用域都清空缓存。
function tracker(gl) {
  let state = trackers.get(gl)
  if (!state) {
    state = { stats: null, programKnown: false, program: undefined, unit: undefined, textures: new Map(), originals: {}, wrappers: {} }
    trackers.set(gl, state)
  }
  for (const name of HOOKED) install(gl, state, name)
  return state
}

function install(gl, state, name) {
  const current = gl[name]
  if (typeof current !== 'function' || current === state.wrappers[name]) return
  // 当前函数不是我们的包装：首次安装，或别的工具（如绑定计数）恢复时把我们摘掉了——
  // 此时它等于我们原先包住的函数，或就是原型上的原生函数，重新包上即可。
  // 其余情况说明有人在我们之上又包了一层，保持原样，避免双层去重。
  const native = Object.getPrototypeOf(gl)?.[name]
  if (state.wrappers[name] && current !== state.originals[name] && current !== native) return
  const original = current, wrapped = wrap(state, name, original)
  state.originals[name] = original; state.wrappers[name] = wrapped
  gl[name] = wrapped
}

function wrap(state, name, original) {
  switch (name) {
    case 'useProgram': return function(value) {
      const stats = state.stats
      if (!stats) return original.call(this, value)
      stats.programRequests++
      if (state.programKnown && state.program === value) return
      const result = original.call(this, value)
      state.program = value; state.programKnown = true; stats.programBinds++
      return result
    }
    case 'activeTexture': return function(value) {
      const stats = state.stats
      if (!stats) return original.call(this, value)
      stats.activeTextureRequests++
      if (state.unit === value) return
      const result = original.call(this, value)
      state.unit = value; stats.activeTextureBinds++
      return result
    }
    case 'bindTexture': return function(target, value) {
      const stats = state.stats
      if (!stats) return original.call(this, target, value)
      stats.textureRequests++
      const unit = state.unit, key = unit * 65536 + target, textures = state.textures
      if (unit !== undefined && textures.has(key) && textures.get(key) === value) return
      const result = original.call(this, target, value)
      if (unit !== undefined) textures.set(key, value)
      stats.textureBinds++
      return result
    }
    case 'deleteTexture': return function(value) {
      if (state.stats) for (const [key, bound] of state.textures) if (bound === value) state.textures.delete(key)
      return original.call(this, value)
    }
    default: return function(value) {
      if (state.stats && state.program === value) state.programKnown = false
      return original.call(this, value)
    }
  }
}

/** Track actual bindings only for a synchronous command scope; never retain GL state across frames. */
export function withBindings143(gl, callback, stats = {}) {
  const state = tracker(gl)
  if (state.stats) return callback()
  Object.assign(stats, { programRequests: 0, programBinds: 0, textureRequests: 0, textureBinds: 0,
    activeTextureRequests: 0, activeTextureBinds: 0 })
  state.programKnown = false; state.program = undefined; state.unit = undefined; state.textures.clear()
  state.stats = stats
  try {
    return callback()
  } finally {
    state.stats = null
    state.program = undefined; state.textures.clear()
  }
}

export default class BindingScope143 {
  constructor(scene, enabled) {
    Object.assign(this, { scene, enabled, stats: null, destroyed: false })
    this.native = scene.updateAndExecuteCommands
    const owner = this
    this.wrapper = function(...args) {
      const passes = scene.frameState?.passes, gl = scene.context?._gl
      if (owner.destroyed || !enabled() || !passes?.render || passes.pick || passes.depth || passes.pickVoxel || gl.isContextLost()) {
        return owner.native.apply(this, args)
      }
      owner.stats = { frameNumber: scene.frameState.frameNumber, scope: 'scene.updateAndExecuteCommands', completed: false }
      const result = withBindings143(gl, () => owner.native.apply(this, args), owner.stats)
      owner.stats.completed = true
      return result
    }
    if (typeof this.native === 'function' && scene.context?._gl) scene.updateAndExecuteCommands = this.wrapper
  }
  getDiagnostics() {
    const measured = this.stats?.completed && this.stats.frameNumber === this.scene.frameState?.frameNumber
    return measured ? { ...this.stats, measured: true,
      programBindReduction: this.stats.programRequests ? 1 - this.stats.programBinds / this.stats.programRequests : 0,
      textureBindReduction: this.stats.textureRequests ? 1 - this.stats.textureBinds / this.stats.textureRequests : 0 }
      : { measured: false, programBinds: null, textureBinds: null }
  }
  destroy() {
    this.destroyed = true
    if (this.scene.updateAndExecuteCommands === this.wrapper) this.scene.updateAndExecuteCommands = this.native
  }
}
