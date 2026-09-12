import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { halton, jitterSample, nearPlaneOffsets, DEFAULT_JITTER_SAMPLES }
  from '../../src/antialiasing/jitter143.js'
import { resolveMsaaPolicy, normalizeAntiAliasing, isPostProcessAntiAliasing }
  from '../../src/antialiasing/settings143.js'

test('bridge excludes unrelated cameras and preserves external hooks and offsets on detach', () => {
  const f = bridgeScene()
  const bridge = new FrustumJitterBridge143(C, f.scene, { request: () => ({ frustum: f.cameraFrustum,
    pixel: { x: .25, y: .25 }, xOffset: 0, yOffset: 0 }) })
  bridge.attach()
  const other = perspectiveFrustum(10)
  f.state.updateFrustum(other)
  assert.equal(other.xOffset, 0)
  const derived = f.cameraFrustum.clone()
  f.state.updateFrustum(derived)
  derived.xOffset = .125
  const prior = f.state.updateFrustum
  const external = function(value) { return prior.call(this, value) }
  f.state.updateFrustum = external
  bridge.detach()
  assert.equal(f.state.updateFrustum, external)
  assert.equal(derived.xOffset, .125)
  f.state.updateFrustum(other)
  assert.equal(other.xOffset, 0)
})

test('jitter follows a replaced perspective frustum and restores both cameras', () => {
  const f = bridgeScene(), jitter = new TaaJitter143(C, f.scene)
  jitter.setEnabled(true); jitter.apply()
  const old = f.scene.camera.frustum
  f.scene.camera.frustum = perspectiveFrustum(2)
  jitter.apply()
  const clone = f.scene.camera.frustum.clone(); clone.near = 100
  f.state.updateFrustum(clone)
  assert.notEqual(clone.xOffset, 0)
  assert.equal(old.xOffset, 0); assert.equal(old.yOffset, 0)
  jitter.destroy()
  assert.equal(clone.xOffset, 0); assert.equal(f.scene.camera.frustum.xOffset, 0)
})
import FrustumJitterBridge143 from '../../src/antialiasing/FrustumJitterBridge143.js'
import TaaJitter143 from '../../src/antialiasing/TaaJitter143.js'

const C = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')

const resolution = { width: 1920, height: 1080 }

// The pixel offset a frustum's published projection actually produces. The review of the
// first implementation measured exactly this quantity inside updateFrustum; asserting it
// through the projection matrix is what distinguishes "the offsets were written" from
// "the raster moved".
const drawnPixels = (frustum, size = resolution) => {
  const matrix = frustum.projectionMatrix
  return { x: -matrix[8] * size.width / 2, y: -matrix[9] * size.height / 2 }
}

const perspectiveFrustum = near => new C.PerspectiveFrustum({
  fov: Math.PI / 3, aspectRatio: 16 / 9, near, far: 500000
})

// A scene stub with the two things the bridge touches: the camera's frustum, whose clone
// the scene derives its drawing frustum from, and the uniform state whose updateFrustum
// publishes the projection the GPU draws with.
function bridgeScene({ prototypeMethod = false } = {}) {
  const cameraFrustum = perspectiveFrustum(0.1)
  const published = []
  const state = { calls: 0, lastNear: null }
  const updateFrustum = function (frustum) {
    state.calls++
    state.lastNear = frustum.near
    published.push(drawnPixels(frustum))
    return frustum
  }
  if (prototypeMethod) Object.setPrototypeOf(state, { updateFrustum })
  else state.updateFrustum = updateFrustum
  const scene = {
    camera: { frustum: cameraFrustum },
    context: { uniformState: state },
    drawingBufferWidth: resolution.width,
    drawingBufferHeight: resolution.height,
    isDestroyed: () => false
  }
  return { scene, cameraFrustum, state, published, original: updateFrustum }
}

// Scene never draws with scene.camera.frustum. It derives a drawing frustum by cloning the
// camera's, then replaces near with the drawing range: PerspectiveFrustum.clone copies
// fov/aspect/near/far but not xOffset/yOffset, and a near-plane metre offset stops being a
// constant pixel offset once near changes. On the campus view the drawing near is
// 1113.4586 m against a camera near of 0.1 m, i.e. 11134x too large for the offset to
// survive on its own.
test('the jitter reaches the frustum the scene actually draws with', () => {
  const f = bridgeScene()
  const request = { frustum: f.cameraFrustum, pixel: { x: -0.375, y: 0.25 }, xOffset: 0, yOffset: 0 }
  nearPlaneOffsets({ fovy: f.cameraFrustum.fovy, aspectRatio: f.cameraFrustum.aspectRatio,
    near: f.cameraFrustum.near }, request.pixel, resolution)
  const bridge = new FrustumJitterBridge143(C, f.scene, { request: () => request })
  assert.equal(bridge.attach(), true)

  const drawingFrustum = f.cameraFrustum.clone()
  drawingFrustum.near = 1113.4585898213
  assert.equal(drawingFrustum.xOffset, 0, 'clone drops the offsets, which is the root cause')
  assert.equal(drawingFrustum.yOffset, 0)

  f.state.updateFrustum(drawingFrustum)
  const drawn = drawnPixels(drawingFrustum)
  assert.ok(Math.abs(drawn.x - request.pixel.x) < 1e-6, `drawn x ${drawn.x}`)
  assert.ok(Math.abs(drawn.y - request.pixel.y) < 1e-6, `drawn y ${drawn.y}`)

  // The metre offset has to grow with near for the clip-space shift to stay constant, so the
  // drawing frustum carries the near ratio -- 11134x on the campus view -- of the metres a
  // camera-near offset would need.
  const cameraNear = nearPlaneOffsets({ fovy: f.cameraFrustum.fovy,
    aspectRatio: f.cameraFrustum.aspectRatio, near: f.cameraFrustum.near }, request.pixel, resolution)
  assert.ok(drawingFrustum.xOffset > 1000 * cameraNear.xOffset,
    `drawing offset ${drawingFrustum.xOffset} vs camera-near ${cameraNear.xOffset}`)

  // The camera frustum is published too (updateCamera calls updateFrustum with it) and its
  // offsets are already metre-correct for its own near, so it must not be rescaled.
  f.cameraFrustum.xOffset = 2.2553e-5
  f.cameraFrustum.yOffset = 0
  const before = f.cameraFrustum.xOffset
  f.state.updateFrustum(f.cameraFrustum)
  assert.equal(f.cameraFrustum.xOffset, before, 'the camera frustum is left alone')

  bridge.detach()
  assert.equal(drawingFrustum.xOffset, 0, 'the drawing frustum is handed back')
  assert.equal(drawingFrustum.yOffset, 0)
  assert.equal(f.cameraFrustum.xOffset, 2.2553e-5, 'and so is the camera frustum')
  assert.equal(f.state.calls, 2, 'detaching stops publishing')
  f.state.updateFrustum(drawingFrustum)
  assert.equal(f.state.calls, 3, 'the original method is back in place')
  assert.equal(drawingFrustum.xOffset, 0)
})

test('the bridge keeps every frame of the sequence on the requested pixel', () => {
  const f = bridgeScene({ prototypeMethod: true })
  const size = { width: 1600, height: 900 }
  f.scene.drawingBufferWidth = size.width
  f.scene.drawingBufferHeight = size.height
  const request = { frustum: f.cameraFrustum, pixel: { x: 0, y: 0 }, xOffset: 0, yOffset: 0 }
  const bridge = new FrustumJitterBridge143(C, f.scene, { request: () => request })
  bridge.attach()

  const drawingFrustum = f.cameraFrustum.clone()
  drawingFrustum.near = 900
  const seen = new Set()
  for (let frame = 0; frame < 8; frame++) {
    request.pixel = jitterSample(frame, 8)
    request.xOffset = nearPlaneOffsets({ fovy: f.cameraFrustum.fovy,
      aspectRatio: f.cameraFrustum.aspectRatio, near: f.cameraFrustum.near }, request.pixel, size).xOffset
    f.cameraFrustum.xOffset = request.xOffset
    f.state.updateFrustum(drawingFrustum)
    const drawn = drawnPixels(drawingFrustum, size)
    assert.ok(Math.abs(drawn.x - request.pixel.x) < 1e-6, `frame ${frame} x ${drawn.x}`)
    assert.ok(Math.abs(drawn.y - request.pixel.y) < 1e-6, `frame ${frame} y ${drawn.y}`)
    seen.add(`${drawn.x.toFixed(6)},${drawn.y.toFixed(6)}`)
  }
  // A stuck sample would satisfy a single-frame check while producing no temporal coverage.
  assert.equal(seen.size, 8)

  bridge.detach()
  // Restoring through `delete` must return the prototype method, not leave a stub behind.
  assert.equal(Object.prototype.hasOwnProperty.call(f.state, 'updateFrustum'), false)
  assert.equal(typeof f.state.updateFrustum, 'function')
  f.state.updateFrustum(drawingFrustum)
  assert.equal(f.state.calls, 9)
  assert.equal(drawingFrustum.xOffset, 0, 'the drawing frustum keeps no stale offset')
})

test('the bridge stands down when there is no request or no usable frustum', () => {
  const f = bridgeScene()
  let request = null
  const bridge = new FrustumJitterBridge143(C, f.scene, { request: () => request })
  bridge.attach()

  const drawingFrustum = f.cameraFrustum.clone()
  drawingFrustum.near = 1113
  f.state.updateFrustum(drawingFrustum)
  assert.equal(drawingFrustum.xOffset, 0, 'no request means no write')

  // A released jitter must not keep re-normalizing whatever frustum shows up next.
  request = { frustum: f.cameraFrustum, pixel: { x: 0.5, y: 0.5 }, xOffset: 0, yOffset: 0 }
  f.state.updateFrustum(drawingFrustum)
  assert.notEqual(drawingFrustum.xOffset, 0)
  request = null
  bridge.detach()
  assert.equal(drawingFrustum.xOffset, 0)

  // Non-perspective drawing frusta (2D / Columbus view) have no near-plane offset pair.
  bridge.attach()
  request = { frustum: f.cameraFrustum, pixel: { x: 0.5, y: 0.5 }, xOffset: 0, yOffset: 0 }
  const orthographic = new C.OrthographicFrustum({ width: 100, aspectRatio: 1 })
  f.state.updateFrustum(orthographic)
  assert.equal(orthographic.xOffset, undefined, 'orthographic frusta are left untouched')

  // A resized-to-zero drawing buffer cannot express a sub-pixel offset.
  const tiny = bridgeScene()
  tiny.scene.drawingBufferWidth = 0
  const second = new FrustumJitterBridge143(C, tiny.scene, { request: () => request })
  second.attach()
  const unusable = tiny.cameraFrustum.clone()
  unusable.near = 50
  tiny.state.updateFrustum(unusable)
  assert.equal(unusable.xOffset, 0)

  bridge.detach()
  second.detach()
  assert.equal(bridge.getDiagnostics().attached, false)
  assert.equal(second.getDiagnostics().attached, false)
})

test('the jitter refuses to enable when the offsets cannot reach the raster', () => {
  // An offset written on the camera frustum while the raster keeps drawing with an
  // unjittered projection would shift every consumer of camera.frustum without shifting the
  // image, so the jitter must not run at all rather than half-run.
  const scene = { camera: { frustum: perspectiveFrustum(1) },
    context: {}, drawingBufferWidth: 1920, drawingBufferHeight: 1080, isDestroyed: () => false }
  const jitter = new TaaJitter143(C, scene, { samples: 8 })
  jitter.setEnabled(true)
  assert.equal(jitter.getDiagnostics().enabled, false)
  assert.match(jitter.getDiagnostics().reason, /uniformState/)
  assert.equal(scene.camera.frustum.xOffset, 0)

  // With the publication path available the request is what the bridge re-normalizes.
  const f = bridgeScene()
  const wired = new TaaJitter143(C, f.scene, { samples: 8 })
  assert.equal(wired.getRequest(), null, 'no request before the first frame')
  wired.setEnabled(true)
  assert.equal(wired.getRequest(), null, 'and none until an offset has actually been applied')
  assert.equal(wired.apply(), true)
  const request = wired.getRequest()
  assert.deepEqual(request.frustum, f.cameraFrustum)
  assert.equal(request.xOffset, f.cameraFrustum.xOffset)
  assert.deepEqual(request.pixel, wired.getDiagnostics().pixel)

  const drawingFrustum = f.cameraFrustum.clone()
  drawingFrustum.near = 1113.4585898213
  f.state.updateFrustum(drawingFrustum)
  const drawn = drawnPixels(drawingFrustum)
  assert.ok(Math.abs(drawn.x - request.pixel.x) < 1e-6)
  assert.ok(Math.abs(drawn.y - request.pixel.y) < 1e-6)

  wired.setEnabled(false)
  assert.equal(wired.getRequest(), null)
  assert.equal(drawingFrustum.xOffset, 0, 'disabling hands the drawing frustum back too')
  assert.equal(wired.getDiagnostics().bridge.attached, false)
})

// Halton(2,3) is the standard low-discrepancy pair for temporal anti-aliasing:
// consecutive samples cover the pixel in a rotating, non-repeating pattern.
test('Halton bases 2 and 3 produce the canonical low-discrepancy sequence', () => {
  assert.equal(halton(1, 2), 0.5)
  assert.equal(halton(2, 2), 0.25)
  assert.equal(halton(3, 2), 0.75)
  assert.equal(halton(4, 2), 0.125)
  assert.equal(halton(1, 3), 1 / 3)
  assert.equal(halton(2, 3), 2 / 3)
  assert.equal(halton(3, 3), 1 / 9)
  // Index 0 has no digits, and invalid indices must not produce NaN.
  assert.equal(halton(0, 2), 0)
  assert.equal(halton(-3, 2), 0)
  assert.equal(halton(2, 1), 0)
})

test('jitter samples stay inside half a pixel and repeat after one cycle', () => {
  assert.equal(DEFAULT_JITTER_SAMPLES, 8)
  // Frame 0 is the first Halton(2,3) pair: x lands on the pixel centre, y does not.
  // That is harmless because the first frame has no history and resolves to pure current.
  assert.deepEqual(jitterSample(0), { x: 0, y: 1 / 3 - 0.5 })
  assert.deepEqual(jitterSample(1), { x: -0.25, y: 2 / 3 - 0.5 })
  assert.deepEqual(jitterSample(8, 8), jitterSample(0, 8))
  assert.deepEqual(jitterSample(9, 8), jitterSample(1, 8))
  for (let i = 0; i < 32; i++) {
    const sample = jitterSample(i)
    assert.ok(Math.abs(sample.x) <= 0.5 && Math.abs(sample.y) <= 0.5, `sample ${i} inside half a pixel`)
  }
  // A non-integer or zero cycle length falls back to the default instead of dividing by zero.
  assert.deepEqual(jitterSample(3, 0), jitterSample(3))
  assert.deepEqual(jitterSample(3, 7.5), jitterSample(3))
})

// Cesium's PerspectiveFrustum applies xOffset/yOffset by shifting left/right/top/bottom
// together (a translation of the near plane, in metres). The resulting normalized-device
// shift is exactly -offset / halfExtent, so one pixel of jitter must map to 2/size NDC.
test('pixel jitter converts to near-plane metre offsets through the frustum half-extents', () => {
  const frustum = { fovy: Math.PI / 3, aspectRatio: 16 / 9, near: 1 }
  const resolution = { width: 1920, height: 1080 }
  const offsets = nearPlaneOffsets(frustum, { x: 1, y: 0 }, resolution)
  const top = Math.tan(frustum.fovy * 0.5)
  const right = frustum.aspectRatio * top
  assert.ok(Math.abs(offsets.xOffset - -(2 / 1920) * right) < 1e-12)
  assert.equal(offsets.yOffset, 0)

  const vertical = nearPlaneOffsets(frustum, { x: 0, y: 1 }, resolution)
  assert.equal(vertical.xOffset, 0)
  assert.ok(Math.abs(vertical.yOffset - -(2 / 1080) * top) < 1e-12)

  // A half-pixel jitter in the other direction flips the sign and halves the magnitude.
  const flipped = nearPlaneOffsets(frustum, { x: -0.5, y: 0 }, resolution)
  assert.ok(Math.abs(flipped.xOffset + offsets.xOffset * 0.5) < 1e-12)

  const zero = nearPlaneOffsets(frustum, { x: 0, y: 0 }, resolution)
  assert.deepEqual(zero, { xOffset: 0, yOffset: 0 })
})

test('near-plane offsets are rejected when the frustum or resolution is unusable', () => {
  const resolution = { width: 1920, height: 1080 }
  assert.equal(nearPlaneOffsets({ fovy: 0, aspectRatio: 1, near: 1 }, { x: 1, y: 0 }, resolution), null)
  assert.equal(nearPlaneOffsets({ fovy: 1, aspectRatio: 0, near: 1 }, { x: 1, y: 0 }, resolution), null)
  assert.equal(nearPlaneOffsets({ fovy: 1, aspectRatio: 1, near: -1 }, { x: 1, y: 0 }, resolution), null)
  assert.equal(nearPlaneOffsets({ fovy: 1, aspectRatio: 1, near: 1 }, { x: 1, y: 0 }, { width: 0, height: 1080 }), null)
  assert.equal(nearPlaneOffsets({ fovy: 1, aspectRatio: 1, near: 1 }, { x: 1, y: 0 }, null), null)
})

test('temporal anti-aliasing owns coverage exactly like the other post-process modes', () => {
  assert.deepEqual(resolveMsaaPolicy({ antialiasing: 'taa', msaaSamples: 4 }),
    { requested: 4, effective: 1, combined: false, reason: 'Temporal anti-aliasing owns coverage; MSAA request reduced to 1' })
  assert.deepEqual(resolveMsaaPolicy({ antialiasing: 'taa', msaaSamples: 1 }),
    { requested: 1, effective: 1, combined: false, reason: 'Temporal anti-aliasing owns coverage' })
  // Temporal AA and a spatial post-process stage both consume the same coverage budget,
  // so an explicit combination request must not silently restore multisampling.
  assert.equal(resolveMsaaPolicy({ antialiasing: 'taa', msaaSamples: 4, msaaCombine: true }).effective, 4)
  assert.equal(normalizeAntiAliasing({ antialiasing: 'taa' }).antialiasing, 'taa')
  assert.equal(normalizeAntiAliasing({ antialiasing: 'TSR' }).antialiasing, 'smaa')
  assert.deepEqual(['fxaa', 'smaa', 'taa'].map(isPostProcessAntiAliasing), [true, true, true])
  assert.deepEqual(['off', 'msaa', undefined].map(isPostProcessAntiAliasing), [false, false, false])
})
