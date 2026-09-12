import { receiverSource, casterSources } from './shaderAdapter143.js'

export function clippingPlanesInLightSpace(C, mainCamera, lightCamera, planes) {
  const changeOfView = C.Matrix4.multiply(lightCamera.viewMatrix, mainCamera.inverseViewMatrix, new C.Matrix4())
  const transform = C.Matrix4.inverseTranspose(changeOfView, new C.Matrix4())
  return C.Matrix4.multiply(transform, planes, transform)
}

export default class ShadowReceiver143 {
  constructor(C, scene, uniforms) {
    this.C = C
    this.scene = scene
    this.uniforms = uniforms
    this.programs = new Map()
    this.commands = new Map()
    this.castPrograms = new Map()
    this.castStates = new Map()
    this.receiverUsed = new Map()
    this.castUsed = new Map()
    this.stateUsed = new Map()
  }
  install() {
    const scene = this.scene
    if (scene.updateDerivedCommands === this.update) return
    const previous = scene.updateDerivedCommands
    const token = { active: true }
    const adapter = this
    this.originalUpdate = previous
    this.hookToken = token
    this.update = function(command, ...args) {
      if (token.active && scene.frameState.passes.render) adapter.receive(command)
      return previous.call(this, command, ...args)
    }
    scene.updateDerivedCommands = this.update
  }
  raw(command) {
    const record = this.commands.get(command)
    return record && command.shaderProgram === record.program ? record.source : command.shaderProgram
  }
  receive(command) {
    if (!command.shaderProgram || !command.receiveShadows) return
    const record = this.commands.get(command)
    const frame = this.scene.frameState.frameNumber
    if (record && command.shaderProgram === record.program) {
      if (command.uniformMap !== record.merged) {
        record.originalUniforms = command.uniformMap
        record.merged = { ...command.uniformMap, ...this.uniforms }
        command.uniformMap = record.merged
        command.dirty = true
      }
      record.lastSeen = frame
      this.receiverUsed.set(record.source.id, frame)
      return
    }
    const source = command.shaderProgram
    this.receiverUsed.set(source.id, frame)
    let program = this.programs.get(source.id)
    if (program === undefined) {
      const fs = receiverSource(this.C, source.fragmentShaderSource)
      program = fs ? this.C.ShaderProgram.fromCache({ context: this.scene.context,
        vertexShaderSource: source.vertexShaderSource, fragmentShaderSource: fs,
        attributeLocations: source._attributeLocations }) : null
      this.programs.set(source.id, program)
    }
    if (!program) {
      if (record) this.restoreCommand(command, record)
      this.commands.delete(command)
      return
    }
    const originalUniforms = record && command.uniformMap === record.merged ? record.originalUniforms : command.uniformMap
    const merged = { ...originalUniforms, ...this.uniforms }
    this.commands.set(command, { source, program, originalUniforms, merged, lastSeen: frame })
    command.shaderProgram = program
    command.uniformMap = merged
  }
  cast(command, framebuffer, lightCamera, mainCamera) {
    const C = this.C
    const source = this.raw(command)
    const frame = this.scene.frameState.frameNumber
    this.castUsed.set(source.id, frame)
    this.stateUsed.set(command.renderState.id, frame)
    let program = this.castPrograms.get(source.id)
    if (!program) {
      program = C.ShaderProgram.fromCache({ context: this.scene.context,
        ...casterSources(C, source), attributeLocations: source._attributeLocations })
      this.castPrograms.set(source.id, program)
    }
    let state = this.castStates.get(command.renderState.id)
    if (!state) {
      const options = C.RenderState.getState(command.renderState)
      options.depthTest = { enabled: true, func: C.DepthFunction.LESS_OR_EQUAL }
      options.depthMask = true
      options.colorMask = { red: false, green: false, blue: false, alpha: false }
      options.blending = { enabled: false }
      options.stencilTest = { enabled: false }
      options.polygonOffset = { enabled: true, factor: 1.1, units: 4 }
      state = C.RenderState.fromCache(options)
      this.castStates.set(command.renderState.id, state)
    }
    const cast = C.DrawCommand.shallowClone(command)
    cast.shaderProgram = program
    cast.renderState = state
    cast.framebuffer = framebuffer
    if (command.uniformMap.model_clippingPlanesMatrix && lightCamera) {
      // Model updates this plane transform in the main camera's eye space.
      // Re-express it for the light camera without altering the main draw command.
      const matrix = clippingPlanesInLightSpace(C, mainCamera, lightCamera, command.uniformMap.model_clippingPlanesMatrix())
      cast.uniformMap = { ...command.uniformMap, model_clippingPlanesMatrix: () => matrix }
    }
    cast.castShadows = false
    cast.receiveShadows = false
    return cast
  }
  restoreCommand(command, record) {
    if (command.shaderProgram === record.program) command.shaderProgram = record.source
    if (command.uniformMap === record.merged) command.uniformMap = record.originalUniforms
  }
  prune() {
    const cutoff = this.scene.frameState.frameNumber - 120
    for (const [command, record] of this.commands) {
      if (record.lastSeen < cutoff) {
        this.restoreCommand(command, record)
        this.commands.delete(command)
      }
    }
    for (const [programs, used] of [[this.programs, this.receiverUsed], [this.castPrograms, this.castUsed]]) {
      for (const [id, frame] of used) {
        if (frame >= cutoff) continue
        const program = programs.get(id)
        if (program && !program.isDestroyed()) program.destroy()
        programs.delete(id)
        used.delete(id)
      }
    }
    for (const [id, frame] of this.stateUsed) {
      if (frame < cutoff) { this.castStates.delete(id); this.stateUsed.delete(id) }
    }
  }
  detach() {
    if (this.hookToken) this.hookToken.active = false
    if (this.scene.updateDerivedCommands === this.update) this.scene.updateDerivedCommands = this.originalUpdate
    for (const [command, record] of this.commands) {
      this.restoreCommand(command, record)
    }
    this.commands.clear()
  }
  destroy() {
    this.detach()
    for (const program of [...this.programs.values(), ...this.castPrograms.values()]) {
      if (program && !program.isDestroyed()) program.destroy()
    }
    this.programs.clear()
    this.castPrograms.clear()
    this.castStates.clear()
    this.receiverUsed.clear()
    this.castUsed.clear()
    this.stateUsed.clear()
  }
}
