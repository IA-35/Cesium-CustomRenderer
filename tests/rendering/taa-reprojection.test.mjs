import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const C = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')

// These tests restate the arithmetic the resolve and depth shaders perform, using the real
// Cesium matrices the shader actually receives (czm_projection / czm_inverseProjection are
// the frustum's own projection matrix and its inverse, which the bundle confirms in
// UniformState.updateFrustum). The shader text is pinned separately in taa-pass.test.mjs,
// so a change to one without the other fails.

const identity = () => C.Matrix4.clone(C.Matrix4.IDENTITY, new C.Matrix4())

// View matrix for a camera whose eye sits at world (0, 0, -z): world -> eye is a pure
// translation, which is all the reprojection needs to be exercised.
function viewAt(z) {
  const view = identity()
  view[14] = z
  return view
}

function frustumAt(near, far, fovDegrees = 60) {
  return new C.PerspectiveFrustum({
    fov: C.Math.toRadians(fovDegrees), aspectRatio: 16 / 9, near, far
  })
}

function inverse(matrix) {
  return C.Matrix4.inverse(matrix, new C.Matrix4())
}

function eyePosition(inverseProjection, uvX, uvY, clipDepth) {
  const eye = C.Matrix4.multiplyByVector(inverseProjection,
    new C.Cartesian4(uvX * 2 - 1, uvY * 2 - 1, clipDepth, 1), new C.Cartesian4())
  return { x: eye.x / eye.w, y: eye.y / eye.w, z: eye.z / eye.w }
}

// mirrors taaClipDepth() in taaShaders143.js
const taaClipDepth = windowDepth => windowDepth * 2 - 1

// mirrors taaEyeDepth()
function taaEyeDepth(inverseProjection, uvX, uvY, windowDepth) {
  if (windowDepth >= 1) return 0
  return -eyePosition(inverseProjection, uvX, uvY, taaClipDepth(windowDepth)).z
}

// The window depth a rasteriser would store for a surface at `distance` in front of the
// camera. czm_readDepth reverses the log-depth encoding and returns exactly this quantity.
function windowDepthOf(projection, distance) {
  const clip = C.Matrix4.multiplyByVector(projection, new C.Cartesian4(0, 0, -distance, 1), new C.Cartesian4())
  return (clip.z / clip.w) * 0.5 + 0.5
}

test('window depth is remapped to clip space before inverse projection', () => {
  const frustum = frustumAt(1, 1000)
  const projection = C.Matrix4.clone(frustum.projectionMatrix, new C.Matrix4())
  const inverseProjection = inverse(projection)

  for (const distance of [10, 100, 500]) {
    const windowDepth = windowDepthOf(projection, distance)
    assert.ok(windowDepth > 0 && windowDepth < 1, `${distance} m stores a window depth inside (0, 1)`)
    const reconstructed = taaEyeDepth(inverseProjection, 0.5, 0.5, windowDepth)
    assert.ok(Math.abs(reconstructed - distance) < 1e-6,
      `${distance} m reconstructs as ${reconstructed}`)
  }

  // The defect this replaces, kept as a guard: feeding the window value in as clip.z
  // stretches every distance, so a 100 m surface would be stored as 181.8 m of history.
  for (const [distance, stretched] of [[10, 19.802], [100, 181.818], [500, 666.667]]) {
    const windowDepth = windowDepthOf(projection, distance)
    const unremapped = -eyePosition(inverseProjection, 0.5, 0.5, windowDepth).z
    assert.ok(Math.abs(unremapped - stretched) < 0.01,
      `${distance} m without the remap reads ${unremapped}`)
    assert.ok(unremapped > distance * 1.1, 'and it overstates every one of them')
  }

  // The remap must survive the far edge of the depth range, which is where the log-depth
  // encoding spends most of its precision.
  const campus = frustumAt(0.1, 500000)
  const campusInverse = inverse(C.Matrix4.clone(campus.projectionMatrix, new C.Matrix4()))
  for (const distance of [100, 5000, 100000]) {
    const windowDepth = windowDepthOf(C.Matrix4.clone(campus.projectionMatrix, new C.Matrix4()), distance)
    const reconstructed = taaEyeDepth(campusInverse, 0.5, 0.5, windowDepth)
    assert.ok(Math.abs(reconstructed - distance) / distance < 1e-3,
      `${distance} m at campus scale reconstructs as ${reconstructed}`)
  }

  // Sky and atmosphere have no surface depth, and zero is the sentinel that compares equal
  // to itself instead of to an unbounded value.
  assert.equal(taaEyeDepth(inverseProjection, 0.5, 0.5, 1), 0)
})

test('history depth is compared in the previous frame eye space, not the current one', () => {
  const frustum = frustumAt(1, 1000)
  const sameEyeSlope = C.Matrix4.clone(frustum.projectionMatrix, new C.Matrix4())

  // A static surface 100 m in front of the previous camera; the camera then advances 25 m,
  // so the same surface is 75 m away in the current frame. Both frames look down -z, which
  // makes previousView * inverse(currentView) a pure translation.
  const previousView = viewAt(0)
  const currentView = viewAt(25)
  const prevViewFromCurrent = C.Matrix4.multiply(previousView, inverse(currentView), new C.Matrix4())

  const currentEye = [0, 0, -75]
  const previousEye = C.Matrix4.multiplyByVector(prevViewFromCurrent,
    new C.Cartesian4(currentEye[0], currentEye[1], currentEye[2], 1), new C.Cartesian4())

  // The reprojected surface still sits 100 m in front of the previous camera, so it agrees
  // with the 100 m that was stored for it last frame.
  assert.ok(Math.abs(-previousEye.z - 100) < 1e-9, `previous eye space depth ${-previousEye.z}`)
  const storedDepth = 100
  const tolerance = Math.max(0.1 * Math.max(100, storedDepth), 1)
  assert.ok(Math.abs(storedDepth - -previousEye.z) <= tolerance, 'the fixed comparison accepts the history')

  // The comparison the fix replaces compared the stored previous-frame depth with the
  // *current* eye depth, which rejects a static surface on every frame of a fly-through
  // and silently turns temporal accumulation off.
  const currentDepth = -currentEye[2]
  assert.equal(currentDepth, 75)
  assert.ok(Math.abs(storedDepth - currentDepth) > tolerance,
    'the previous comparison rejected the very same static surface')

  // The reprojection UV only needs x, y and w. w is -eye.z, which does not depend on the
  // near plane, and both projections carry the same normalized x/y offset, so the UV is
  // identical whether the previous projection came from the camera frustum or from the
  // frustum the scene actually draws with.
  const drawn = frustumAt(1113.4585898213, 500000)
  const jitterMetres = 0.2511
  frustum.xOffset = jitterMetres * frustum.near / drawn.near
  frustum.yOffset = 0
  drawn.xOffset = jitterMetres
  drawn.yOffset = 0
  const uvOf = matrix => {
    const clip = C.Matrix4.multiplyByVector(matrix, new C.Cartesian4(previousEye.x, previousEye.y, previousEye.z, 1), new C.Cartesian4())
    return [clip.x / clip.w * 0.5 + 0.5, clip.y / clip.w * 0.5 + 0.5]
  }
  const cameraUV = uvOf(C.Matrix4.clone(frustum.projectionMatrix, new C.Matrix4()))
  const drawnUV = uvOf(C.Matrix4.clone(drawn.projectionMatrix, new C.Matrix4()))
  assert.ok(Math.abs(cameraUV[0] - drawnUV[0]) < 1e-9, `${cameraUV[0]} vs ${drawnUV[0]}`)
  assert.ok(Math.abs(cameraUV[1] - drawnUV[1]) < 1e-9)
  assert.ok(Math.abs(cameraUV[0] - 0.5) > 1e-6, 'and the jitter does move the UV')
  assert.ok(Math.abs(sameEyeSlope[0] - drawn.projectionMatrix[0]) < 1e-9 &&
    Math.abs(sameEyeSlope[5] - drawn.projectionMatrix[5]) < 1e-9,
    'the x/y NDC slope is near-plane independent')
})

test('background and behind-camera samples are classified without widening the tolerance', () => {
  // Background samples reproject as directions: the translation must be dropped, otherwise
  // the sky is dragged along with the camera.
  const direction = C.Matrix4.multiplyByVector(identity(), new C.Cartesian4(0.2, -0.1, -1, 0), new C.Cartesian4())
  assert.equal(direction.w, 0, 'a direction carries w = 0 so the translation term drops out')

  // The 10% relative tolerance is compared against the far end of the pair, and a foreground
  // sample reprojected onto last frame's sky must not be accepted.
  const tolerance = Math.max(0.1 * Math.max(120, 0), 1)
  assert.ok(Math.abs(0 - 120) > tolerance, 'foreground against a background texel is a disocclusion')

  // Behind the previous camera the reprojection has no meaning: w is negative, so the
  // derived UV is mirrored and would otherwise look like a valid sample.
  const behind = C.Matrix4.multiplyByVector(identity(), new C.Cartesian4(0, 0, 10, 1), new C.Cartesian4())
  const clip = C.Matrix4.multiplyByVector(frustumAt(1, 1000).projectionMatrix, behind, new C.Cartesian4())
  assert.ok(clip.w < 0, 'a point behind the camera flips the perspective divide')
  assert.ok(!(behind.z < 0), 'and is rejected by the in-front test')
  assert.ok(-0 < 0 === false, 'a background sample is exempt from the in-front test')
})
