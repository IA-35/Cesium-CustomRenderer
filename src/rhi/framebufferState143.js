// framebuffer 绑定状态的 RHI 工具。
//
// Cesium 1.143 的 Framebuffer.status getter 会 bindFramebuffer(FRAMEBUFFER, 自己)、检查、再 _unBind() 绑到 null，
// 但不更新 context._currentFramebuffer；而 Cesium 的 bindFramebuffer 只在目标与该缓存不同时才真正绑定。
// 所以在 pass 中途直接读 status，之后往「缓存认为已绑定」的 framebuffer 绘制会跳过绑定，画进默认 framebuffer。
// 这里在检查前后保存并恢复实际的 READ/DRAW 绑定：getter 不改缓存，恢复后 GL 状态与缓存重新一致，
// 调用方原先用原生 GL 绑定的 READ/DRAW 也保持不变。
// tests/rendering/rhi-framebuffer-status.test.mjs 用 Cesium 自己的 Context.clear 复现并验证。
export function checkFramebufferComplete143(context, framebuffer) {
  const gl = context._gl
  const read = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING), draw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)
  try {
    return framebuffer.status === gl.FRAMEBUFFER_COMPLETE
  } finally {
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read)
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, draw)
  }
}
