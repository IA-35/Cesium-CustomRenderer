// B07 夹具：普通 Primitive / 水面 / 积水 / Globe water mask 的 SSR 接入。
//
// 为什么必须在浏览器里做而不能只靠单元测试：单元测试只能证明生成出的 GLSL 文本
// 结构正确。真正要验证的是「它能在真实 GPU 上编译、并且材质通道里出现预期数据」——
// 一个编译不过的着色器会让 Cesium 走渲染错误路径，而这在文本层面看不出来。
//
// 所有几何都是程序化生成（docs/RENDERER_SCOPE.md）：不加载校园资产、不依赖外部影像。
// Globe water mask 用自定义 TerrainProvider 构造（实测 CustomHeightmapTerrainProvider
// 的 hasWaterMask 硬编码为 false，不可用——见 docs/B07_RECONNAISSANCE.md）。

export const SSR_SURFACES_FIXTURE_VERSION = 1

/** 从材质通道纹理里采样一个像素，返回 4 个分量。 */
export function sampleMaterialPixel(C, scene, texture, x, y) {
  const context = scene.context, gl = context._gl
  const read = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING), draw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)
  const cached = context._currentFramebuffer
  const viewport = C.BoundingRectangle.clone(context.uniformState.viewport)
  const target = new C.Texture({ context, width: 1, height: 1, pixelFormat: C.PixelFormat.RGBA, pixelDatatype: C.PixelDatatype.FLOAT })
  const framebuffer = new C.Framebuffer({ context, colorTextures: [target], destroyAttachments: false })
  const options = { viewport: new C.BoundingRectangle(0, 0, 1, 1), depthTest: { enabled: false }, depthMask: false, blending: { enabled: false } }
  const command = context.createViewportQuadCommand('uniform sampler2D src;uniform vec2 uv;void main(){out_FragColor=texture(src,uv);}', {
    framebuffer, renderState: C.RenderState.fromCache(options),
    uniformMap: {
      src: () => texture,
      uv: () => new C.Cartesian2((x + 0.5) / texture.width, (texture.height - 1 - y + 0.5) / texture.height)
    }
  })
  try {
    command.execute(context)
    return Array.from(context.readPixels({ framebuffer, width: 1, height: 1 }))
  } finally {
    command.shaderProgram.destroy()
    C.RenderState.removeFromCache(options)
    framebuffer.destroy()
    target.destroy()
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read)
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, draw)
    context._currentFramebuffer = cached
    context.uniformState.viewport = viewport
  }
}

/** 逐像素扫描一张纹理，统计满足 `predicate(rgba)` 的像素数。 */
export function countMaterialPixels(C, scene, texture, predicate) {
  const width = texture.width, height = texture.height
  const context = scene.context, gl = context._gl
  const read = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING), draw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)
  const cached = context._currentFramebuffer
  const viewport = C.BoundingRectangle.clone(context.uniformState.viewport)
  const target = new C.Texture({ context, width, height, pixelFormat: C.PixelFormat.RGBA, pixelDatatype: C.PixelDatatype.FLOAT })
  const framebuffer = new C.Framebuffer({ context, colorTextures: [target], destroyAttachments: false })
  const options = { viewport: new C.BoundingRectangle(0, 0, width, height), depthTest: { enabled: false }, depthMask: false, blending: { enabled: false } }
  const command = context.createViewportQuadCommand('uniform sampler2D src;in vec2 v_textureCoordinates;void main(){out_FragColor=texture(src,v_textureCoordinates);}', {
    framebuffer, renderState: C.RenderState.fromCache(options), uniformMap: { src: () => texture }
  })
  try {
    command.execute(context)
    const data = context.readPixels({ framebuffer, width, height })
    let count = 0
    const samples = []
    for (let i = 0; i < width * height; i++) {
      const rgba = [data[i * 4], data[i * 4 + 1], data[i * 4 + 2], data[i * 4 + 3]]
      if (predicate(rgba)) { count++; if (samples.length < 4) samples.push({ x: i % width, y: Math.floor(i / width), rgba }) }
    }
    return { count, total: width * height, samples }
  } finally {
    command.shaderProgram.destroy()
    C.RenderState.removeFromCache(options)
    framebuffer.destroy()
    target.destroy()
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read)
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, draw)
    context._currentFramebuffer = cached
    context.uniformState.viewport = viewport
  }
}

export function waitFrames(scene, count, errors, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let remaining = count
    const timer = setTimeout(() => {
      off()
      reject(new Error(`frame timeout after ${count} frames; render errors: ${(errors || []).join(' | ') || 'none'}`))
    }, timeoutMs)
    const off = scene.postRender.addEventListener(() => {
      if (--remaining !== 0) return
      off()
      clearTimeout(timer)
      resolve()
    })
  })
}

/**
 * 自定义 TerrainProvider，唯一能产生像素级 water mask 的方式。
 *
 * `CustomHeightmapTerrainProvider.hasWaterMask` 硬编码返回 false
 * （Core/CustomHeightmapTerrainProvider.js:144），且它的 requestTileGeometry
 * 完全不读取水掩码参数，因此实测其 globe 命令的 u_waterMask() 恒为 undefined。
 */
export function waterMaskTerrainProvider(C, { size = 8, kind = 'mixed' } = {}) {
  // 左半水、右半陆的**非对称**掩码：若实现漏掉 GlobeFS 的 y 翻转，
  // 水域会出现在错误的半边，而这个差异在对称掩码下测不出来。
  const mask = () => {
    if (kind === 'water') return new Uint8Array([1])
    if (kind === 'land') return new Uint8Array([0])
    const a = new Uint8Array(size * size)
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) a[y * size + x] = x < size / 2 ? 1 : 0
    return a
  }
  class WaterMaskTerrainProvider {
    constructor() { this._tilingScheme = new C.WebMercatorTilingScheme() }
    get tilingScheme() { return this._tilingScheme }
    get hasWaterMask() { return true }
    get hasVertexNormals() { return false }
    get availability() { return undefined }
    getTileDataAvailable() { return true }
    getLevelMaximumGeometricError(level) { return 100 / (1 << level) }
    requestTileGeometry() {
      return Promise.resolve(new C.HeightmapTerrainData({
        buffer: new Float32Array(size * size), width: size, height: size, waterMask: mask()
      }))
    }
  }
  return new WaterMaskTerrainProvider()
}

/** 构造一个与相机正对的水平面 Primitive，用给定的 appearance。
 *
 * `localX`/`localY` 是本地 ENU 平面内的偏移：多个 Primitive 必须错开，
 * 否则它们在屏幕上完全重叠，材质通道读回无法区分是谁写的数据。
 */
export function surfacePrimitive(C, scene, { origin, localX = 0, localY = 0, localZ, size, appearance, id }) {
  const frame = C.Transforms.eastNorthUpToFixedFrame(origin)
  const modelMatrix = C.Matrix4.multiplyByScale(
    C.Matrix4.multiply(frame, C.Matrix4.fromTranslation(new C.Cartesian3(localX, localY, localZ)), new C.Matrix4()),
    new C.Cartesian3(size, size, 1), new C.Matrix4())
  const primitive = new C.Primitive({
    asynchronous: false,
    geometryInstances: new C.GeometryInstance({
      geometry: new C.PlaneGeometry({ vertexFormat: C.MaterialAppearance.MaterialSupport.ALL.vertexFormat }),
      modelMatrix, id
    }),
    appearance
  })
  scene.primitives.add(primitive)
  return primitive
}

/** 生成一张纯色 data-URI 图片，用于材质贴图参数。 */
export function solidImage(r, g, b) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 4
  const context = canvas.getContext('2d')
  context.fillStyle = `rgb(${r},${g},${b})`
  context.fillRect(0, 0, 4, 4)
  return canvas.toDataURL()
}
