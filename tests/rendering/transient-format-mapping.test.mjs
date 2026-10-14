import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveTransientPixelDatatype143, resolveTransientPixelFormat143 } from '../../src/rhi/WebGLDevice143.js'

test('transient allocator preserves numeric Cesium float datatype enums', () => {
  const C = { PixelDatatype: { FLOAT: 5126, HALF_FLOAT: 5131, UNSIGNED_BYTE: 5121 } }
  assert.equal(resolveTransientPixelDatatype143(C, '5126'), 5126)
  assert.equal(resolveTransientPixelDatatype143(C, '5131'), 5131)
  assert.equal(resolveTransientPixelDatatype143(C, '5121'), 5121)
})

test('transient allocator preserves numeric Cesium pixel format enums', () => {
  const C = { PixelFormat: { RED: 6403, RGBA: 6408 } }
  assert.equal(resolveTransientPixelFormat143(C, '6403'), 6403)
  assert.equal(resolveTransientPixelFormat143(C, '6408'), 6408)
})

test('transient allocator maps R32F and RGBA16F semantic descriptors', () => {
  const C = { PixelFormat: { RED: 6403, RGBA: 6408 }, PixelDatatype: { FLOAT: 5126, HALF_FLOAT: 5131, UNSIGNED_BYTE: 5121 } }
  assert.equal(resolveTransientPixelFormat143(C, 'r32f'), 6403)
  assert.equal(resolveTransientPixelDatatype143(C, 'r32f'), 5126)
  assert.equal(resolveTransientPixelFormat143(C, 'rgba16f'), 6408)
  assert.equal(resolveTransientPixelDatatype143(C, 'rgba16f'), 5131)
})
