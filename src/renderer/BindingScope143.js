const scopes = new WeakMap()

/** Track actual bindings only for a synchronous command scope; never retain GL state across frames. */
export function withBindings143(gl, callback, stats = {}) {
  if (scopes.has(gl)) return callback()
  Object.assign(stats, { programRequests: 0, programBinds: 0, textureRequests: 0, textureBinds: 0,
    activeTextureRequests: 0, activeTextureBinds: 0 })
  let programKnown = false, program, unit
  const textures = new Map(), restores = []
  const hook = (name, wrap) => {
    const original = gl[name], own = Object.hasOwn(gl, name)
    if (typeof original !== 'function') return
    const wrapped = wrap(original)
    gl[name] = wrapped
    restores.push(() => {
      if (gl[name] !== wrapped) return
      if (own) gl[name] = original
      else delete gl[name]
    })
  }
  scopes.set(gl, stats)
  try {
    hook('useProgram', original => function(value) {
      stats.programRequests++
      if (programKnown && program === value) return
      const result = original.call(this, value)
      program = value; programKnown = true; stats.programBinds++
      return result
    })
    hook('activeTexture', original => function(value) {
      stats.activeTextureRequests++
      if (unit === value) return
      const result = original.call(this, value)
      unit = value; stats.activeTextureBinds++
      return result
    })
    hook('bindTexture', original => function(target, value) {
      stats.textureRequests++
      const key = unit * 65536 + target
      if (unit !== undefined && textures.has(key) && textures.get(key) === value) return
      const result = original.call(this, target, value)
      if (unit !== undefined) textures.set(key, value)
      stats.textureBinds++
      return result
    })
    hook('deleteTexture', original => function(value) {
      for (const [key, bound] of textures) if (bound === value) textures.delete(key)
      return original.call(this, value)
    })
    hook('deleteProgram', original => function(value) {
      if (program === value) programKnown = false
      return original.call(this, value)
    })
    return callback()
  } finally {
    restores.reverse().forEach(restore => restore())
    scopes.delete(gl)
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
