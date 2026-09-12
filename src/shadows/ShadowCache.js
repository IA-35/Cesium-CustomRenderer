// Static caching is opt-in: the caller promises textures and instance buffers
// are immutable, or calls invalidate after changing their contents. Dynamic is default.
export default class ShadowCache {
  constructor() { this.key = null; this.revision = 0; this.identities = new WeakMap(); this.nextId = 1 }
  invalidate() { this.key = null; this.revision++ }
  identity(value) {
    if (!this.identities.has(value)) this.identities.set(value, this.nextId++)
    return this.identities.get(value)
  }
  value(value) {
    if (value === null || typeof value !== 'object') return value
    if (Array.isArray(value) || ArrayBuffer.isView(value)) return Array.from(value, v => this.value(v))
    if (typeof value.x === 'number') return [value.x, value.y, value.z, value.w]
    if (typeof value.red === 'number') return [value.red, value.green, value.blue, value.alpha]
    if (typeof value[0] === 'number') return Array.from({ length: 16 }, (_, i) => value[i])
    return { resource: this.identity(value) }
  }
  signature(matrix, size, commands) {
    const items = []
    for (const command of commands) {
      const program = command.shaderProgram
      if (!program._manualUniforms || program.vertexShaderSource.defines.some(d => /SKINNING|MORPH|CUSTOM_VERTEX/.test(d))) return null
      const uniforms = program._manualUniforms.map(uniform => [uniform.name, this.value(command.uniformMap[uniform.name]())])
      items.push([this.identity(command.vertexArray), program.id, command.renderState.id,
        command.count, command.offset, command.instanceCount, command.primitiveType, command.pass, this.value(command.modelMatrix), uniforms])
    }
    // Opaque/MASK depth writes with LEQUAL produce the same minimum depth
    // regardless of the main camera's tile traversal order.
    items.sort((a,b) => a[0]-b[0] || a[1]-b[1] || a[2]-b[2] || JSON.stringify(a).localeCompare(JSON.stringify(b)))
    return JSON.stringify([this.revision, this.value(matrix), size, items])
  }
  matches(key) { return key !== null && key === this.key }
  commit(key) { this.key = key }
}
