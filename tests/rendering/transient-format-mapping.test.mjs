import test from 'node:test'
import assert from 'node:assert/strict'
import WebGLDevice143, { resolveTransientPixelDatatype143, resolveTransientPixelFormat143 } from '../../src/rhi/WebGLDevice143.js'

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

// TAA 深度历史要同时保存重建足迹的最近与最远深度，只存最近会把 jitter 覆盖变化
// 误判成遮挡显露。RG32F 是唯一能放下这两个 float 又保持 NEAREST 单 texel 读取的格式；
// 早先 `rg32f` 在两张表里都没有分支，会静默落到 RGBA + UNSIGNED_BYTE。
test('transient allocator maps RG32F to an RG float texture', () => {
  const C = { PixelFormat: { RED: 6403, RG: 33319, RGBA: 6408 }, PixelDatatype: { FLOAT: 5126, HALF_FLOAT: 5131, UNSIGNED_BYTE: 5121 } }
  assert.equal(resolveTransientPixelFormat143(C, 'rg32f'), 33319)
  assert.equal(resolveTransientPixelDatatype143(C, 'rg32f'), 5126)
  assert.equal(resolveTransientPixelFormat143(C, C.PixelFormat.RG), 33319)
})

// 只写格式简写的公开描述契约。
//
// 早先 `createTransientAllocator().acquire` 计算 datatype 时只读
// `pixelDatatype ?? datatype`，漏了 `format`；`{ format: 'rgba16f' }` 于是
// 落到 `UNSIGNED_BYTE`，HDR 资源被静默降级成 8 位。
// 这条用例走真实 allocator，断言最终送进纹理池的是 HALF_FLOAT。
function transientFixture() {
  const created = []
  const C = {
    PixelFormat: { RGBA: 6408, RED: 6403 },
    PixelDatatype: { FLOAT: 5126, HALF_FLOAT: 5131, UNSIGNED_BYTE: 5121 },
    TextureMinificationFilter: { NEAREST: 1 },
    TextureMagnificationFilter: { NEAREST: 1 },
    Sampler: class { constructor(spec) { Object.assign(this, spec) } },
    Texture: class {
      constructor(spec) { Object.assign(this, spec); this.sizeInBytes = (spec.width || 0) * (spec.height || 0) * 8; created.push(this) }
      isDestroyed() { return false }
      destroy() {}
    },
    Framebuffer: class {
      constructor(spec) { Object.assign(this, spec); this.status = 1 }
      isDestroyed() { return false }
      destroy() {}
    },
  }
  const context = { _gl: { FRAMEBUFFER_COMPLETE: 1, getParameter() {}, bindFramebuffer() {}, canvas: { addEventListener() {}, removeEventListener() {} } } }
  return { C, scene: { context }, created }
}

test('a format-only transient descriptor reaches the texture with the matching datatype', () => {
  const { C, scene, created } = transientFixture()
  const device = new WebGLDevice143(C, scene)
  const allocator = device.createTransientAllocator('format-only')
  allocator.resize(64, 64)
  allocator.acquire({ width: 64, height: 64, format: 'rgba16f' })
  assert.equal(created.length, 1)
  assert.equal(created[0].pixelFormat, C.PixelFormat.RGBA)
  assert.equal(created[0].pixelDatatype, C.PixelDatatype.HALF_FLOAT, 'rgba16f must allocate HALF_FLOAT, not UNSIGNED_BYTE')
  device.destroy()
})
