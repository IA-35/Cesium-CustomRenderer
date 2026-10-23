export default class ShadowTarget {
  constructor(C, context, size) {
    this.size = size
    this.depth = new C.Texture({ context, width: size, height: size,
      pixelFormat: C.PixelFormat.DEPTH_COMPONENT, pixelDatatype: C.PixelDatatype.UNSIGNED_INT,
      sampler: new C.Sampler({ minificationFilter: C.TextureMinificationFilter.NEAREST, magnificationFilter: C.TextureMagnificationFilter.NEAREST }) })
    this.framebuffer = new C.Framebuffer({ context, depthTexture: this.depth, destroyAttachments: true })
    this.passState = new C.PassState(context)
    this.passState.framebuffer = this.framebuffer
    this.passState.viewport = new C.BoundingRectangle(0, 0, size, size)
    this.clear = new C.ClearCommand({ depth: 1, framebuffer: this.framebuffer })
  }
  // 整张深度拷贝到同尺寸目标。blit 只受 scissor 影响，不受深度写掩码影响。
  // 调用方负责恢复 READ/DRAW framebuffer 绑定；这里清掉 Cesium 的绑定缓存，强制下一次绘制重新绑定。
  copyTo(context, target) {
    const gl = context._gl, scissor = gl.isEnabled(gl.SCISSOR_TEST)
    if (scissor) gl.disable(gl.SCISSOR_TEST)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.framebuffer._framebuffer)
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, target.framebuffer._framebuffer)
    gl.blitFramebuffer(0, 0, this.size, this.size, 0, 0, target.size, target.size, gl.DEPTH_BUFFER_BIT, gl.NEAREST)
    if (scissor) gl.enable(gl.SCISSOR_TEST)
    context._currentFramebuffer = undefined
  }
  destroy() { if (!this.framebuffer.isDestroyed()) this.framebuffer.destroy() }
}
