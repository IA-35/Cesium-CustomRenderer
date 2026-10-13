import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import MaterialChannels143 from '../../src/channels/MaterialChannels143.js'
const C = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')

test('material producer invalidates pyramid each update and releases it on disable without changing request', () => {
  const scene = { context: {}, requestRender() {}, isDestroyed: () => false }
  const owner = new MaterialChannels143(C, scene)
  const calls = []
  owner.depthPyramid = { invalidate() { calls.push('invalidate') }, release() { calls.push('release') },
    destroy() { calls.push('destroy') }, getDiagnostics() { return { valid: false } } }
  owner.setDepthPyramidEnabled(true)
  owner._update({ passes: { render: false } })
  assert.ok(calls.includes('invalidate'))
  owner.setEnabled(false)
  assert.ok(calls.includes('release'))
  assert.equal(owner.depthPyramidEnabled, true)
  owner.setDepthPyramidEnabled(false)
  assert.equal(owner.getDepthPyramidDiagnostics().enabled, false)
  owner.destroy(); owner.destroy()
  assert.equal(calls.filter(c => c === 'destroy').length, 1)
})

test('material Hi-Z includes transparency only while reflection is actually enabled', () => {
  const scene = { context: { uniformState: { viewport: new C.BoundingRectangle(0, 0, 8, 8), pass: C.Pass.COMPUTE,
    updateCamera() {}, updateFrustum() {}, updatePass() {} } },
    camera: { frustum: new C.PerspectiveFrustum() }, frameState: { frameNumber: 1 },
    drawingBufferWidth: 8, drawingBufferHeight: 8,
    _view: { frustumCommandsList: [{ near: 1, far: 10, indices: {}, commands: {} }] },
    requestRender() {}, isDestroyed: () => false }
  const owner = new MaterialChannels143(C, scene), calls = []
  owner._scopeReason = () => null
  owner.depthPyramidEnabled = true
  const limits = []
  owner.depthPyramid = { invalidate() {}, setMaxLevel(value) { limits.push(value) }, update(...args) { calls.push(args) }, release() {}, destroy() {} }
  owner.target = { width: 8, height: 8, eyeDepth: {}, transparency: {}, destroy() {},
    passState: { viewport: new C.BoundingRectangle(0, 0, 8, 8) }, clearAll: { execute() {} }, clearDepth: { execute() {} } }
  owner._render()
  assert.deepEqual(calls[0], [owner.target.eyeDepth, 1, null])
  assert.equal(limits[0], undefined, 'explicit Hi-Z consumers retain the complete pyramid')
  owner.setDepthPyramidEnabled(true, 0)
  owner.reflectionEnabled = true
  owner._render()
  assert.deepEqual(calls[1], [owner.target.eyeDepth, 1, owner.target.transparency])
  assert.equal(limits[1], 5, 'reflection requires more than the AO base level')
  owner.reflectionEnabled = false
  owner._render()
  assert.deepEqual(calls[2], [owner.target.eyeDepth, 1, null])
  assert.equal(limits[2], 0)
  owner.destroy()
})
