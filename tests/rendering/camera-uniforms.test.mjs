import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { acquireCameraUniforms, cameraBlockGLSL } from '../../src/buffers/CameraUniforms143.js'

const C = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')

function fixture() {
  let binding = null
  const buffers = [], uploads = [], indexed = new Map()
  const gl = {
    UNIFORM_BUFFER: 0x8a11, UNIFORM_BUFFER_BINDING: 0x8a28, DYNAMIC_DRAW: 0x88e8,
    MAX_UNIFORM_BUFFER_BINDINGS: 0x8a2f, MAX_UNIFORM_BLOCK_SIZE: 0x8a30,
    getParameter(name) {
      if (name === this.UNIFORM_BUFFER_BINDING) return binding
      if (name === this.MAX_UNIFORM_BLOCK_SIZE) return 65536
      if (name === this.MAX_UNIFORM_BUFFER_BINDINGS) return 24
      return 0
    },
    createBuffer() { const buffer = { deleted: 0 }; buffers.push(buffer); return buffer },
    bindBuffer(target, buffer) { assert.equal(target, this.UNIFORM_BUFFER); binding = buffer },
    bufferData(target, size) { assert.equal(target, this.UNIFORM_BUFFER); binding.bytes = new Uint8Array(size) },
    bufferSubData(target, offset, data) {
      assert.equal(target, this.UNIFORM_BUFFER)
      const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      binding.bytes.set(bytes, offset)
      uploads.push({ buffer: binding, offset, data: bytes.slice() })
    },
    deleteBuffer(buffer) { buffer.deleted++ },
    getIndexedParameter(target, index) { return indexed.get(index) || null },
    bindBufferBase(target, index, buffer) { indexed.set(index, buffer); binding = buffer },
    isContextLost() { return false }
  }
  const scene = { context: { _gl: gl }, drawingBufferWidth: 800, drawingBufferHeight: 400,
    frameState: { frameNumber: 3 },
    camera: { frustum: new C.PerspectiveFrustum({ fov: Math.PI / 3, aspectRatio: 2, near: .5, far: 1000 }) } }
  return { scene, buffers, uploads }
}

test('camera std140 block declares matrices and vectors in the 160-byte upload order', () => {
  assert.match(cameraBlockGLSL, /layout\s*\(std140\)\s+uniform CampusCamera\s*\{\s*mat4 campusProjection;\s*mat4 campusInverseProjection;\s*vec4 campusViewport;\s*vec4 campusClip;\s*\};/)
})

test('camera uniforms use the main frustum, inverse projection, drawing buffer and clip range', () => {
  const f = fixture(), lease = acquireCameraUniforms(C, f.scene)
  f.scene.context.uniformState = { projection: new C.Matrix4() }
  f.scene._view = { frustumCommandsList: [{ near: 500, far: 900 }] }
  assert.equal(lease.data.length, 40)
  assert.equal(lease.data.byteLength, 160)
  assert.equal(lease.getDiagnostics().bytes, 160)
  assert.equal(lease.update(), 160)
  const projection = f.scene.camera.frustum.projectionMatrix
  const inverse = C.Matrix4.inverse(projection, new C.Matrix4())
  assert.deepEqual(lease.data.slice(0, 16), new Float32Array(C.Matrix4.toArray(projection)))
  assert.deepEqual(lease.data.slice(16, 32), new Float32Array(C.Matrix4.toArray(inverse)))
  assert.deepEqual(Array.from(lease.data.slice(32)), [0, 0, 800, 400, .5, 1000, 0, 0])
  assert.deepEqual(f.buffers[0].bytes, new Uint8Array(lease.data.buffer))
  lease.release()
})

test('same-frame camera changes upload while unchanged data across frames does not', () => {
  const f = fixture(), lease = acquireCameraUniforms(C, f.scene)
  const verifyImage = () => {
    const projection = f.scene.camera.frustum.projectionMatrix
    const inverse = C.Matrix4.inverse(projection, new C.Matrix4())
    const expected = new Float32Array([...C.Matrix4.toArray(projection), ...C.Matrix4.toArray(inverse),
      0, 0, f.scene.drawingBufferWidth, f.scene.drawingBufferHeight, f.scene.camera.frustum.near, f.scene.camera.frustum.far, 0, 0])
    assert.deepEqual(lease.data, expected)
    assert.deepEqual(f.buffers[0].bytes, new Uint8Array(expected.buffer))
  }
  const updateMatrix = () => {
    const uploaded = lease.update()
    assert.ok(uploaded > 0 && uploaded <= 160)
    assert.equal(uploaded % 4, 0)
    assert.equal(f.uploads.at(-1).offset % 4, 0)
    assert.equal(f.uploads.at(-1).data.byteLength, uploaded)
    verifyImage()
  }
  lease.update()
  assert.equal(lease.update(), 0)
  f.scene.frameState.frameNumber++
  assert.equal(lease.update(), 0)
  f.scene.camera.frustum.near = 2
  updateMatrix()
  assert.equal(lease.data[36], 2)
  f.scene.camera.frustum.fov = Math.PI / 4
  updateMatrix()
  f.scene.drawingBufferWidth = 1200
  assert.equal(lease.update(), 4)
  assert.equal(f.uploads.at(-1).offset, 136)
  verifyImage()
  assert.equal(lease.data[34], 1200)
  f.scene.drawingBufferWidth = 1600
  f.scene.drawingBufferHeight = 900
  assert.equal(lease.update(), 8)
  assert.equal(f.uploads.at(-1).offset, 136)
  verifyImage()
  assert.equal(f.uploads.length, 5)
  assert.equal(lease.getDiagnostics().uploadedBytes, f.uploads.reduce((sum, upload) => sum + upload.data.byteLength, 0))
  lease.release()
})

test('independent leases share one scene buffer and only the final release destroys it', () => {
  const f = fixture(), first = acquireCameraUniforms(C, f.scene), second = acquireCameraUniforms(C, f.scene)
  assert.notEqual(first, second)
  assert.equal(first.buffer, second.buffer)
  assert.equal(first.data, second.data)
  assert.equal(first.getDiagnostics().references, 2)
  assert.equal(f.buffers.length, 1)
  first.update()
  assert.equal(second.update(), 0)
  first.release(); first.release()
  assert.equal(first.getDiagnostics().released, true)
  assert.equal(second.getDiagnostics().references, 1)
  assert.equal(second.buffer.isDestroyed(), false)
  assert.throws(() => first.update(), /released/i)
  second.update()
  second.release(); second.release()
  assert.equal(second.buffer.isDestroyed(), true)
  assert.equal(f.buffers[0].deleted, 1)
  const next = acquireCameraUniforms(C, f.scene)
  assert.notEqual(next.buffer, second.buffer)
  assert.equal(next.getDiagnostics().references, 1)
  next.release()
})

test('different scenes retain independent camera buffers', () => {
  const a = fixture(), b = fixture()
  const first = acquireCameraUniforms(C, a.scene), second = acquireCameraUniforms(C, b.scene)
  assert.notEqual(first.buffer, second.buffer)
  first.release()
  assert.equal(second.buffer.isDestroyed(), false)
  second.update()
  second.release()
})
