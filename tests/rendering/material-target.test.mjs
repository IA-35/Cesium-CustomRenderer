import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import MaterialTarget143, { materialTargetSupport } from '../../src/channels/MaterialTarget143.js'

function fixture({ failAt = 0, incompleteAt = 0, statusThrowsAt = 0 } = {}) {
  const resources = [], calls = [], destroyed = []
  let allocations = 0, statusQueries = 0
  const error = new Error('allocation failed')
  const originalRead = {}, originalDraw = {}
  let read = originalRead, draw = originalDraw
  const gl = {
    MAX_DRAW_BUFFERS: 1, MAX_COLOR_ATTACHMENTS: 2, READ_FRAMEBUFFER_BINDING: 3,
    DRAW_FRAMEBUFFER_BINDING: 4, READ_FRAMEBUFFER: 5, DRAW_FRAMEBUFFER: 6,
    FRAMEBUFFER: 7, FRAMEBUFFER_COMPLETE: 8,
    getParameter(parameter) {
      return parameter === 3 ? read : parameter === 4 ? draw : 4
    },
    bindFramebuffer(target, value) {
      if (target === 5 || target === 7) read = value
      if (target === 6 || target === 7) draw = value
    }
  }
  const context = { _gl: gl, _currentFramebuffer: {}, webgl2: true, depthTexture: true,
    floatingPointTexture: true, halfFloatingPointTexture: true, colorBufferFloat: true,
    colorBufferHalfFloat: true, drawBuffers: true }
  function allocate(resource, options, kind) {
    allocations++
    if (allocations === failAt) throw error
    Object.assign(resource, options, { kind, destroyed: 0 })
    resources.push(resource)
  }
  class Resource {
    destroy() { this.destroyed++; destroyed.push(this) }
    isDestroyed() { return this.destroyed > 0 }
  }
  const C = {
    Texture: class extends Resource { constructor(options) { super(); allocate(this, options, 'texture') } },
    Framebuffer: class extends Resource {
      constructor(options) {
        super()
        // Cesium 1.143 construction and status checks change both raw bindings.
        gl.bindFramebuffer(gl.FRAMEBUFFER, {})
        allocate(this, options, 'framebuffer')
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      }
      get status() {
        statusQueries++
        gl.bindFramebuffer(gl.FRAMEBUFFER, this)
        if (statusQueries === statusThrowsAt) throw error
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        return statusQueries === incompleteAt ? 0 : gl.FRAMEBUFFER_COMPLETE
      }
    },
    Sampler: class { constructor(options) { Object.assign(this, options) } },
    PassState: class { constructor(context) { this.context = context } },
    BoundingRectangle: class { constructor(x, y, width, height) { Object.assign(this, { x, y, width, height }) } },
    ClearCommand: class {
      constructor(options) { Object.assign(this, options) }
      execute(context, passState) { calls.push({ command: this, context, passState }) }
    },
    PixelFormat: { RGBA: 10, RED: 11, DEPTH_STENCIL: 12 },
    PixelDatatype: { UNSIGNED_BYTE: 20, HALF_FLOAT: 21, FLOAT: 22, UNSIGNED_INT_24_8: 23 },
    TextureMinificationFilter: { NEAREST: 30 }, TextureMagnificationFilter: { NEAREST: 31 },
    Color: { TRANSPARENT: { red: 0, green: 0, blue: 0, alpha: 0 } }
  }
  return { C, context, resources, error, calls, destroyed, get allocations() { return allocations },
    checkBindings() {
      assert.equal(read, originalRead)
      assert.equal(draw, originalDraw)
    } }
}

test('material target uses ordered RGBA8, RGBA16F, R32F, R8 and shared depth/stencil attachments', () => {
  const f = fixture(), { C, context } = f
  const cached = context._currentFramebuffer
  const target = new MaterialTarget143(C, context, 32, 16)
  assert.deepEqual(target.framebuffer.colorTextures, [target.normalRoughMetal, target.emissiveFlags, target.eyeDepth, target.transparency])
  assert.equal(target.framebuffer.depthStencilTexture, target.depthStencil)
  assert.equal(target.framebuffer.destroyAttachments, false)
  assert.deepEqual(target.transparencyFramebuffer.colorTextures, [target.transparency])
  assert.equal(target.transparencyFramebuffer.depthStencilTexture, target.depthStencil)
  assert.equal(target.transparencyFramebuffer.destroyAttachments, false)
  assert.deepEqual(f.resources.filter(r => r.kind === 'texture').map(r => [r.pixelFormat, r.pixelDatatype]),
    [[10, 20], [10, 21], [11, 22], [11, 20], [12, 23]])
  assert.equal(target.width, 32)
  assert.equal(target.height, 16)
  assert.equal(target.bytes, 21 * 32 * 16)
  assert.deepEqual({ ...target.passState.viewport }, { x: 0, y: 0, width: 32, height: 16 })
  assert.equal(target.passState.framebuffer, target.framebuffer)
  assert.deepEqual({ ...target.transparencyPassState.viewport }, { x: 0, y: 0, width: 32, height: 16 })
  assert.equal(target.transparencyPassState.framebuffer, target.transparencyFramebuffer)
  assert.ok(f.resources.filter(r => r.kind === 'texture').every(r => r.sampler.minificationFilter === 30 && r.sampler.magnificationFilter === 31))
  assert.equal(context._currentFramebuffer, cached)
  f.checkBindings()
})

test('color clear resets all channels; depth clear preserves color across frustum bins', () => {
  const { C, context } = fixture()
  const target = new MaterialTarget143(C, context, 8, 4)
  assert.equal(target.clearAll.color, C.Color.TRANSPARENT)
  assert.equal(target.clearAll.depth, 1)
  assert.equal(target.clearAll.stencil, 0)
  assert.equal(target.clearDepth.color, undefined)
  assert.equal(target.clearDepth.depth, 1)
  assert.equal(target.clearDepth.stencil, 0)
  assert.equal(target.clearAll.framebuffer, target.framebuffer)
  assert.equal(target.clearDepth.framebuffer, target.framebuffer)
  assert.equal(target.clearAll.framebuffer.colorTextures[3], target.transparency)
})

test('capability checks reject unsupported contexts before allocating resources', () => {
  assert.equal(materialTargetSupport(undefined).supported, false)
  for (const capability of ['webgl2', 'depthTexture', 'floatingPointTexture', 'halfFloatingPointTexture', 'colorBufferFloat', 'colorBufferHalfFloat', 'drawBuffers']) {
    const f = fixture()
    f.context[capability] = false
    const result = materialTargetSupport(f.context)
    assert.equal(result.supported, false, capability)
    assert.match(result.reason, new RegExp(capability))
    assert.throws(() => new MaterialTarget143(f.C, f.context, 8, 4))
    assert.equal(f.allocations, 0)
  }
  for (const limit of [1, 2]) {
    const f = fixture(), get = f.context._gl.getParameter
    f.context._gl.getParameter = p => p === limit ? 3 : get(p)
    assert.equal(materialTargetSupport(f.context).supported, false)
    assert.match(materialTargetSupport(f.context).reason, />= 4/)
    assert.throws(() => new MaterialTarget143(f.C, f.context, 8, 4))
    assert.equal(f.allocations, 0)
  }
  assert.deepEqual(materialTargetSupport(fixture().context), { supported: true, reason: null })
})

test('failure at each texture or framebuffer allocation releases completed resources and preserves the exception', () => {
  for (let failAt = 1; failAt <= 7; failAt++) {
    const f = fixture({ failAt })
    assert.throws(() => new MaterialTarget143(f.C, f.context, 8, 4), error => error === f.error)
    assert.equal(f.resources.length, failAt - 1)
    assert.ok(f.resources.every(r => r.destroyed === 1))
    f.checkBindings()
  }
})

test('incomplete framebuffer and failed status query release all resources and restore raw bindings', () => {
  for (const options of [{ incompleteAt: 1 }, { statusThrowsAt: 1 }, { incompleteAt: 2 }, { statusThrowsAt: 2 }]) {
    const f = fixture(options)
    assert.throws(() => new MaterialTarget143(f.C, f.context, 8, 4),
      options.statusThrowsAt ? error => error === f.error : /framebuffer.*incomplete/i)
    assert.ok(f.resources.length >= 6)
    assert.ok(f.resources.every(r => r.destroyed === 1))
    f.checkBindings()
  }
})

test('destroy releases both framebuffers before all five attachments, with shared resources destroyed exactly once', () => {
  const f = fixture(), target = new MaterialTarget143(f.C, f.context, 8, 4)
  target.destroy()
  target.destroy()
  assert.ok(f.resources.every(r => r.destroyed === 1))
  assert.equal(f.resources.length, 7)
  assert.deepEqual(f.destroyed.map(r => r.kind), ['framebuffer', 'framebuffer', 'texture', 'texture', 'texture', 'texture', 'texture'])
})

test('shipped Cesium 1.143 maps target formats to sized floating attachments and packed 4-byte depth/stencil', () => {
  const C = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')
  assert.equal(C.VERSION, '1.143.0')
  assert.equal(C.PixelFormat.toInternalFormat(C.PixelFormat.RED, C.PixelDatatype.FLOAT, { webgl2: true }), 0x822e)
  assert.equal(C.PixelFormat.toInternalFormat(C.PixelFormat.RGBA, C.PixelDatatype.HALF_FLOAT, { webgl2: true }), 0x881a)
  assert.equal(C.PixelFormat.textureSizeInBytes(C.PixelFormat.DEPTH_STENCIL, C.PixelDatatype.UNSIGNED_INT_24_8, 1, 1), 4)
  assert.equal(C.PixelFormat.textureSizeInBytes(C.PixelFormat.RED, C.PixelDatatype.UNSIGNED_BYTE, 1, 1), 1)
})

test('reflection target adds only two RGBA16F attachments and requires six MRT slots', () => {
  const f = fixture(), gl = f.context._gl, get = gl.getParameter
  assert.equal(materialTargetSupport(f.context).supported, true)
  assert.equal(materialTargetSupport(f.context, true).supported, false)
  assert.match(materialTargetSupport(f.context, true).reason, />= 6/)
  assert.throws(() => new MaterialTarget143(f.C, f.context, 8, 4, true), />= 6/)
  assert.equal(f.allocations, 0)
  gl.getParameter = p => p === gl.MAX_DRAW_BUFFERS || p === gl.MAX_COLOR_ATTACHMENTS ? 6 : get(p)
  const target = new MaterialTarget143(f.C, f.context, 8, 4, true)
  assert.equal(target.reflectionEnabled, true)
  assert.equal(target.bytes, 37 * 8 * 4)
  assert.deepEqual(target.framebuffer.colorTextures.slice(4), [target.reflectionSpecular, target.reflectionResponse])
  for (const texture of [target.reflectionSpecular, target.reflectionResponse]) {
    assert.equal(texture.pixelFormat, f.C.PixelFormat.RGBA)
    assert.equal(texture.pixelDatatype, f.C.PixelDatatype.HALF_FLOAT)
  }
  assert.deepEqual(target.transparencyFramebuffer.colorTextures, [target.transparency])
  target.destroy(); target.destroy()
  assert.equal(f.resources.length, 9)
  assert.ok(f.resources.every(r => r.destroyed === 1))
  assert.deepEqual(f.destroyed.slice(0, 2).map(r => r.kind), ['framebuffer', 'framebuffer'])
  f.checkBindings()
})

test('reflection allocation failures release every completed optional and base resource', () => {
  for (let failAt = 1; failAt <= 9; failAt++) {
    const f = fixture({ failAt }), gl = f.context._gl, get = gl.getParameter
    gl.getParameter = p => p === gl.MAX_DRAW_BUFFERS || p === gl.MAX_COLOR_ATTACHMENTS ? 6 : get(p)
    assert.throws(() => new MaterialTarget143(f.C, f.context, 8, 4, true), error => error === f.error)
    assert.equal(f.resources.length, failAt - 1)
    assert.ok(f.resources.every(r => r.destroyed === 1))
    f.checkBindings()
  }
})

test('native opaque color is a seventh RGBA16F attachment with 45-byte accounting', () => {
  const f = fixture(), gl = f.context._gl, get = gl.getParameter
  gl.getParameter = p => p === gl.MAX_DRAW_BUFFERS || p === gl.MAX_COLOR_ATTACHMENTS ? 6 : get(p)
  assert.equal(materialTargetSupport(f.context, true).supported, true)
  assert.match(materialTargetSupport(f.context, true, true).reason, />= 7/)
  assert.throws(() => new MaterialTarget143(f.C, f.context, 8, 4, true, true), />= 7/)
  assert.equal(f.allocations, 0)
  gl.getParameter = p => p === gl.MAX_DRAW_BUFFERS || p === gl.MAX_COLOR_ATTACHMENTS ? 7 : get(p)
  const target = new MaterialTarget143(f.C, f.context, 8, 4, true, true)
  assert.equal(target.framebuffer.colorTextures.length, 7)
  assert.equal(target.framebuffer.colorTextures[6], target.opaqueColor)
  assert.equal(target.opaqueColor.pixelFormat, f.C.PixelFormat.RGBA)
  assert.equal(target.opaqueColor.pixelDatatype, f.C.PixelDatatype.HALF_FLOAT)
  assert.equal(target.bytes, 45 * 8 * 4)
  assert.deepEqual(target.transparencyFramebuffer.colorTextures, [target.transparency])
  target.destroy(); target.destroy()
  assert.ok(f.resources.every(r => r.destroyed === 1))
  f.checkBindings()
})

test('each seven-attachment allocation failure releases all completed owned resources', () => {
  for (let failAt = 1; failAt <= 10; failAt++) {
    const f = fixture({ failAt }), gl = f.context._gl, get = gl.getParameter
    gl.getParameter = p => p === gl.MAX_DRAW_BUFFERS || p === gl.MAX_COLOR_ATTACHMENTS ? 7 : get(p)
    assert.throws(() => new MaterialTarget143(f.C, f.context, 8, 4, true, true), error => error === f.error)
    assert.equal(f.resources.length, failAt - 1)
    assert.ok(f.resources.every(r => r.destroyed === 1))
    f.checkBindings()
  }
})

test('albedo appends one RGBA16F attachment at the active 5, 7 or 8 slot layout', () => {
  for (const [reflection, opaqueColor, limit, attachment, bytes] of [
    [false, false, 5, 4, 29],
    [true, false, 7, 6, 45],
    [true, true, 8, 7, 53]
  ]) {
    const f = fixture(), gl = f.context._gl, get = gl.getParameter
    gl.getParameter = p => p === gl.MAX_DRAW_BUFFERS || p === gl.MAX_COLOR_ATTACHMENTS ? limit : get(p)
    const target = new MaterialTarget143(f.C, f.context, 8, 4, reflection, opaqueColor, true)
    assert.equal(target.albedoEnabled, true)
    assert.equal(target.colorAttachmentCount, limit)
    assert.equal(target.albedoAttachment, attachment)
    assert.equal(target.framebuffer.colorTextures.length, limit)
    assert.equal(target.framebuffer.colorTextures[attachment], target.albedoOcclusion)
    assert.equal(target.albedoOcclusion.pixelFormat, f.C.PixelFormat.RGBA)
    assert.equal(target.albedoOcclusion.pixelDatatype, f.C.PixelDatatype.HALF_FLOAT)
    assert.equal(target.bytes, bytes * 8 * 4)
    target.destroy(); target.destroy()
    assert.ok(f.resources.every(resource => resource.destroyed === 1))
    f.checkBindings()
  }
})

test('albedo capability limits match the complete requested layout without changing old layouts', () => {
  for (const [reflection, opaqueColor, albedo, limit, required] of [
    [false, false, true, 4, 5],
    [true, false, true, 6, 7],
    [true, true, true, 7, 8]
  ]) {
    const f = fixture(), gl = f.context._gl, get = gl.getParameter
    gl.getParameter = p => p === gl.MAX_DRAW_BUFFERS || p === gl.MAX_COLOR_ATTACHMENTS ? limit : get(p)
    const support = materialTargetSupport(f.context, reflection, opaqueColor, albedo)
    assert.equal(support.supported, false)
    assert.match(support.reason, new RegExp(`>= ${required}`))
    assert.throws(() => new MaterialTarget143(f.C, f.context, 8, 4, reflection, opaqueColor, albedo), new RegExp(`>= ${required}`))
    assert.equal(f.allocations, 0)
  }
  assert.deepEqual(materialTargetSupport(fixture().context), { supported: true, reason: null })
})

test('each eight-attachment allocation failure releases every completed resource exactly once', () => {
  for (let failAt = 1; failAt <= 11; failAt++) {
    const f = fixture({ failAt }), gl = f.context._gl, get = gl.getParameter
    gl.getParameter = p => p === gl.MAX_DRAW_BUFFERS || p === gl.MAX_COLOR_ATTACHMENTS ? 8 : get(p)
    assert.throws(() => new MaterialTarget143(f.C, f.context, 8, 4, true, true, true), error => error === f.error)
    assert.equal(f.resources.length, failAt - 1)
    assert.ok(f.resources.every(resource => resource.destroyed === 1))
    f.checkBindings()
  }
})
