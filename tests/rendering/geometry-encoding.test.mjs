import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import ScreenSpaceGeometry143 from '../../src/channels/ScreenSpaceGeometry143.js'

const C = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')
function fixture(extra = {}) {
  const scene = { context: { webgl2: true, depthTexture: true, floatingPointTexture: true,
    colorBufferFloat: true, halfFloatingPointTexture: true, colorBufferHalfFloat: true, ...extra },
    mode: C.SceneMode.SCENE3D, camera: { frustum: new C.PerspectiveFrustum() },
    frameState: { frameNumber: 1 }, _view: { frustumCommandsList: [{}] },
    drawingBufferWidth: 1920, drawingBufferHeight: 1080,
    postProcessStages: new C.PostProcessStageCollection(), requestRender() {}, isDestroyed: () => false }
  return { scene, channel: new ScreenSpaceGeometry143(C, scene) }
}

test('geometry prefers half float with split depth rather than losing metre precision in one half', () => {
  const { scene, channel } = fixture()
  assert.equal(channel.geometryStage.pixelDatatype, C.PixelDatatype.HALF_FLOAT)
  assert.equal(channel.getDiagnostics().encoding, 'oct-normal-depth-pair-v1')
  assert.equal(channel.getDiagnostics().estimatedBytes, 1920 * 1080 * 12)
  assert.match(channel.geometryStage.fragmentShader, /packHalf2x16/)
  assert.match(channel.outputStage.fragmentShader, /decodeGeometry/)
  channel.destroy(); scene.postProcessStages.destroy()
})

test('float32 fallback retains the verified legacy RGB normal/metre depth contract', () => {
  const { scene, channel } = fixture({ colorBufferHalfFloat: false })
  assert.equal(channel.geometryStage.pixelDatatype, C.PixelDatatype.FLOAT)
  assert.equal(channel.getDiagnostics().encoding, 'rgb-normal-metres-v0')
  channel.destroy(); scene.postProcessStages.destroy()
})

test('half-float-only hardware can use compressed geometry without requesting float32 attachments', () => {
  const { scene, channel } = fixture({ floatingPointTexture: false, colorBufferFloat: false })
  assert.equal(channel.supported, true)
  assert.equal(channel.geometryStage.pixelDatatype, C.PixelDatatype.HALF_FLOAT)
  channel.destroy(); scene.postProcessStages.destroy()
})

test('orthographic cameras are rejected instead of using perspective logarithmic reconstruction', () => {
  const { scene, channel } = fixture()
  channel.setEnabled(true)
  scene.camera.frustum = new C.OrthographicFrustum()
  assert.equal(channel.getDiagnostics().valid, false)
  assert.match(channel.getDiagnostics().reason, /perspective/i)
  channel.destroy(); scene.postProcessStages.destroy()
})

test('consumer texture never exposes disabled, unrendered, previous-frame or resized data', () => {
  const { scene, channel } = fixture()
  assert.equal(channel.getTexture(), null)
  channel.setEnabled(true)
  assert.equal(channel.getTexture(), null)
  // Emulate a stage that completed in frame 1; real execution is checked by GPU fixture.
  const texture = { width: 1920, height: 1080, isDestroyed: () => false }
  Object.defineProperty(channel.geometryStage, 'outputTexture', { get: () => texture })
  channel.geometryStage._ready = true
  channel.outputFrame = 1
  assert.equal(channel.getTexture(), texture)
  scene.frameState.frameNumber = 2
  assert.equal(channel.getTexture(), null)
  channel.outputFrame = 2
  scene.drawingBufferWidth = 960
  assert.equal(channel.getTexture(), null)
  scene.drawingBufferWidth = 1920
  channel.setEnabled(false)
  assert.equal(channel.getTexture(), null)
  channel.destroy(); scene.postProcessStages.destroy()
})
