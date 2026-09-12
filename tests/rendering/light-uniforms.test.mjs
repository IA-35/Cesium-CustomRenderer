import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import LightUniforms143, { LIGHT_CAPACITY, lightBlockGLSL } from '../../src/buffers/LightUniforms143.js'
const C = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')

function fixture() {
  let bound = null, storage, removed = 0
  const uploads = []
  const gl = { UNIFORM_BUFFER: 1, UNIFORM_BUFFER_BINDING: 2, MAX_UNIFORM_BLOCK_SIZE: 3, DYNAMIC_DRAW: 4,
    getParameter: key => key === 3 ? 65536 : bound,
    createBuffer: () => ({}), deleteBuffer() { removed++ },
    bindBuffer(target, value) { bound = value },
    bufferData(target, size) { storage = new Uint8Array(size) },
    bufferSubData(target, offset, data) { storage.set(data, offset); uploads.push([offset, data.length]) } }
  return { context: { _gl: gl }, uploads, get storage() { return storage }, get removed() { return removed } }
}

const point = (overrides = {}) => ({ type: 'point', position: [1, 2, 3], color: [.25, .5, 1], intensity: 4, radius: 10, ...overrides })
const spot = (overrides = {}) => point({ type: 'spot', direction: [2, 0, 0], innerCos: .9, outerCos: .5, ...overrides })

test('light block uses a std140 struct array and exact 8208-byte capacity', () => {
  const f = fixture(), lights = new LightUniforms143(C, f.context)
  assert.equal(LIGHT_CAPACITY, 128)
  assert.equal(lights.data.length, 2052)
  assert.equal(lights.data.byteLength, 8208)
  assert.equal(lights.getDiagnostics().bytes, 8208)
  assert.match(lightBlockGLSL, /struct CampusLight\s*\{\s*vec4 positionRadius;\s*vec4 colorIntensity;\s*vec4 directionOuter;\s*vec4 parameters;\s*\};/)
  assert.match(lightBlockGLSL, /layout\(std140\) uniform CampusLights\s*\{\s*vec4 campusLightHeader;\s*CampusLight campusLights\[128\];\s*\};/)
  assert.doesNotMatch(lightBlockGLSL, /vec4\s+\w+\[/)
  lights.destroy()
})

test('point positions transform in double precision before packing into float eye coordinates', () => {
  const f = fixture(), owner = new LightUniforms143(C, f.context)
  const view = C.Matrix4.fromTranslation(new C.Cartesian3(-1e12, 1e12, -1e12))
  const input = [point({ position: [1e12 + 2, -1e12 + 3, 1e12 - 4] })]
  const before = JSON.stringify(input)
  assert.deepEqual(owner.update(input, 0, view), { count: 1, nextOffset: 1, uploadedBytes: 8208 })
  assert.deepEqual(Array.from(owner.data.slice(0, 20)), [1, 0, 0, 0, 2, 3, -4, 10, .25, .5, 1, 4, 0, 0, -1, -1, 0, 0, 0, 0])
  assert.equal(JSON.stringify(input), before)
  assert.deepEqual(f.storage, new Uint8Array(owner.data.buffer))
  assert.equal(owner.update(input, 0, view).uploadedBytes, 0)
  input[0].intensity = 8
  assert.equal(owner.update(input, 0, view).uploadedBytes, 4)
  assert.deepEqual(f.uploads.at(-1), [44, 4])
  assert.deepEqual(f.storage, new Uint8Array(owner.data.buffer))
  owner.destroy()
})

test('spot directions use only view rotation and normalize, with cone parameters in their defined slots', () => {
  const f = fixture(), owner = new LightUniforms143(C, f.context)
  const view = C.Matrix4.fromRotationTranslation(C.Matrix3.fromRotationZ(Math.PI / 2), new C.Cartesian3(10, 20, 30))
  owner.update([spot()], 0, view)
  assert.deepEqual(Array.from(owner.data.slice(4, 8)), [8, 21, 33, 10])
  const direction = owner.data.slice(12, 16)
  assert.ok(Math.abs(direction[0]) < 1e-6)
  assert.equal(direction[1], 1)
  assert.equal(direction[2], 0)
  assert.equal(direction[3], .5)
  assert.deepEqual(owner.data.slice(16, 20), new Float32Array([1, .9, 0, 0]))
  owner.destroy()
})

test('finite nonzero spot directions normalize safely regardless of their input magnitude', () => {
  const f = fixture(), owner = new LightUniforms143(C, f.context)
  for (const magnitude of [1e200, 1e-200]) {
    owner.update([spot({ direction: [magnitude, 0, 0] })], 0, C.Matrix4.IDENTITY)
    assert.deepEqual(Array.from(owner.data.slice(12, 15)), [1, 0, 0])
  }
  owner.destroy()
})

test('invalid pages fail before changing valid data, GPU mirror or upload statistics', () => {
  const f = fixture(), owner = new LightUniforms143(C, f.context)
  owner.update([point()], 0, C.Matrix4.IDENTITY)
  const before = owner.data.slice(), image = f.storage.slice(), stats = owner.getDiagnostics()
  const invalid = [null, point({ type: 'directional' }), point({ position: [1, NaN, 3] }),
    point({ color: [-1, 1, 1] }), point({ color: [1, 2] }), point({ radius: 0 }), point({ radius: Infinity }),
    point({ intensity: -1 }), point({ intensity: NaN }), spot({ direction: [0, 0, 0] }),
    spot({ direction: [Infinity, 0, 0] }), spot({ innerCos: -.2, outerCos: .3 }), spot({ innerCos: 2 }),
    spot({ outerCos: -2 }), spot({ innerCos: NaN }), point({ color: [1e100, 0, 0] })]
  for (const item of invalid) {
    assert.throws(() => owner.update([point({ intensity: 100 }), item], 0, C.Matrix4.IDENTITY))
    assert.deepEqual(owner.data, before)
    assert.deepEqual(f.storage, image)
    assert.deepEqual(owner.getDiagnostics(), stats)
  }
  for (const offset of [-1, .5, 2, NaN]) assert.throws(() => owner.update([point()], offset, C.Matrix4.IDENTITY))
  assert.throws(() => owner.update(null, 0, C.Matrix4.IDENTITY))
  const invalidMatrix = C.Matrix4.clone(C.Matrix4.IDENTITY); invalidMatrix[5] = NaN
  assert.throws(() => owner.update([point()], 0, invalidMatrix))
  assert.deepEqual(owner.data, before)
  assert.deepEqual(f.storage, image)
  assert.deepEqual(owner.getDiagnostics(), stats)
  owner.destroy()
})

test('5000 lights use 40 bounded pages and the final short page clears stale slots', () => {
  const f = fixture(), owner = new LightUniforms143(C, f.context)
  const input = Array.from({ length: 5000 }, (_, id) => point({ id, position: [id, 0, -10] }))
  let offset = 0, pages = 0, total = 0
  while (offset < input.length) {
    const result = owner.update(input, offset, C.Matrix4.IDENTITY)
    assert.equal(owner.data[4], offset)
    assert.ok(result.count > 0 && result.count <= 128)
    assert.equal(result.nextOffset, offset + result.count)
    assert.equal(owner.data[0], result.count)
    assert.deepEqual(f.storage, new Uint8Array(owner.data.buffer))
    total += result.count; offset = result.nextOffset; pages++
  }
  assert.equal(total, 5000)
  assert.equal(pages, 40)
  assert.equal(owner.data[0], 8)
  assert.ok(owner.data.slice(4 + 8 * 16).every(value => value === 0))
  assert.deepEqual(owner.update(input, 5000, C.Matrix4.IDENTITY), { count: 0, nextOffset: 5000, uploadedBytes: 512 })
  assert.ok(owner.data.every(value => value === 0))
  owner.destroy(); owner.destroy()
  assert.equal(f.removed, 1)
  assert.equal(owner.isDestroyed(), true)
  assert.throws(() => owner.update([], 0, C.Matrix4.IDENTITY), /destroyed/i)
})

test('validation is limited to the requested page and does not reject later pages prematurely', () => {
  const f = fixture(), owner = new LightUniforms143(C, f.context)
  const input = Array.from({ length: 128 }, () => point()).concat(null)
  assert.equal(owner.update(input, 0, C.Matrix4.IDENTITY).nextOffset, 128)
  assert.throws(() => owner.update(input, 128, C.Matrix4.IDENTITY))
  owner.destroy()
})

test('radius underflow is rejected transactionally while the smallest positive float radius is accepted', () => {
  const f = fixture(), owner = new LightUniforms143(C, f.context)
  owner.update([point()], 0, C.Matrix4.IDENTITY)
  const before = owner.data.slice(), image = f.storage.slice(), stats = owner.getDiagnostics()
  assert.throws(() => owner.update([point({ intensity: 100 }), point({ radius: 1e-50 })], 0, C.Matrix4.IDENTITY), /radius/i)
  assert.deepEqual(owner.data, before)
  assert.deepEqual(f.storage, image)
  assert.deepEqual(owner.getDiagnostics(), stats)
  const minimumRadius = 2 ** -149
  assert.ok(owner.update([point({ radius: minimumRadius })], 0, C.Matrix4.IDENTITY).uploadedBytes > 0)
  assert.equal(owner.data[7], minimumRadius)
  assert.deepEqual(f.storage, new Uint8Array(owner.data.buffer))
  owner.destroy()
})
