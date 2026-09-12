export function materialTargetSupport(context, reflection = false, opaqueColor = false, albedo = false) {
  for (const capability of ['webgl2', 'depthTexture', 'floatingPointTexture', 'halfFloatingPointTexture', 'colorBufferFloat', 'colorBufferHalfFloat', 'drawBuffers']) {
    if (!context || !context[capability]) return { supported: false, reason: `Material target requires ${capability}` }
  }
  // Cesium 1.143 does not expose per-context MRT limits through public getters.
  const gl = context._gl
  if (!gl || typeof gl.getParameter !== 'function') return { supported: false, reason: 'Material target requires WebGL2 limits' }
  reflection = reflection === true || opaqueColor === true
  const attachments = 4 + (reflection ? 2 : 0) + (opaqueColor ? 1 : 0) + (albedo ? 1 : 0)
  for (const limit of ['MAX_DRAW_BUFFERS', 'MAX_COLOR_ATTACHMENTS']) {
    if (!(gl.getParameter(gl[limit]) >= attachments)) return { supported: false, reason: `Material target requires ${limit} >= ${attachments}` }
  }
  return { supported: true, reason: null }
}

export default class MaterialTarget143 {
  constructor(C, context, width, height, reflection = false, opaqueColor = false, albedo = false) {
    const support = materialTargetSupport(context, reflection, opaqueColor, albedo)
    if (!support.supported) throw new Error(support.reason)
    this.width = width
    this.height = height
    this.reflectionEnabled = reflection === true || opaqueColor === true
    this.opaqueColorEnabled = opaqueColor === true
    this.albedoEnabled = albedo === true
    this.bytes = (4 + 8 + 4 + 1 + 4 + (this.reflectionEnabled ? 16 : 0) +
      (this.opaqueColorEnabled ? 8 : 0) + (this.albedoEnabled ? 8 : 0)) * width * height
    const gl = context._gl
    const readFramebuffer = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING)
    const drawFramebuffer = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)
    try {
      const sampler = new C.Sampler({
        minificationFilter: C.TextureMinificationFilter.NEAREST,
        magnificationFilter: C.TextureMagnificationFilter.NEAREST
      })
      const texture = (pixelFormat, pixelDatatype) => new C.Texture({ context, width, height, pixelFormat, pixelDatatype, sampler })
      this.normalRoughMetal = texture(C.PixelFormat.RGBA, C.PixelDatatype.UNSIGNED_BYTE)
      this.emissiveFlags = texture(C.PixelFormat.RGBA, C.PixelDatatype.HALF_FLOAT)
      this.eyeDepth = texture(C.PixelFormat.RED, C.PixelDatatype.FLOAT)
      this.transparency = texture(C.PixelFormat.RED, C.PixelDatatype.UNSIGNED_BYTE)
      this.depthStencil = texture(C.PixelFormat.DEPTH_STENCIL, C.PixelDatatype.UNSIGNED_INT_24_8)
      const colorTextures = [this.normalRoughMetal, this.emissiveFlags, this.eyeDepth, this.transparency]
      if (this.reflectionEnabled) {
        this.reflectionSpecular = texture(C.PixelFormat.RGBA, C.PixelDatatype.HALF_FLOAT)
        this.reflectionResponse = texture(C.PixelFormat.RGBA, C.PixelDatatype.HALF_FLOAT)
        colorTextures.push(this.reflectionSpecular, this.reflectionResponse)
      }
      if (this.opaqueColorEnabled) {
        this.opaqueColor = texture(C.PixelFormat.RGBA, C.PixelDatatype.HALF_FLOAT)
        colorTextures.push(this.opaqueColor)
      }
      if (this.albedoEnabled) {
        this.albedoAttachment = colorTextures.length
        this.albedoOcclusion = texture(C.PixelFormat.RGBA, C.PixelDatatype.HALF_FLOAT)
        colorTextures.push(this.albedoOcclusion)
      }
      this.colorAttachmentCount = colorTextures.length
      this.framebuffer = new C.Framebuffer({ context,
        colorTextures,
        depthStencilTexture: this.depthStencil, destroyAttachments: false })
      const status = this.framebuffer.status
      if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`Material target framebuffer is incomplete (${status})`)
      // The coverage pass shares opaque depth while writing only its R8 mask.
      this.transparencyFramebuffer = new C.Framebuffer({ context, colorTextures: [this.transparency],
        depthStencilTexture: this.depthStencil, destroyAttachments: false })
      const transparencyStatus = this.transparencyFramebuffer.status
      if (transparencyStatus !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`Material transparency framebuffer is incomplete (${transparencyStatus})`)
      this.passState = new C.PassState(context)
      this.passState.framebuffer = this.framebuffer
      this.passState.viewport = new C.BoundingRectangle(0, 0, width, height)
      this.transparencyPassState = new C.PassState(context)
      this.transparencyPassState.framebuffer = this.transparencyFramebuffer
      this.transparencyPassState.viewport = new C.BoundingRectangle(0, 0, width, height)
      this.clearAll = new C.ClearCommand({ color: C.Color.TRANSPARENT, depth: 1, stencil: 0, framebuffer: this.framebuffer })
      this.clearDepth = new C.ClearCommand({ depth: 1, stencil: 0, framebuffer: this.framebuffer })
    } catch (error) {
      this.destroy()
      throw error
    } finally {
      // Framebuffer construction/status bind FRAMEBUFFER then null in 1.143.
      // Restore both bindings so Cesium's untouched framebuffer cache stays valid.
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, readFramebuffer)
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, drawFramebuffer)
    }
  }

  destroy() {
    for (const name of ['framebuffer', 'transparencyFramebuffer', 'normalRoughMetal', 'emissiveFlags', 'eyeDepth', 'transparency', 'depthStencil', 'reflectionSpecular', 'reflectionResponse', 'opaqueColor', 'albedoOcclusion']) {
      const resource = this[name]
      if (resource && !resource.isDestroyed()) resource.destroy()
      this[name] = undefined
    }
  }
}
