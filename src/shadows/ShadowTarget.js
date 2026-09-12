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
  destroy() { if (!this.framebuffer.isDestroyed()) this.framebuffer.destroy() }
}
