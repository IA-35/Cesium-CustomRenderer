export function pyramidDimensions(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) return []
  const dimensions = []
  do {
    width = Math.ceil(width / 2)
    height = Math.ceil(height / 2)
    dimensions.push([width, height])
  } while (width > 1 || height > 1)
  return dimensions
}

// R/G bound known positive eye depths; B means complete known coverage;
// A is a bit mask: 1 = unknown opaque, 2 = transparent coverage, 3 = both.
// Integer OR preserves each kind independently through every reduction level.
const shader = base => `
precision highp float;
precision highp int;
uniform highp sampler2D u_source;
${base ? 'uniform highp sampler2D u_transparency;\nuniform bool u_hasTransparency;' : ''}
void main() {
  ivec2 size = textureSize(u_source, 0);
  ivec2 origin = ivec2(gl_FragCoord.xy) * 2;
  float minimum = 0.0;
  float maximum = 0.0;
  float coverage = 1.0;
  float unknown = 0.0;
  for (int y = 0; y < 2; ++y) {
    for (int x = 0; x < 2; ++x) {
      ivec2 pixel = origin + ivec2(x, y);
      if (pixel.x >= size.x || pixel.y >= size.y) continue;
      vec4 value = texelFetch(u_source, pixel, 0);
      ${base ? `
      float depth = value.r;
      value = (isnan(depth) || isinf(depth)) ? vec4(0.0, 0.0, 0.0, 1.0)
        : vec4(max(depth, 0.0), max(depth, 0.0), depth > 0.0 ? 1.0 : 0.0, depth < 0.0 ? 1.0 : 0.0);
      if (u_hasTransparency && texelFetch(u_transparency, pixel, 0).r > 0.0) {
        value.b = 0.0;
        value.a = float(int(value.a) | 2);
      }` : ''}
      if (value.r > 0.0) minimum = minimum > 0.0 ? min(minimum, value.r) : value.r;
      maximum = max(maximum, value.g);
      coverage = min(coverage, value.b);
      unknown = float(int(unknown) | int(value.a));
    }
  }
  out_FragColor = vec4(minimum, maximum, coverage, unknown);
}`

export default class DepthPyramid143 {
  constructor(C, scene) {
    if (!/^1\.143(?:\.0)?$/.test(C.VERSION)) throw new Error('DepthPyramid143 requires Cesium 1.143')
    this.C = C
    this.scene = scene
    this.levels = []
    this.bytes = 0
    this.destroyed = false
    this.failed = false
    this.outputFrame = undefined
    this.error = null
    this.reason = 'Not rendered'
    this.frames = 0
    this.support = { supported: true, reason: null }
    for (const capability of ['webgl2', 'floatingPointTexture', 'colorBufferFloat']) {
      if (!scene.context[capability]) {
        this.support = { supported: false, reason: `HiZ requires ${capability}` }
        break
      }
    }
  }

  _unavailable() {
    if (this.destroyed || (this.scene.isDestroyed && this.scene.isDestroyed())) return 'Destroyed'
    if (!this.support.supported) return this.support.reason
    if (this.scene.context._gl.isContextLost()) return 'Context lost'
    if (this.failed) return 'HiZ reduction failed; release before retrying'
    return null
  }

  _allocate(width, height) {
    const C = this.C, context = this.scene.context, gl = context._gl
    const readFramebuffer = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING)
    const drawFramebuffer = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)
    try {
      const sampler = new C.Sampler({
        minificationFilter: C.TextureMinificationFilter.NEAREST,
        magnificationFilter: C.TextureMagnificationFilter.NEAREST
      })
      for (const [levelWidth, levelHeight] of pyramidDimensions(width, height)) {
        const index = this.levels.length
        const level = { width: levelWidth, height: levelHeight }
        this.levels.push(level)
        level.texture = new C.Texture({ context, width: levelWidth, height: levelHeight,
          pixelFormat: C.PixelFormat.RGBA, pixelDatatype: C.PixelDatatype.FLOAT, sampler })
        level.framebuffer = new C.Framebuffer({ context, colorTextures: [level.texture], destroyAttachments: false })
        const status = level.framebuffer.status
        if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`HiZ framebuffer is incomplete (${status})`)
        level.passState = new C.PassState(context)
        level.passState.framebuffer = level.framebuffer
        level.passState.viewport = new C.BoundingRectangle(0, 0, levelWidth, levelHeight)
        const options = { viewport: level.passState.viewport, depthTest: { enabled: false }, depthMask: false,
          blending: { enabled: false } }
        const renderState = C.RenderState.fromCache(options)
        level.stateOptions = options
        level.command = context.createViewportQuadCommand(shader(index === 0), {
          owner: this, framebuffer: level.framebuffer, renderState,
          uniformMap: { u_source: () => index ? this.levels[index - 1].texture : this.source,
            ...(index === 0 ? { u_transparency: () => this.transparency || this.source,
              u_hasTransparency: () => !!this.transparency } : {}) }
        })
        this.bytes += levelWidth * levelHeight * 16
      }
      this.width = width
      this.height = height
    } catch (error) {
      this.release()
      throw error
    } finally {
      // Cesium framebuffer construction/status change both raw GL bindings.
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, readFramebuffer)
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, drawFramebuffer)
    }
  }

  update(sourceTexture, frameNumber, transparencyTexture = null) {
    this.invalidate()
    this.reason = this._unavailable()
    if (this.reason) return false
    if (!sourceTexture || (sourceTexture.isDestroyed && sourceTexture.isDestroyed()) ||
      !pyramidDimensions(sourceTexture.width, sourceTexture.height).length ||
      frameNumber !== this.scene.frameState.frameNumber || frameNumber === undefined) {
      this.reason = 'Requires current valid eye-depth texture'
      return false
    }
    if (transparencyTexture && ((transparencyTexture.isDestroyed && transparencyTexture.isDestroyed()) ||
      transparencyTexture.width !== sourceTexture.width || transparencyTexture.height !== sourceTexture.height)) {
      this.reason = 'Requires matching valid transparency texture'
      return false
    }
    const uniforms = this.scene.context.uniformState
    const viewport = this.C.BoundingRectangle.clone(uniforms.viewport)
    try {
      if (!this.levels.length || this.width !== sourceTexture.width || this.height !== sourceTexture.height) {
        this.release()
        this._allocate(sourceTexture.width, sourceTexture.height)
      }
      this.source = sourceTexture
      this.transparency = transparencyTexture || undefined
      for (const level of this.levels) {
        uniforms.viewport = level.passState.viewport
        level.command.execute(this.scene.context, level.passState)
      }
      this.outputFrame = frameNumber
      this.error = null
      this.reason = null
      this.frames++
      return true
    } catch (error) {
      this.error = error.message
      this.release()
      this.failed = true
      this.reason = 'HiZ reduction failed'
      return false
    } finally {
      uniforms.viewport = viewport
    }
  }

  getLevels() {
    if (this._unavailable() || !this.levels.length || this.outputFrame === undefined ||
      this.outputFrame !== this.scene.frameState.frameNumber ||
      this.width !== this.scene.drawingBufferWidth || this.height !== this.scene.drawingBufferHeight ||
      !this.source || (this.source.isDestroyed && this.source.isDestroyed()) ||
      (this.transparency && ((this.transparency.isDestroyed && this.transparency.isDestroyed()) ||
        this.transparency.width !== this.width || this.transparency.height !== this.height))) return null
    return this.levels
  }

  getDiagnostics() {
    const valid = !!this.getLevels()
    return { supported: this.support.supported, valid, reason: this._unavailable() || this.reason || (valid ? null : 'No current frame output'),
      error: this.error, failed: this.failed, bytes: this.bytes, frames: this.frames, outputFrame: this.outputFrame,
      transparencyIncluded: valid && !!this.transparency,
      unknownMaskContractVersion: 2, unknownMaskBits: { opaque: 1, transparency: 2 },
      levels: this.levels.map(level => ({ width: level.width, height: level.height })),
      format: 'RGBA32F min/max eye-depth, complete coverage, unknown bit mask (1 opaque, 2 transparency, 3 both)',
      allocationScope: 'owned reduction textures; excludes borrowed source/transparency textures and driver overhead' }
  }

  invalidate() { this.outputFrame = undefined }

  release() {
    this.invalidate()
    this.failed = false
    for (const level of this.levels) {
      const program = level.command && level.command.shaderProgram
      if (program && !program.isDestroyed()) program.destroy()
      if (level.stateOptions) this.C.RenderState.removeFromCache(level.stateOptions)
      for (const resource of [level.framebuffer, level.texture]) {
        if (resource && !resource.isDestroyed()) resource.destroy()
      }
    }
    this.levels = []
    this.source = undefined
    this.transparency = undefined
    this.width = undefined
    this.height = undefined
    this.bytes = 0
  }

  isDestroyed() { return this.destroyed }
  destroy() {
    if (this.destroyed) return
    this.release()
    this.destroyed = true
  }
}
