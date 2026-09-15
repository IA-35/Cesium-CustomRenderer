import { aoShader, bilateralShader, resolveShader } from '../../src/ao/aoShaders143.js'
import DepthPyramid143 from '../../src/channels/DepthPyramid143.js'
import ScreenSpaceAo143 from '../../src/ao/ScreenSpaceAo143.js'

export function runSyntheticAOChecks(C, viewer, algorithmShader = aoShader) {
  const context = viewer.scene.context, gl = context._gl, width = 64, height = 64
  const resources = [], states = [], checks = {}, measurements = {}
  const viewport = C.BoundingRectangle.clone(context.uniformState.viewport)
  const readBinding = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING), drawBinding = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)
  const check = (name, condition) => { checks[name] = !!condition; if (!condition) throw new Error(`AO numeric check failed: ${name}: ${JSON.stringify(measurements)}`) }
  const texture = (w, h, format, values) => {
    const t = new C.Texture({ context, pixelFormat: format, pixelDatatype: C.PixelDatatype.FLOAT,
      source: { width: w, height: h, arrayBufferView: new Float32Array(values) }, flipY: false,
      sampler: new C.Sampler({ minificationFilter: C.TextureMinificationFilter.NEAREST, magnificationFilter: C.TextureMagnificationFilter.NEAREST }) })
    resources.push(t); return t
  }
  const fill = (w, h, values) => Array.from({ length: w * h }, () => values).flat()
  const depthData = new Float32Array(width * height).fill(10)
  const depth = texture(width, height, C.PixelFormat.RED, depthData)
  const transparency = texture(width, height, C.PixelFormat.RED, new Float32Array(width * height))
  const material = texture(width, height, C.PixelFormat.RGBA, fill(width, height, [.5, .5, 1, 0]))
  const flags = texture(width, height, C.PixelFormat.RGBA, fill(width, height, [1, .5, .25, 15]))
  const color = texture(width, height, C.PixelFormat.RGBA, fill(width, height, [4, 2, 1, .37]))
  const pyramidScene = { context, drawingBufferWidth: width, drawingBufferHeight: height, frameState: { frameNumber: 1 }, isDestroyed: () => false }
  const pyramid = new DepthPyramid143(C, pyramidScene)
  const projection = new C.PerspectiveFrustum({ fov: Math.PI / 3, aspectRatio: 1, near: 1, far: 1000 }).projectionMatrix
  const inverse = C.Matrix4.inverse(projection, new C.Matrix4())
  const updateDepth = () => {
    depth.copyFrom({ source: { width, height, arrayBufferView: depthData } })
    pyramidScene.frameState.frameNumber++
    if (!pyramid.update(depth, pyramidScene.frameState.frameNumber)) throw new Error(JSON.stringify(pyramid.getDiagnostics()))
  }
  const run = (shader, w, h, extras = {}) => {
    const t = new C.Texture({ context, width: w, height: h, pixelFormat: C.PixelFormat.RGBA, pixelDatatype: C.PixelDatatype.FLOAT })
    resources.push(t)
    const framebuffer = new C.Framebuffer({ context, colorTextures: [t], destroyAttachments: false }); resources.push(framebuffer)
    const options = { viewport: new C.BoundingRectangle(0, 0, w, h), depthTest: { enabled: false }, depthMask: false }
    const renderState = C.RenderState.fromCache(options); states.push(options)
    const values = { u_depth: depth, u_material: material, u_flags: flags, u_transparency: transparency, u_hiz: pyramid.getLevels()[0].texture,
      u_inverseProjection: inverse, u_radius: 3, u_strength: 1, u_bias: .08, colorTexture: color, ...extras }
    const command = context.createViewportQuadCommand(shader, { framebuffer, renderState,
      uniformMap: Object.fromEntries(Object.entries(values).map(([name, value]) => [name, () => value])) })
    resources.push(command.shaderProgram)
    command.execute(context)
    return context.readPixels({ framebuffer, width: w, height: h })
  }
  const pixel = (array, w, x, y) => Array.from(array.slice((y * w + x) * 4, (y * w + x) * 4 + 4))
  try {
    updateDepth()
    let data = run(algorithmShader, 32, 32)
    check('flatPlaneHasNoSelfOcclusion', data.every((v, i) => i % 4 !== 0 || Math.abs(v - 1) < 1e-6))
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const ray = C.Matrix4.multiplyByVector(inverse, new C.Cartesian4((x + .5) / width * 2 - 1, (y + .5) / height * 2 - 1, 0, 1), new C.Cartesian4())
      depthData[y * width + x] = 10 / (1 - .4 * ray.y / -ray.z)
    }
    updateDepth(); data = run(algorithmShader, 32, 32)
    check('inclinedPlaneHasNoSelfOcclusion', data.every((v, i) => i % 4 !== 0 || Math.abs(v - 1) < 1e-6))
    depthData.fill(10); updateDepth()
    material.copyFrom({ source: { width, height, arrayBufferView: new Float32Array(fill(width, height, [.8, .5, 1, 0])) } })
    data = run(algorithmShader, 32, 32)
    check('normalMappingDoesNotDarkenFlatGeometry', data.every((v, i) => i % 4 !== 0 || Math.abs(v - 1) < 1e-6))
    material.copyFrom({ source: { width, height, arrayBufferView: new Float32Array(fill(width, height, [.5, .5, 1, 0])) } })
    for (let y = 0; y < height; y++) for (let x = 32; x < width; x++) depthData[y * width + x] = 8
    updateDepth(); data = run(algorithmShader, 32, 32)
    measurements.contact = pixel(data, 32, 14, 16)
    measurements.front = pixel(data, 32, 20, 16)
    check('nearSurfaceOccludesWithinRadius', measurements.contact[0] < .99 && measurements.contact[1] === 1)
    check('fartherSurfaceDoesNotOccludeFrontPlane', measurements.front[0] > .999)
    const zeroStrength = run(algorithmShader, 32, 32, { u_strength: 0 })
    check('zeroStrengthIsNeutral', pixel(zeroStrength, 32, 14, 16)[0] === 1)
    for (let y = 0; y < height; y++) for (let x = 32; x < width; x++) depthData[y * width + x] = -1
    updateDepth(); data = run(algorithmShader, 32, 32)
    check('unknownOccluderRejectsEstimate', pixel(data, 32, 14, 16)[0] === 1 && pixel(data, 32, 14, 16)[1] === 0)

    depthData.fill(10); updateDepth()
    for (const excluded of [31, 43, 67]) {
      flags.copyFrom({ source: { width, height, arrayBufferView: new Float32Array(fill(width, height, [1, .5, .25, excluded])) } })
      data = run(algorithmShader, 32, 32)
      check(`receiverFlags${excluded}AreNeutral`, pixel(data, 32, 16, 16)[0] === 1 && pixel(data, 32, 16, 16)[1] === 0)
    }
    flags.copyFrom({ source: { width, height, arrayBufferView: new Float32Array(fill(width, height, [1, .5, .25, 15])) } })
    const visibilityValues = new Float32Array(fill(32, 32, [1, 1, 0, 1]))
    visibilityValues[(16 * 32 + 16) * 4] = 0
    const visibility = texture(32, 32, C.PixelFormat.RGBA, visibilityValues)
    data = run(bilateralShader, 32, 32, { u_visibility: visibility, u_axis: new C.Cartesian2(1, 0) })
    measurements.filteredImpulse = pixel(data, 32, 16, 16)[0]
    check('bilateralSmoothsWithinPlane', Math.abs(measurements.filteredImpulse - .625) < .0001)
    for (let y = 0; y < height; y++) for (let x = 32; x < width; x++) depthData[y * width + x] = 8
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) visibilityValues[(y * 32 + x) * 4] = x < 16 ? .2 : 1
    visibility.copyFrom({ source: { width: 32, height: 32, arrayBufferView: visibilityValues } }); updateDepth()
    data = run(bilateralShader, 32, 32, { u_visibility: visibility, u_axis: new C.Cartesian2(1, 0) })
    check('bilateralDoesNotBleedAcrossDepthEdge', Math.abs(pixel(data, 32, 15, 16)[0] - .2) < .0001 && pixel(data, 32, 16, 16)[0] > .9999)
    depthData.fill(10); updateDepth()
    const normalEdge = new Float32Array(fill(width, height, [.5, .5, 1, 0]))
    for (let y = 0; y < height; y++) for (let x = 32; x < width; x++) normalEdge[(y * width + x) * 4] = 1
    material.copyFrom({ source: { width, height, arrayBufferView: normalEdge } })
    data = run(bilateralShader, 32, 32, { u_visibility: visibility, u_axis: new C.Cartesian2(1, 0) })
    check('bilateralDoesNotBleedAcrossNormalEdge', Math.abs(pixel(data, 32, 15, 16)[0] - .2) < .0001 && pixel(data, 32, 16, 16)[0] > .9999)
    material.copyFrom({ source: { width, height, arrayBufferView: new Float32Array(fill(width, height, [.5, .5, 1, 0])) } })

    depthData.fill(10); updateDepth()
    visibility.copyFrom({ source: { width: 32, height: 32, arrayBufferView: new Float32Array(fill(32, 32, [.5, 1, 0, 1])) } })
    data = run(resolveShader, width, height, { u_visibility: visibility })
    measurements.hdr = pixel(data, width, 30, 30)
    check('resolvePreservesHDRAlphaAndEmission', [2.5, 1.25, .625, .37].every((v, i) => Math.abs(v - measurements.hdr[i]) < .00001))
    depthData[31 * width + 31] = 6; updateDepth()
    data = run(resolveShader, width, height, { u_visibility: visibility })
    measurements.thin = pixel(data, width, 31, 31)
    check('unmatchedThinSurfaceRemainsNeutral', [4, 2, 1, .37].every((v, i) => Math.abs(v - measurements.thin[i]) < .00001))
    depthData.fill(10); updateDepth()
    const mask = new Float32Array(width * height)
    mask[30 * width + 30] = 1
    transparency.copyFrom({ source: { width, height, arrayBufferView: mask } })
    data = run(resolveShader, width, height, { u_visibility: visibility })
    check('transparentCoveragePreservesOnlyCoveredHDR', [4, 2, 1, .37].every((v, i) => Math.abs(v - pixel(data, width, 30, 30)[i]) < .00001) && Math.abs(pixel(data, width, 10, 10)[0] - 2.5) < .00001)
    data = run(algorithmShader, 32, 32)
    check('transparencyCellRejectsAOConfidence', pixel(data, 32, 15, 15)[0] === 1 && pixel(data, 32, 15, 15)[1] === 0)
    if (gl.getError() !== gl.NO_ERROR) throw new Error('AO numeric checks generated GL error')
    return { checks, measurements, passed: true }
  } finally {
    pyramid.destroy()
    for (const resource of resources.reverse()) if (resource && !resource.isDestroyed()) resource.destroy()
    for (const options of states) C.RenderState.removeFromCache(options)
    context.uniformState.viewport = viewport
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, readBinding); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, drawBinding)
  }
}

