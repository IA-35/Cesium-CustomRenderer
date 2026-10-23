// All casters use LEQUAL depth writes, no blending and no color writes. Their
// minimum depth is order-independent; keep live commands and all their uniforms.
export function groupShadowCommands(commands) {
  return commands.sort((a,b) => a.shaderProgram.id-b.shaderProgram.id || a.renderState.id-b.renderState.id)
}

// Shadows share the same synchronous state cache as the surrounding color submission.
export { withBindings143 as withShadowBindings } from '../renderer/BindingScope143.js'
