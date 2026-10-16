import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import CloudTemporal143, { cloudTemporalResolveShader } from '../../src/environment/CloudTemporal143.js'

const Cesium = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')
const identity = () => Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY)

function fixture() {
  const resources = [], draws = [], states = []
  class Resource {
    constructor(options = {}) { Object.assign(this, options); this.status = 1; resources.push(this) }
    destroy() { assert.ok(!this.dead, 'resources must be released exactly once'); this.dead = true }
    isDestroyed() { return !!this.dead }
  }
  class Texture extends Resource {
    constructor(options) {
      super(options)
      const channels = options.pixelFormat === Cesium.PixelFormat.RED ? 1 : 4
      this.sizeInBytes = options.width * options.height * channels * (options.pixelDatatype === Cesium.PixelDatatype.FLOAT ? 4 : 2)
    }
  }
  const C = { ...Cesium, Texture, Framebuffer: Resource,
    RenderState: { fromCache(options) { states.push(options); return options }, removeFromCache(state) { states.splice(states.indexOf(state), 1) } } }
  const viewport = new C.BoundingRectangle(4, 5, 80, 60)
  const context = { webgl2: true, floatingPointTexture: true, colorBufferFloat: true,
    halfFloatingPointTexture: true, colorBufferHalfFloat: true,
    uniformState: { viewport }, _currentFramebuffer: 'native',
    _gl: { FRAMEBUFFER_COMPLETE: 1, READ_FRAMEBUFFER_BINDING: 2, DRAW_FRAMEBUFFER_BINDING: 3,
      READ_FRAMEBUFFER: 4, DRAW_FRAMEBUFFER: 5, getParameter: x => x, bindFramebuffer() {}, isContextLost: () => false },
    createViewportQuadCommand(shader, options) {
      return { ...options, shader, shaderProgram: new Resource(), execute(ctx, passState) {
        draws.push({ shader, uniforms: Object.fromEntries(Object.entries(this.uniformMap).map(([k, v]) => [k, v()])), framebuffer: this.framebuffer, passState })
        ctx.uniformState.viewport = passState.viewport; ctx._currentFramebuffer = this.framebuffer
        if (context.failDraw === draws.length) throw new Error('draw failed')
      } }
    } }
  const scene = { context, frameState: { frameNumber: 1 }, isDestroyed: () => false }
  const pass = new CloudTemporal143(C, scene)
  const color = { width: 32, height: 16 }, depth = { width: 32, height: 16 }
  const frame = { inverseViewProjection: identity(), viewProjection: identity(),
    positionWC: new C.Cartesian3(), directionWC: new C.Cartesian3(0, 0, -1),
    windOffsetWC: new C.Cartesian3(), simulationSeconds: 1, resetKey: 'weather-a', cloudsActive: true, frameNumber: 1 }
  const execute = () => pass.execute(context, color, depth, frame)
  const next = () => { frame.frameNumber++; frame.simulationSeconds += 1 / 60 }
  return { C, pass, scene, context, viewport, frame, color, depth, execute, next, draws, resources, states }
}

test('cloud history resolves independently, ping-pongs and preserves external viewport/framebuffer state', () => {
  const f = fixture()
  const a = f.execute()
  assert.notEqual(a, f.color)
  assert.equal(f.draws[0].uniforms.u_historyValid, false)
  assert.equal(f.context._currentFramebuffer, 'native')
  assert.deepEqual(f.context.uniformState.viewport, f.viewport)
  assert.equal(f.pass.getDiagnostics().age, 1)
  a.sampler = f.pass.nearestSampler
  f.next(); const b = f.execute()
  assert.notEqual(a, b)
  assert.equal(f.draws[2].uniforms.u_historyValid, true)
  assert.equal(f.draws[2].uniforms.u_historyColor, a)
  assert.equal(a.sampler.minificationFilter, f.C.TextureMinificationFilter.LINEAR, 'history sampling survives downstream sampler mutation')
  assert.notEqual(f.draws[2].framebuffer.colorTextures[0], a)
  const depthHistory = f.draws[2].uniforms.u_historyDepth
  assert.equal(depthHistory.pixelDatatype, f.C.PixelDatatype.FLOAT, '20M no-hit sentinel needs float32')
  assert.equal(depthHistory.pixelFormat, f.C.PixelFormat.RED, 'history retains distance alone in R32F')
  assert.equal(depthHistory.sizeInBytes, 32 * 16 * 4)
  assert.equal(f.pass.getDiagnostics().depthFormat, 'r32f')
  assert.equal(f.pass.getDiagnostics().bytes, 32 * 16 * 24, 'two RGBA16F and two R32F targets')
  assert.equal(f.pass.getDiagnostics().transmittanceHistory, 'resolved-color-alpha')
  assert.equal(depthHistory.sampler.minificationFilter, f.C.TextureMinificationFilter.NEAREST)
  f.next(); assert.equal(f.execute(), a)
  assert.equal(f.pass.getDiagnostics().age, 3)
  f.pass.destroy(); f.pass.destroy()
  assert.ok(f.resources.every(r => r.dead))
  assert.equal(f.states.length, 0)
})

test('half-resolution 1080p cloud history uses half the previous texture byte budget', () => {
  const f = fixture()
  f.color.width = f.depth.width = 960
  f.color.height = f.depth.height = 540
  f.execute()
  const bytes = f.pass.getDiagnostics().bytes
  assert.equal(bytes, 12_441_600)
  assert.equal(bytes, 960 * 540 * (2 * 8 + 2 * 4))
  assert.equal(960 * 540 * (2 * 8 + 2 * 16) - bytes, bytes)
  f.pass.destroy()
})

for (const [reason, change] of [
  ['reset-key', f => { f.frame.resetKey = 'weather-b' }],
  ['resize', f => { f.color.width = f.depth.width = 64 }],
  ['camera-jump', f => { f.frame.positionWC.x = 501 }],
  ['camera-rotation', f => { f.frame.directionWC = new f.C.Cartesian3(1, 0, 0) }],
  ['time-jump', f => { f.frame.simulationSeconds += 2 }],
  ['time-jump', f => { f.frame.simulationSeconds = 0 }],
  ['frame-gap', f => { f.frame.frameNumber += 2 }]
]) test(`invalidates ${reason} before sampling history`, () => {
  const f = fixture(); f.execute(); f.next(); change(f)
  assert.equal(f.pass.prepare(f.frame, f.color.width, f.color.height), false)
  assert.equal(f.pass.getDiagnostics().resetReason, reason)
  f.execute()
  assert.equal(f.draws.at(-2).uniforms.u_historyValid, false)
  assert.equal(f.pass.getDiagnostics().age, 1)
  f.pass.destroy()
})

test('same-frame repeat, missing depth, inactive clouds and failures never reuse invalid history', () => {
  const f = fixture(); f.execute()
  assert.equal(f.execute(), f.color)
  assert.equal(f.pass.getDiagnostics().resetReason, 'frame-gap')
  f.next(); assert.equal(f.pass.execute(f.context, f.color, null, f.frame), f.color)
  f.frame.cloudsActive = false; assert.equal(f.execute(), f.color)
  assert.equal(f.pass.getDiagnostics().valid, false)
  f.frame.cloudsActive = true; f.next(); f.context.failDraw = f.draws.length + 2
  assert.equal(f.execute(), f.color, 'depth-copy failure cannot publish incomplete history')
  assert.equal(f.pass.getDiagnostics().valid, false)
  assert.match(f.pass.getDiagnostics().error, /draw failed/)
  assert.equal(f.context._currentFramebuffer, 'native')
  assert.deepEqual(f.context.uniformState.viewport, f.viewport)
  f.pass.destroy(); assert.ok(f.resources.every(r => r.dead))
})

test('camera-relative matrices preserve Earth-scale rays and reproject against wind displacement', () => {
  const f = fixture(), C = f.C
  const eye = new C.Cartesian3(6378137, 0, 10000)
  const view = C.Matrix4.fromTranslation(C.Cartesian3.negate(eye, new C.Cartesian3()))
  const projection = new C.PerspectiveFrustum({ fov: Math.PI / 3, aspectRatio: 2, near: .1, far: 2e7 }).projectionMatrix
  f.frame.viewProjection = C.Matrix4.multiply(projection, view, new C.Matrix4())
  f.frame.inverseViewProjection = C.Matrix4.inverse(f.frame.viewProjection, new C.Matrix4())
  f.frame.positionWC = eye
  f.execute(); f.next(); f.frame.windOffsetWC.x = 10
  f.execute()
  const u = f.draws.at(-2).uniforms
  const ray = C.Matrix4.multiplyByVector(u.u_inverseViewProjectionRelative, new C.Cartesian4(0, 0, 0, 1), new C.Cartesian4())
  assert.ok(Math.abs(ray.x / ray.w) < 1e-8, 'no Earth-centre subtraction in GPU float arithmetic')
  assert.ok(ray.z / ray.w < 0)
  const prev = C.Matrix4.multiplyByVector(u.u_previousViewProjectionRelative, new C.Cartesian4(0, 0, -1000, 1), new C.Cartesian4())
  assert.ok(prev.x / prev.w < 0, 'positive cloud motion reprojects toward its old left position')
  assert.equal(u.u_previousCameraOffset.x, -10)
  f.pass.destroy()
})

test('cloud depth disagreement is measured from the previous camera and behind-camera points have negative clip w', () => {
  const f = fixture(), C = f.C
  const projection = new C.PerspectiveFrustum({ fov: Math.PI / 3, aspectRatio: 2, near: .1, far: 2e7 }).projectionMatrix
  const cameraAt = z => {
    f.frame.positionWC.z = z
    f.frame.viewProjection = C.Matrix4.multiply(projection, C.Matrix4.fromTranslation(new C.Cartesian3(0, 0, -z)), new C.Matrix4())
    f.frame.inverseViewProjection = C.Matrix4.inverse(f.frame.viewProjection, new C.Matrix4())
  }
  cameraAt(0); f.execute(); f.next(); cameraAt(-25); f.execute()
  const u = f.draws.at(-2).uniforms
  const previousVector = C.Cartesian3.add(new C.Cartesian3(0, 0, -975), u.u_previousCameraOffset, new C.Cartesian3())
  const expected = C.Cartesian3.magnitude(previousVector)
  assert.equal(expected, 1000, 'camera motion must not reject a stationary cloud')
  const acceptsDepth = previousDepth => Math.abs(previousDepth - expected) <= Math.max(50, expected * .12)
  assert.equal(acceptsDepth(1000), true)
  assert.equal(acceptsDepth(2000), false, 'a newly revealed cloud layer must reject old history')
  // The cloud is in front of the current camera but behind the old one.
  f.next(); cameraAt(100); f.execute()
  const behind = C.Matrix4.multiplyByVector(f.draws.at(-2).uniforms.u_previousViewProjectionRelative,
    new C.Cartesian4(0, 0, -50, 1), new C.Cartesian4())
  assert.ok(behind.w < 0)
  f.pass.destroy()
})

test('invalid frame and missing/mismatched depth recover on the next complete cloud sample', () => {
  const f = fixture(), matrix = f.frame.inverseViewProjection
  f.frame.inverseViewProjection = null
  assert.equal(f.execute(), f.color)
  f.frame.inverseViewProjection = matrix; f.next()
  assert.notEqual(f.execute(), f.color)
  f.next(); f.depth.width = 8
  assert.equal(f.execute(), f.color)
  assert.equal(f.pass.getDiagnostics().valid, false)
  f.depth.width = f.color.width; f.next()
  assert.notEqual(f.execute(), f.color)
  f.pass.destroy()
})

test('scene frame number fallback rejects duplicate execution and destroy prevents allocation', () => {
  const f = fixture(); delete f.frame.frameNumber
  f.execute(); assert.equal(f.execute(), f.color)
  f.scene.frameState.frameNumber++
  assert.notEqual(f.execute(), f.color)
  f.pass.destroy()
  const count = f.resources.length
  assert.equal(f.execute(), f.color)
  assert.equal(f.resources.length, count)
})

test('partial command allocation can retry without omitting the depth copy', () => {
  const f = fixture(), create = f.context.createViewportQuadCommand
  let attempts = 0
  f.context.createViewportQuadCommand = (...args) => {
    if (++attempts === 2) throw new Error('copy shader allocation failed')
    return create(...args)
  }
  assert.equal(f.execute(), f.color)
  f.next(); assert.notEqual(f.execute(), f.color)
  assert.equal(f.draws.length, 2)
  assert.equal(f.draws[1].shader.includes('out_FragColor = texture(u_currentDepth'), true)
  f.pass.destroy(); assert.ok(f.resources.every(r => r.dead))
})

test('status queries cannot leave a stale native framebuffer cache before the cloud draw', () => {
  const f = fixture(), Resource = f.C.Framebuffer
  let readBinding = 'native-read', drawBinding = 'native-draw', checked = 0
  f.context._gl.getParameter = key => key === 2 ? readBinding : drawBinding
  f.context._gl.bindFramebuffer = (target, value) => {
    if (target === 4) readBinding = value
    else drawBinding = value
  }
  f.C.Framebuffer = class extends Resource {
    constructor(options) {
      super(options)
      delete this.status
      Object.defineProperty(this, 'status', { get() { checked++; readBinding = drawBinding = null; return 1 } })
    }
  }
  const create = f.context.createViewportQuadCommand
  f.context.createViewportQuadCommand = (...args) => {
    const command = create(...args), execute = command.execute
    command.execute = (context, passState) => {
      assert.equal(context._currentFramebuffer, undefined, 'force the first real draw to bind after raw status queries')
      execute.call(command, context, passState)
    }
    return command
  }
  // Only the first draw needs an invalid cache; the second naturally changes targets.
  const createChecked = f.context.createViewportQuadCommand
  let number = 0
  f.context.createViewportQuadCommand = (...args) => ++number === 1 ? createChecked(...args) : create(...args)
  assert.notEqual(f.execute(), f.color)
  assert.equal(checked, 4)
  assert.equal(f.context._currentFramebuffer, 'native')
  assert.equal(readBinding, 'native-read'); assert.equal(drawBinding, 'native-draw')
  f.pass.destroy()
})

test('shader rejects cloud disocclusion and clips HDR/T with the upstream 3x3 moment method', () => {
  const combined = new Cesium.ShaderSource({ sources: [cloudTemporalResolveShader] }).createCombinedFragmentShader({ webgl2: true })
  assert.match(combined, /^#version 300 es/)
  assert.equal((combined.match(/out vec4 out_FragColor;/g) || []).length, 1)
  assert.match(cloudTemporalResolveShader, /currentDepth\.r\s*>=\s*19999999/)
  assert.match(cloudTemporalResolveShader, /previousClip\.w\s*<=\s*0\.0/)
  assert.match(cloudTemporalResolveShader, /abs\(previousDepth - expectedDepth\)/)
  assert.match(cloudTemporalResolveShader, /abs\(historySample\.a - current\.a\) > 0\.2/)
  assert.equal((cloudTemporalResolveShader.match(/texture\(u_historyColor, previousUv\)/g) || []).length, 1)
  assert.match(cloudTemporalResolveShader, /cloudVarianceClip\(coord, historySample\)/)
  assert.match(cloudTemporalResolveShader, /moment2 \/ 9\.0 - mean \* mean/)
  assert.match(cloudTemporalResolveShader, /for \(int y = -1; y <= 1;/)
  assert.match(cloudTemporalResolveShader, /minimumT = min\(minimumT, sampleColor\.a\)/)
  assert.match(cloudTemporalResolveShader, /maximumT = max\(maximumT, sampleColor\.a\)/)
  assert.match(cloudTemporalResolveShader, /clamp\(history\.a, minimumT, maximumT\)/)
  assert.match(cloudTemporalResolveShader, /max\(color\.rgb, vec3\(0\.0\)\)/)
})
