import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const backend = await import('../../src/environment/AtmosphereLut143.js').catch(() => null)
const Cesium = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')

function fixture() {
  assert.ok(backend, 'Hillaire atmosphere LUT backend must exist')
  const resources = [], draws = [], states = []
  class Resource {
    constructor(options = {}) { Object.assign(this, options); this.status = 1; resources.push(this) }
    isDestroyed() { return !!this.dead }
    destroy() { assert.ok(!this.dead); this.dead = true }
  }
  const C = { ...Cesium, Texture: Resource, Framebuffer: Resource,
    RenderState: { fromCache: options => (states.push(options), options), removeFromCache: state => states.splice(states.indexOf(state), 1) } }
  const viewport = new C.BoundingRectangle(3, 4, 100, 200)
  const context = { webgl2: true, halfFloatingPointTexture: true, colorBufferHalfFloat: true,
    floatingPointTexture: true, colorBufferFloat: true, textureFloatLinear: true,
    uniformState: { viewport }, _currentFramebuffer: 'native',
    _gl: { FRAMEBUFFER_COMPLETE: 1, READ_FRAMEBUFFER_BINDING: 2, DRAW_FRAMEBUFFER_BINDING: 3,
      READ_FRAMEBUFFER: 4, DRAW_FRAMEBUFFER: 5, getParameter: x => x, bindFramebuffer() {}, isContextLost: () => false },
    createViewportQuadCommand(shader, options) {
      return { ...options, shaderProgram: new Resource(), execute(ctx, state) {
        draws.push({ framebuffer: this.framebuffer, shader, uniforms: Object.fromEntries(Object.entries(this.uniformMap).map(([k, f]) => [k, f()])) })
        ctx.uniformState.viewport = state.viewport; ctx._currentFramebuffer = this.framebuffer
        if (context.failDraw === draws.length) throw new Error('LUT draw failed')
      } }
    } }
  const scene = { context, isDestroyed: () => false }
  const lut = new backend.default(C, scene)
  const params = { atmosphereParams: new C.Cartesian4(6371000, 6471000, 1 / 1200, 1 / 8000),
    atmosphereMieParameters: new C.Cartesian2(1, 0.7), atmoOrigin: new C.Cartesian3(0, 0, 6371100),
    sunLocal: new C.Cartesian3(0.8, 0, 0.6) }
  const update = () => lut.update(context, params)
  return { C, context, scene, lut, params, update, resources, draws, states, viewport }
}

test('LUT builds once, caches, and restores Cesium framebuffer and viewport', () => {
  const f = fixture()
  assert.equal(f.update(), true); assert.equal(f.lut.ready, true)
  assert.equal(f.draws.length, 3)
  const t = f.lut.getTextures()
  assert.deepEqual([t.transmittance.width, t.transmittance.height], [256, 64])
  assert.deepEqual([t.multipleScattering.width, t.multipleScattering.height], [32, 32])
  assert.deepEqual([t.skyView.width, t.skyView.height], [192, 108])
  assert.equal(t.skyView.pixelDatatype, f.C.PixelDatatype.HALF_FLOAT)
  assert.equal(f.context._currentFramebuffer, 'native'); assert.deepEqual(f.context.uniformState.viewport, f.viewport)
  assert.equal(f.update(), true); assert.equal(f.draws.length, 3)
  f.lut.destroy(); f.lut.destroy()
  assert.ok(f.resources.every(r => r.dead)); assert.equal(f.states.length, 0)
})

test('sun and camera altitude update sky only; azimuth/frame rotation and incoming radiance do not rebuild symmetric LUTs', () => {
  const f = fixture(); f.update()
  f.params.sunLocal = new f.C.Cartesian3(0.6, 0, 0.8); f.update()
  assert.equal(f.draws.length, 4)
  f.params.atmoOrigin.z += 200; f.update(); assert.equal(f.draws.length, 5)
  f.params.sunLocal = new f.C.Cartesian3(0, 0.6, 0.8)
  f.params.atmosphereSunRadiance = new f.C.Cartesian3(20, 15, 10)
  f.update(); assert.equal(f.draws.length, 5)
  f.params.atmosphereMieParameters.x = 1.4; f.update(); assert.equal(f.draws.length, 8)
  f.params.absorptionBeta = [1e-5, 3e-5, 1e-6]; f.update(); assert.equal(f.draws.length, 11)
  f.params.modelVersion = 2; f.update(); assert.equal(f.draws.length, 14)
  f.lut.destroy()
})

test('failed medium or sky update publishes no partial textures, uniforms or invalidation keys and retries', () => {
  for (const failPass of [1, 2, 3]) {
    const f = fixture(); f.update()
    const before = f.lut.getTextures(), keys = f.lut.getDiagnostics().keys
    const mie = f.lut.getUniformMap().u_lutMie()
    f.params.atmosphereMieParameters.x = 2
    f.context.failDraw = f.draws.length + failPass
    assert.equal(f.update(), true, 'previous successfully published set remains usable')
    assert.deepEqual(f.lut.getTextures(), before)
    assert.deepEqual(f.lut.getDiagnostics().keys, keys)
    assert.equal(f.lut.getUniformMap().u_lutMie().x, mie.x)
    assert.match(f.lut.getDiagnostics().error, /LUT draw failed/)
    f.context.failDraw = null; f.update()
    assert.notEqual(f.lut.getTextures().transmittance, before.transmittance)
    assert.notDeepEqual(f.lut.getDiagnostics().keys, keys)
    const sky = f.lut.getTextures().skyView, oldSkyKey = f.lut.getDiagnostics().keys.sky
    f.params.sunLocal.z = 0.9; f.context.failDraw = f.draws.length + 1
    f.update(); assert.equal(f.lut.getTextures().skyView, sky)
    assert.equal(f.lut.getDiagnostics().keys.sky, oldSkyKey)
    f.context.failDraw = null; f.update(); assert.notEqual(f.lut.getTextures().skyView, sky)
    f.lut.destroy(); assert.ok(f.resources.every(r => r.dead))
  }
})

test('first failure, unsupported contexts and destroyed owners never advertise ready textures', () => {
  const f = fixture(); f.context.failDraw = 2
  assert.equal(f.update(), false); assert.equal(f.lut.ready, false)
  assert.equal(f.lut.getTextures().skyView, undefined)
  f.context.failDraw = null; assert.equal(f.update(), true)
  f.lut.destroy(); assert.equal(f.update(), false); assert.equal(f.lut.ready, false)
  const unsupported = fixture(); unsupported.context.webgl2 = false
  assert.equal(unsupported.update(), false); unsupported.lut.destroy()
})

test('float32 fallback and RHI leases release every target exactly once', () => {
  const f = fixture(); f.lut.destroy(); f.context.halfFloatingPointTexture = false
  const released = []
  const rhi = {
    createTexture(spec) { const texture = new f.C.Texture(spec); return { texture, release() { released.push(texture); texture.destroy() } } },
    createFramebuffer(textures) { const framebuffer = new f.C.Framebuffer({ colorTextures: textures }); return { framebuffer, release() { released.push(framebuffer); framebuffer.destroy() } } }
  }
  f.lut = new backend.default(f.C, f.scene, { rhi }); assert.equal(f.lut.update(f.context, f.params), true)
  assert.equal(f.lut.getTextures().transmittance.pixelDatatype, f.C.PixelDatatype.FLOAT)
  f.lut.destroy(); assert.equal(released.length, 12)
})

test('actual passes are graph routed and GL errors retain the published version', () => {
  const f = fixture(); f.lut.destroy()
  const events = []
  f.lut = new backend.default(f.C, f.scene, { runPass(key, execute) { events.push(key); return execute() } })
  assert.equal(f.lut.update(f.context, f.params), true)
  assert.deepEqual(events, ['atmosphere.transmittanceLut', 'atmosphere.multiscatterLut', 'atmosphere.skyViewLut'])
  const before = f.lut.getTextures()
  f.context._gl.NO_ERROR = 0; f.context._gl.getError = () => 1282
  f.params.atmosphereMieParameters.x = 3
  assert.equal(f.lut.update(f.context, f.params), true)
  assert.deepEqual(f.lut.getTextures(), before)
  assert.match(f.lut.getDiagnostics().error, /WebGL error/)
  f.lut.destroy()
})

test('CPU parameter goldens preserve the accepted spectral medium and camera geodetic height contract', () => {
  assert.ok(backend)
  const p = backend.atmosphereLutParameters({ atmosphereParams: [6378137, 6478137, 1 / 1200, 1 / 8000],
    atmoOrigin: [0, 0, 6379137], sunLocal: [0, 4, 3] })
  assert.deepEqual(p.sky, [6379.137, 0.6])
  assert.deepEqual(p.medium.rayleighBeta, [5.5e-6, 13e-6, 22.4e-6])
  assert.deepEqual(p.medium.mieBeta, [21e-6, 21e-6, 21e-6])
  assert.deepEqual(p.medium.absorptionBeta, [2.04e-5, 4.97e-5, 1.95e-6])
  assert.deepEqual(p.medium.ozone, [30000, 4000])
  const orbit = backend.atmosphereLutParameters({ atmoOrigin: [0, 0, 7000000] })
  assert.equal(orbit.sky[0], 7000, 'orbital camera must not be clamped inside the atmosphere')
  assert.throws(() => backend.atmosphereLutParameters({ sunLocal: [0, 0, 0] }), /Invalid/)
  assert.throws(() => backend.atmosphereLutParameters({ atmosphereMieParameters: [1, 1] }), /Invalid/)
})

test('mixed sky-only swaps never select a published attachment as a medium staging target', () => {
  const f = fixture(); f.update()
  f.params.sunLocal.z = 0.8; f.update()
  const before = f.lut.getTextures(), start = f.draws.length
  f.params.atmosphereMieParameters.x = 2
  f.context.failDraw = start + 3
  f.update()
  for (const [i, name] of ['transmittance', 'multipleScattering', 'skyView'].entries())
    assert.notEqual(f.draws[start + i].framebuffer.colorTextures[0], before[name])
  assert.deepEqual(f.lut.getTextures(), before)
  f.lut.destroy()
})

test('context loss discards dead GPU versions and restoration rebuilds before ready; destroyed scenes are never ready', () => {
  const f = fixture(); f.update()
  const old = f.lut.getTextures()
  let lost = true; f.context._gl.isContextLost = () => lost
  assert.equal(f.lut.ready, false); assert.equal(f.update(), false)
  lost = false
  assert.equal(f.lut.ready, false, 'context restoration cannot revive old GPU objects')
  assert.equal(f.update(), true)
  assert.notEqual(f.lut.getTextures().skyView, old.skyView)
  f.scene.isDestroyed = () => true
  assert.equal(f.lut.ready, false); assert.equal(f.update(), false)
  f.lut.destroy(); assert.ok(f.resources.every(r => r.dead))
})

test('sub-threshold camera and sun drift keep the sky LUT and skip GL queries', () => {
  const f = fixture(); f.update()
  let queries = 0
  const getParameter = f.context._gl.getParameter
  f.context._gl.getParameter = x => { queries++; return getParameter(x) }
  f.context._gl.getError = () => { queries++; return 0 }
  for (let i = 1; i <= 30; i++) {
    f.params.atmoOrigin.z = 6371100 + i * 0.01
    f.params.sunLocal = new f.C.Cartesian3(0.8, 0, 0.6 + i * 1e-6)
    f.update()
  }
  assert.equal(f.draws.length, 3, 'centimetre camera motion and per-frame sun motion do not rebuild Sky-View')
  assert.equal(queries, 0, 'a cache hit performs no GL query')
  f.params.sunLocal = new f.C.Cartesian3(0.8, 0, 0.61); f.update()
  assert.equal(f.draws.length, 4)
  assert.equal(queries, 2, 'a sky-only rebuild saves bindings but skips getError and status')
  f.lut.destroy()
})
