import { reflectionCommon, traceFunctions, traceShader, resolveShader } from '../../src/reflections/ssrShaders143.js'
import DepthPyramid143 from '../../src/channels/DepthPyramid143.js'
import { transparentVisibility } from '../../src/reflections/transparentReflectionShader143.js'
import { common as aoCommon } from '../../src/ao/aoShaders143.js'

export function runSyntheticReflectionChecks(C, viewer) {
  const scene = viewer.scene, context = scene.context, gl = context._gl, size = 64
  const resources = [], states = [], checks = {}, measurements = {}
  const viewport = C.BoundingRectangle.clone(context.uniformState.viewport)
  const readBinding = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING), drawBinding = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)
  const check = (name, ok) => { checks[name] = !!ok; if (!ok) throw new Error(`SSR numeric ${name}: ${JSON.stringify(measurements)}`) }
  const fill = values => new Float32Array(Array.from({ length: size * size }, () => values).flat())
  const texture = (format, array, width = size, height = size) => {
    const t = new C.Texture({ context, pixelFormat: format, pixelDatatype: C.PixelDatatype.FLOAT,
      source: { width, height, arrayBufferView: array }, flipY: false,
      sampler: new C.Sampler({ minificationFilter: C.TextureMinificationFilter.NEAREST, magnificationFilter: C.TextureMagnificationFilter.NEAREST }) })
    resources.push(t); return t
  }
  const depthData = new Float32Array(size * size).fill(10)
  const normals = fill([.75, .5, .1, 1]), colorData = fill([0, 0, 0, .37])
  for (let y = 0; y < size; y++) for (let x = 37; x < size; x++) {
    const index = y * size + x, rayX = ((x + .5) / size * 2 - 1) * Math.tan(Math.PI / 6)
    depthData[index] = 2 / rayX
    normals.set([0, .5, .1, 1], index * 4)
    colorData.set([4, .2, .1, .37], index * 4)
  }
  const depth = texture(C.PixelFormat.RED, depthData), material = texture(C.PixelFormat.RGBA, normals)
  const flags = texture(C.PixelFormat.RGBA, fill([0, 0, 0, 15]))
  const transparency = texture(C.PixelFormat.RED, new Float32Array(size * size))
  const specular = texture(C.PixelFormat.RGBA, fill([.4, .2, .1, 1]))
  const response = texture(C.PixelFormat.RGBA, fill([.5, .25, .1, .1]))
  const color = texture(C.PixelFormat.RGBA, colorData)
  const camera = new C.PerspectiveFrustum({ fov: Math.PI / 3, aspectRatio: 1, near: 1, far: 1000 })
  const inverse = C.Matrix4.inverse(camera.projectionMatrix, new C.Matrix4())
  const pyramidScene = { context, drawingBufferWidth: size, drawingBufferHeight: size, frameState: { frameNumber: 1 }, isDestroyed: () => false }
  const pyramid = new DepthPyramid143(C, pyramidScene)
  const updateDepth = () => {
    depth.copyFrom({ source: { width: size, height: size, arrayBufferView: depthData } })
    pyramidScene.frameState.frameNumber++
    if (!pyramid.update(depth, pyramidScene.frameState.frameNumber, transparency)) throw new Error(JSON.stringify(pyramid.getDiagnostics()))
  }
  const probeShader = `${reflectionCommon}\n${traceFunctions}\nuniform vec3 u_probeNormal;\nvoid main(){out_FragColor=traceReflection(ivec2(20,32),reflectionPosition(ivec2(20,32)),u_probeNormal,texture(u_response,vec2(.3,.5)).a);}`
  const run = (shader, width, height, extras = {}) => {
    const target = new C.Texture({ context, width, height, pixelFormat: C.PixelFormat.RGBA, pixelDatatype: C.PixelDatatype.FLOAT }); resources.push(target)
    const framebuffer = new C.Framebuffer({ context, colorTextures: [target], destroyAttachments: false }); resources.push(framebuffer)
    const options = { viewport: new C.BoundingRectangle(0, 0, width, height), depthTest: { enabled: false }, depthMask: false }
    states.push(options)
    const levels = pyramid.getLevels()
    const uniforms = { u_depth: depth, u_material: material, u_flags: flags, u_transparency: transparency, u_specular: specular,
      u_response: response, u_inverseProjection: inverse, u_projection: camera.projectionMatrix, u_strength: 1,
      u_maxLevel: 5, u_distance: 50, u_near: 1, u_thickness: .3, u_probeNormal: new C.Cartesian3(Math.SQRT1_2, 0, Math.SQRT1_2), colorTexture: color,
      ...Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`u_hiz${i}`, levels[i].texture])), ...extras }
    const command = context.createViewportQuadCommand(shader, { framebuffer, renderState: C.RenderState.fromCache(options),
      uniformMap: Object.fromEntries(Object.entries(uniforms).map(([name, value]) => [name, () => value])) })
    resources.push(command.shaderProgram); command.execute(context)
    return { texture: target, pixels: context.readPixels({ framebuffer, width, height }) }
  }
  const pixel = (data, width, x, y) => Array.from(data.slice((y * width + x) * 4, (y * width + x) * 4 + 4))
  try {
    updateDepth()
    for(const group of [1,8192,16383]){
      flags.copyFrom({source:{width:size,height:size,arrayBufferView:fill([0,0,0,group*1024+783])}})
      check('compactSsrFlags'+group,run(reflectionCommon+'\nvoid main(){out_FragColor=vec4(float(reflectionReceiver(ivec2(20,32))));}',1,1).pixels[0]===1)
      check('compactAoFlags'+group,run(aoCommon+'\nvoid main(){out_FragColor=vec4(float(aoReceiver(ivec2(20,32))));}',1,1).pixels[0]===1)
    }
    flags.copyFrom({source:{width:size,height:size,arrayBufferView:fill([0,0,0,15])}})
    const comparison = `uniform highp sampler2D u_depth; uniform bool campus_transparentStrictDepth;
      void main(){vec4 campus_transparentNative=vec4(1.0);${transparentVisibility('10.0')}out_FragColor=vec4(1.0);}`
    check('strictTransparentDepthRejectsEqualOpaqueSurface', run(comparison, 1, 1, { campus_transparentStrictDepth: true }).pixels[0] === 0)
    check('inclusiveTransparentDepthKeepsEqualOpaqueSurface', run(comparison, 1, 1, { campus_transparentStrictDepth: false }).pixels[0] === 1)
    const hit = Array.from(run(probeShader, 1, 1).pixels)
    measurements.hit = hit
    check('knownSideWallHit', hit[0] > .65 && hit[0] < .75 && hit[2] > .9)
    const brute = Array.from(run(probeShader, 1, 1, { u_maxLevel: 0 }).pixels)
    measurements.pixelTraversal = brute
    check('hierarchyMatchesPixelTraversal', hit.every((v, i) => Math.abs(v - brute[i]) < .02))
    const raw = run(traceShader, 32, 32)
    measurements.traceColor = pixel(raw.pixels, 32, 10, 16)
    check('traceSamplesHDRHitRadiance', measurements.traceColor[0] > 3.99 && measurements.traceColor[3] > .9)
    check('rayLeavingScreenFallsBack', run(probeShader, 1, 1, { u_probeNormal: new C.Cartesian3(0, 0, 1) }).pixels[2] === 0)
    check('rangeLimitRejectsDistantHit', run(probeShader, 1, 1, { u_distance: .3 }).pixels[2] === 0)
    const knownDepth = depthData.slice()
    for (let y = 0; y < size; y++) for (let x = 37; x < size; x++) depthData[y * size + x] = 7
    updateDepth()
    check('thicknessRejectsUnrelatedDepthLayer', run(probeShader, 1, 1, { u_distance: 6, u_thickness: .1 }).pixels[2] === 0)
    check('thicknessBudgetIsApplied', run(probeShader, 1, 1, { u_distance: 6, u_thickness: 3 }).pixels[2] > 0)
    depthData.set(knownDepth); updateDepth()
    const cover = new Float32Array(size * size)
    for (let y = 0; y < size; y++) for (let x = 37; x < size; x++) cover[y * size + x] = 1
    transparency.copyFrom({ source: { width: size, height: size, arrayBufferView: cover } })
    updateDepth()
    check('transparentHitCannotReflectUnderlyingOpaqueColor', run(probeShader, 1, 1).pixels[2] === 0)
    transparency.copyFrom({ source: { width: size, height: size, arrayBufferView: new Float32Array(size * size) } })
    updateDepth()
    transparency.copyFrom({ source: { width: size, height: size, arrayBufferView: new Float32Array(size * size).fill(1) } })
    updateDepth()
    check('transparentReceiverTracesOpaqueSceneThroughOwnCoverage', run('#define REFLECTION_TRANSPARENT_RECEIVER\n' + probeShader, 1, 1).pixels[2] > .9)
    check('opaqueReceiverStillRejectsTransparentCoverage', run(probeShader, 1, 1).pixels[2] === 0)
    depthData[32 * size + 44] = -1; updateDepth()
    check('mixedHiZMaskPreservesOpaqueAndTransparentBits', run(`${reflectionCommon}\nuniform highp sampler2D u_hiz0;\nvoid main(){out_FragColor=texelFetch(u_hiz0,ivec2(22,16),0);}`, 1, 1).pixels[3] === 3)
    check('transparentRayStillStopsAtUnknownOpaque', run('#define REFLECTION_TRANSPARENT_RECEIVER\n' + probeShader, 1, 1).pixels[2] === 0)
    depthData.set(knownDepth)
    transparency.copyFrom({ source: { width: size, height: size, arrayBufferView: new Float32Array(size * size) } })
    updateDepth()
    const savedDepth = depthData.slice()
    for (let y = 0; y < size; y++) for (let x = 37; x < size; x++) depthData[y * size + x] = -1
    updateDepth()
    check('unknownOccluderStopsRay', run(probeShader, 1, 1).pixels[2] === 0)
    depthData.set(savedDepth); updateDepth()
    response.copyFrom({ source: { width: size, height: size, arrayBufferView: fill([.5, .25, .1, .9]) } })
    check('roughMaterialKeepsCubemap', run(probeShader, 1, 1).pixels[2] === 0)
    response.copyFrom({ source: { width: size, height: size, arrayBufferView: fill([.5, .25, .1, .1]) } })
    color.copyFrom({ source: { width: size, height: size, arrayBufferView: fill([2, 1, .5, .37]) } })
    const reflectionFill = values => new Float32Array(Array.from({ length: 32 * 32 }, () => values).flat())
    const reflected = texture(C.PixelFormat.RGBA, reflectionFill([4, 2, 1, 1]), 32, 32)
    const resolved = run(resolveShader, size, size, { u_reflection: reflected })
    measurements.resolve = pixel(resolved.pixels, size, 20, 32)
    check('replaceNativeSpecularPreservesHDRAndAlpha', measurements.resolve.every((v, i) => Math.abs(v - [3.6, 1.3, .5, .37][i]) < .00002))
    const blocked = reflectionFill([4, 2, 1, 1])
    blocked[(16 * 32 + 10) * 4 + 3] = .001
    reflected.copyFrom({ source: { width: 32, height: 32, arrayBufferView: blocked } })
    const fading = pixel(run(resolveShader, size, size, { u_reflection: reflected }).pixels, size, 20, 32)
    check('fadingCenterCannotBeAmplifiedByNeighbors', Math.abs(fading[0] - 2) < .002)
    blocked[(16 * 32 + 10) * 4 + 3] = 0
    reflected.copyFrom({ source: { width: 32, height: 32, arrayBufferView: blocked } })
    measurements.blockedResolve = pixel(run(resolveShader, size, size, { u_reflection: reflected }).pixels, size, 20, 32)
    check('blockedRayCannotBeFilledFromNeighbors', measurements.blockedResolve.every((v, i) => Math.abs(v - [2, 1, .5, .37][i]) < .00002))
    reflected.copyFrom({ source: { width: 32, height: 32, arrayBufferView: reflectionFill([100, 100, 100, 0]) } })
    check('missPreservesNativeCubemap', pixel(run(resolveShader, size, size, { u_reflection: reflected }).pixels, size, 20, 32)
      .every((v, i) => Math.abs(v - [2, 1, .5, .37][i]) < .00002))
    check('zeroStrengthPreservesOriginal', pixel(run(resolveShader, size, size, { u_reflection: reflected, u_strength: 0 }).pixels, size, 20, 32)
      .every((v, i) => Math.abs(v - [2, 1, .5, .37][i]) < .00002))
    check('noGLError', gl.getError() === gl.NO_ERROR)
    return { checks, measurements }
  } finally {
    pyramid.destroy()
    for (const resource of resources.reverse()) if (!resource.isDestroyed()) resource.destroy()
    for (const options of states) C.RenderState.removeFromCache(options)
    context.uniformState.viewport = viewport
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, readBinding); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, drawBinding)
  }
}
