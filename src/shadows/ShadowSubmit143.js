// All casters use LEQUAL depth writes, no blending and no color writes. Their
// minimum depth is order-independent; keep live commands and all their uniforms.
export function groupShadowCommands(commands) {
  return commands.sort((a,b) => a.shaderProgram.id-b.shaderProgram.id || a.renderState.id-b.renderState.id)
}

// Cesium 1.143 calls useProgram on every draw even when the program is unchanged.
// Track all calls only inside this synchronous pass, including shader compilation.
// No persistent assumption about GL state is carried into another pass/frame.
export function withShadowBindings(gl, callback) {
  const previous = gl.useProgram
  const previousActive = gl.activeTexture, previousTexture = gl.bindTexture, textures = new Map()
  let known = false, bound, active = true, unit
  const hook = function(program) {
    if (active && known && program === bound) return
    const result = previous.call(this, program)
    bound = program; known = true
    return result
  }
  const activeHook = function(value) {
    if (active && unit === value) return
    const result = previousActive.call(this, value); unit = value; return result
  }
  const textureHook = function(target, texture) {
    const key = unit * 65536 + target
    if (active && unit !== undefined && textures.has(key) && textures.get(key) === texture) return
    const result = previousTexture.call(this, target, texture)
    if (unit !== undefined) textures.set(key, texture)
    return result
  }
  gl.useProgram = hook
  gl.activeTexture = activeHook; gl.bindTexture = textureHook
  try { return callback() } finally {
    active = false
    if (gl.useProgram === hook) gl.useProgram = previous
    if (gl.activeTexture === activeHook) gl.activeTexture = previousActive
    if (gl.bindTexture === textureHook) gl.bindTexture = previousTexture
  }
}
