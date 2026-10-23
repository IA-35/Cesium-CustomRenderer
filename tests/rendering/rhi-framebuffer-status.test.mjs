import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import WebGLDevice143, { checkFramebufferComplete143 } from '../../src/rhi/WebGLDevice143.js'
import { currentFramebufferOf, setCurrentFramebuffer } from '../../src/scene/cesiumPrivate143.js'

const C = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')
const K = { FRAMEBUFFER: 0x8d40, READ_FRAMEBUFFER: 0x8ca8, DRAW_FRAMEBUFFER: 0x8ca9, READ_FRAMEBUFFER_BINDING: 0x8caa,
  DRAW_FRAMEBUFFER_BINDING: 0x8ca6, FRAMEBUFFER_COMPLETE: 0x8cd5, FRAMEBUFFER_INCOMPLETE_ATTACHMENT: 0x8cd6 }

// 用 Cesium 1.143 自己的 Context.prototype.clear（与 draw 共用 bindFramebuffer 的缓存判断）和
// Framebuffer.prototype.status，只把 WebGL 换成记录绑定的假对象。
function fixture({ status = K.FRAMEBUFFER_COMPLETE } = {}) {
  const clears = [], bound = { read: null, draw: null }
  const gl = new Proxy({ ...K,
    bindFramebuffer(target, framebuffer) {
      if (target === K.FRAMEBUFFER) bound.read = bound.draw = framebuffer
      else if (target === K.READ_FRAMEBUFFER) bound.read = framebuffer
      else bound.draw = framebuffer
    },
    getParameter(name) { return name === K.READ_FRAMEBUFFER_BINDING ? bound.read : name === K.DRAW_FRAMEBUFFER_BINDING ? bound.draw : null },
    checkFramebufferStatus() { return status },
    clear() { clears.push(bound.draw?.name ?? 'default') } }, { get: (target, key) => key in target ? target[key] : () => {} })
  const context = Object.create(C.Context.prototype)
  const renderState = C.RenderState.fromCache(), passState = { context }
  Object.assign(context, { _gl: gl, _webgl2: false, _clearColor: new C.Color(), _clearDepth: 1, _clearStencil: 0,
    _defaultRenderState: renderState, _currentRenderState: renderState, _currentPassState: passState, _defaultPassState: passState })
  const framebuffer = name => Object.assign(Object.create(C.Framebuffer.prototype), { _gl: gl, _framebuffer: { name }, _activeColorAttachments: [] })
  const clearInto = target => context.clear(new C.ClearCommand({ color: new C.Color(), framebuffer: target, renderState }), passState)
  return { gl, context, bound, clears, framebuffer, clearInto }
}

test('Cesium 1.143 status getter leaves the binding cache stale, so the next draw lands in the default framebuffer', () => {
  // 刻画 Cesium 自身的行为：这正是要修的缺陷来源。若 Cesium 修复了它，这个测试会提醒我们重新评估。
  const f = fixture(), x = f.framebuffer('X'), y = f.framebuffer('Y')
  f.clearInto(x)
  assert.equal(y.status, K.FRAMEBUFFER_COMPLETE)
  f.clearInto(x)
  assert.deepEqual(f.clears, ['X', 'default'])
  assert.equal(f.context._currentFramebuffer, x, 'the cache still claims X is bound')
})

test('checkFramebufferComplete143 keeps the Cesium binding cache valid', () => {
  const f = fixture(), x = f.framebuffer('X'), y = f.framebuffer('Y')
  f.clearInto(x)
  assert.equal(checkFramebufferComplete143(f.context, y), true)
  f.clearInto(x)
  assert.deepEqual(f.clears, ['X', 'X'])
})

test('the check restores raw READ/DRAW bindings and reports incomplete framebuffers', () => {
  const f = fixture({ status: K.FRAMEBUFFER_INCOMPLETE_ATTACHMENT }), y = f.framebuffer('Y')
  const read = { name: 'read' }, draw = { name: 'draw' }
  f.gl.bindFramebuffer(K.READ_FRAMEBUFFER, read); f.gl.bindFramebuffer(K.DRAW_FRAMEBUFFER, draw)
  assert.equal(checkFramebufferComplete143(f.context, y), false)
  assert.equal(f.bound.read, read)
  assert.equal(f.bound.draw, draw)
})

test('the RHI exposes the same check', () => {
  const f = fixture(), x = f.framebuffer('X'), y = f.framebuffer('Y')
  const device = Object.assign(Object.create(WebGLDevice143.prototype), { context: f.context })
  f.clearInto(x)
  assert.equal(device.checkComplete(y), true)
  f.clearInto(x)
  assert.deepEqual(f.clears, ['X', 'X'])
})

test('the gateway reads and writes the Cesium binding cache', () => {
  const context = { _currentFramebuffer: undefined }, framebuffer = {}
  assert.equal(currentFramebufferOf(context), undefined)
  setCurrentFramebuffer(context, framebuffer)
  assert.equal(currentFramebufferOf(context), framebuffer)
  assert.equal(context._currentFramebuffer, framebuffer)
  assert.equal(currentFramebufferOf(undefined), undefined)
})
