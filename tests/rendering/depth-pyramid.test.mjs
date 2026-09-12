import test from 'node:test'
import assert from 'node:assert/strict'
import DepthPyramid143, { pyramidDimensions } from '../../src/channels/DepthPyramid143.js'

function fixture({ failAt = 0, incomplete = false, statusThrows = false, drawFails = false } = {}) {
  const resources = [], states = [], draws = []
  let allocations = 0
  const initialRead = {}, initialDraw = {}, initialViewport = { x: 3, y: 4, width: 90, height: 60 }
  let read = initialRead, draw = initialDraw
  const gl = {
    READ_FRAMEBUFFER_BINDING: 1, DRAW_FRAMEBUFFER_BINDING: 2, READ_FRAMEBUFFER: 3,
    DRAW_FRAMEBUFFER: 4, FRAMEBUFFER: 5, FRAMEBUFFER_COMPLETE: 6,
    getParameter(p) { return p === 1 ? read : draw },
    bindFramebuffer(target, value) {
      if (target === 3 || target === 5) read = value
      if (target === 4 || target === 5) draw = value
    },
    isContextLost() { return false }
  }
  class Resource {
    constructor(options) {
      if (++allocations === failAt) throw new Error('allocation failed')
      Object.assign(this, options)
      this.destroyed = 0
      resources.push(this)
    }
    destroy() { this.destroyed++ }
    isDestroyed() { return this.destroyed > 0 }
  }
  const context = { _gl: gl, webgl2: true, floatingPointTexture: true, colorBufferFloat: true,
    uniformState: { viewport: { ...initialViewport } },
    createViewportQuadCommand(shader, options) {
      const shaderProgram = new Resource({ kind: 'program' })
      return { shader, ...options, shaderProgram, execute(ctx, pass) {
        draws.push({ source: this.uniformMap.u_source(), framebuffer: this.framebuffer, pass })
        ctx.uniformState.viewport = this.renderState.viewport
        if (drawFails) throw new Error('draw failed')
      } }
    }
  }
  const C = {
    VERSION: '1.143.0',
    Texture: class extends Resource {},
    Framebuffer: class extends Resource {
      constructor(options) { gl.bindFramebuffer(gl.FRAMEBUFFER, {}); super(options) }
      get status() {
        if (statusThrows) throw new Error('status query failed')
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        return incomplete ? 0 : 6
      }
    },
    Sampler: class { constructor(options) { Object.assign(this, options) } },
    PassState: class { constructor(context) { this.context = context } },
    BoundingRectangle: class {
      constructor(x, y, width, height) { Object.assign(this, { x, y, width, height }) }
      static clone(value) { return { ...value } }
    },
    RenderState: {
      fromCache(options) { states.push({ options, removed: 0 }); return options },
      removeFromCache(options) { states.find(state => state.options === options).removed++ }
    },
    PixelFormat: { RGBA: 10 }, PixelDatatype: { FLOAT: 11 },
    TextureMinificationFilter: { NEAREST: 12 }, TextureMagnificationFilter: { NEAREST: 13 }
  }
  const scene = { context, frameState: { frameNumber: 7 }, drawingBufferWidth: 5, drawingBufferHeight: 3 }
  const source = { width: 5, height: 3, isDestroyed: () => false }
  return { C, scene, source, resources, states, draws,
    checkRestored() {
      assert.equal(read, initialRead)
      assert.equal(draw, initialDraw)
      assert.deepEqual(context.uniformState.viewport, initialViewport)
    } }
}

test('ceil reduction retains odd edges and terminates at a single texel', () => {
  assert.equal(typeof pyramidDimensions, 'function', 'HiZ dimensions implementation exists')
  assert.deepEqual(pyramidDimensions(5, 3), [[3, 2], [2, 1], [1, 1]])
  assert.deepEqual(pyramidDimensions(1, 9), [[1, 5], [1, 3], [1, 2], [1, 1]])
  assert.deepEqual(pyramidDimensions(9, 1), [[5, 1], [3, 1], [2, 1], [1, 1]])
  assert.deepEqual(pyramidDimensions(1, 1), [[1, 1]])
  for (const size of [[0, 3], [2, -1], [1.5, 2], [NaN, 1], [Infinity, 1]]) assert.deepEqual(pyramidDimensions(...size), [])
  for (let width = 1; width <= 33; width++) for (let height = 1; height <= 19; height++) {
    let previous = [width, height]
    for (const level of pyramidDimensions(width, height)) {
      const visited = new Set()
      for (let y = 0; y < level[1]; y++) for (let x = 0; x < level[0]; x++) {
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
          const sx = x * 2 + dx, sy = y * 2 + dy
          if (sx < previous[0] && sy < previous[1]) {
            const key = `${sx},${sy}`
            assert.ok(!visited.has(key), 'each source texel has one owner')
            visited.add(key)
          }
        }
      }
      assert.equal(visited.size, previous[0] * previous[1], 'every edge texel is covered')
      previous = level
    }
    assert.deepEqual(previous, [1, 1])
  }
})

test('levels are independent RGBA32F targets with ordered sources and exact byte accounting', () => {
  assert.equal(typeof DepthPyramid143, 'function', 'HiZ implementation exists')
  const f = fixture(), pyramid = new DepthPyramid143(f.C, f.scene)
  assert.equal(pyramid.getLevels(), null)
  assert.equal(pyramid.update(f.source, 7), true)
  const levels = pyramid.getLevels()
  assert.deepEqual(levels.map(level => [level.width, level.height]), [[3, 2], [2, 1], [1, 1]])
  assert.equal(pyramid.getDiagnostics().bytes, 16 * 9)
  assert.equal(new Set(levels.map(level => level.texture)).size, 3)
  for (const [index, level] of levels.entries()) {
    assert.equal(level.texture.pixelFormat, 10)
    assert.equal(level.texture.pixelDatatype, 11)
    assert.equal(level.texture.sampler.minificationFilter, 12)
    assert.equal(level.texture.sampler.magnificationFilter, 13)
    assert.equal(level.framebuffer.destroyAttachments, false)
    assert.equal(f.draws[index].source, index ? levels[index - 1].texture : f.source)
    assert.notEqual(f.draws[index].source, level.texture)
    assert.equal(f.draws[index].framebuffer, level.framebuffer)
  }
  f.checkRestored()
})

test('current frame and buffer size gate visibility; invalidation reuses resources and release permits rebuilding', () => {
  const f = fixture(), pyramid = new DepthPyramid143(f.C, f.scene)
  pyramid.update(f.source, 7)
  const old = pyramid.getLevels(), count = f.resources.length
  pyramid.invalidate()
  assert.equal(pyramid.getLevels(), null)
  assert.ok(f.resources.every(resource => !resource.destroyed))
  pyramid.update(f.source, 7)
  assert.equal(f.resources.length, count)
  f.scene.frameState.frameNumber++
  assert.equal(pyramid.getLevels(), null)
  pyramid.update(f.source, 8)
  assert.equal(pyramid.getLevels(), old)
  f.scene.drawingBufferWidth = 7
  assert.equal(pyramid.getLevels(), null)
  f.source.width = 7
  pyramid.update(f.source, 8)
  assert.ok(old.every(level => level.texture.isDestroyed()))
  assert.deepEqual(pyramid.getLevels().map(level => [level.width, level.height]), [[4, 2], [2, 1], [1, 1]])
  pyramid.release()
  assert.equal(pyramid.getDiagnostics().bytes, 0)
  assert.equal(pyramid.getLevels(), null)
  assert.ok(f.resources.every(resource => resource.destroyed === 1))
  assert.ok(f.states.every(state => state.removed === 1))
  assert.equal(pyramid.update(f.source, 8), true)
  pyramid.destroy()
  pyramid.destroy()
  assert.equal(pyramid.update(f.source, 8), false)
  assert.ok(f.resources.every(resource => resource.destroyed === 1))
})

test('a new same-size source replaces the input without reallocation; missing input or context loss hide previous output', () => {
  const f = fixture(), pyramid = new DepthPyramid143(f.C, f.scene)
  pyramid.update(f.source, 7)
  const count = f.resources.length
  const replacement = { ...f.source }
  pyramid.update(replacement, 7)
  assert.equal(f.draws[3].source, replacement)
  assert.equal(f.resources.length, count)
  assert.equal(pyramid.update(null, 7), false)
  assert.equal(pyramid.getLevels(), null)
  assert.ok(f.resources.every(resource => !resource.destroyed))
  pyramid.update(replacement, 7)
  f.scene.context._gl.isContextLost = () => true
  assert.equal(pyramid.getLevels(), null)
  assert.equal(pyramid.update(replacement, 7), false)
  assert.equal(pyramid.getDiagnostics().reason, 'Context lost')
})

test('unsupported, destroyed and stale inputs never publish or allocate output', () => {
  for (const capability of ['webgl2', 'floatingPointTexture', 'colorBufferFloat']) {
    const f = fixture()
    f.scene.context[capability] = false
    const pyramid = new DepthPyramid143(f.C, f.scene)
    assert.equal(pyramid.update(f.source, 7), false)
    assert.equal(pyramid.getDiagnostics().supported, false)
    assert.equal(f.resources.length, 0)
  }
  const f = fixture(), pyramid = new DepthPyramid143(f.C, f.scene)
  for (const [source, frame] of [[null, 7], [{ ...f.source, isDestroyed: () => true }, 7], [f.source, 6], [{ ...f.source, width: 0 }, 7]]) {
    assert.equal(pyramid.update(source, frame), false)
    assert.equal(pyramid.getLevels(), null)
    assert.equal(f.resources.length, 0)
  }
})

test('every partial allocation failure releases targets and shader programs and restores bindings', () => {
  for (let failAt = 1; failAt <= 9; failAt++) {
    const f = fixture({ failAt }), pyramid = new DepthPyramid143(f.C, f.scene)
    assert.equal(pyramid.update(f.source, 7), false)
    assert.equal(pyramid.getLevels(), null)
    assert.match(pyramid.getDiagnostics().error, /allocation failed/)
    assert.equal(pyramid.getDiagnostics().bytes, 0)
    assert.ok(f.resources.every(resource => resource.destroyed === 1), `failure ${failAt}`)
    assert.ok(f.states.every(state => state.removed === 1), `failure ${failAt}`)
    f.checkRestored()
  }
})

test('incomplete targets and draw failures release the pyramid and restore the viewport', () => {
  for (const options of [{ incomplete: true }, { statusThrows: true }, { drawFails: true }]) {
    const f = fixture(options), pyramid = new DepthPyramid143(f.C, f.scene)
    assert.equal(pyramid.update(f.source, 7), false)
    assert.equal(pyramid.getLevels(), null)
    assert.ok(f.resources.every(resource => resource.destroyed === 1))
    assert.ok(f.states.every(state => state.removed === 1))
    f.checkRestored()
  }
})

test('allocation or draw failure stays latched without retrying until explicit release', () => {
  for (const options of [{ failAt: 2 }, { drawFails: true }]) {
    const f = fixture(options), pyramid = new DepthPyramid143(f.C, f.scene)
    assert.equal(pyramid.update(f.source, 7), false)
    const count = f.resources.length, draws = f.draws.length
    pyramid.invalidate()
    f.scene.frameState.frameNumber++
    assert.equal(pyramid.update(f.source, 8), false)
    assert.equal(f.resources.length, count, 'latched failure must not allocate again')
    assert.equal(f.draws.length, draws, 'latched failure must not draw again')
    assert.equal(pyramid.getDiagnostics().failed, true)
    pyramid.release()
    assert.equal(pyramid.getDiagnostics().failed, false)
    assert.equal(pyramid.update(f.source, 8), !options.drawFails)
    assert.ok(f.resources.length > count, 'release explicitly permits retry')
  }
})

test('base shader marks NaN and either infinity unknown before min/max reduction', () => {
  const f = fixture(), pyramid = new DepthPyramid143(f.C, f.scene)
  pyramid.update(f.source, 7)
  const source = pyramid.getLevels()[0].command.shader
  assert.match(source, /isnan\(depth\)\s*\|\|\s*isinf\(depth\)/)
  assert.match(source, /\?\s*vec4\(0\.0,\s*0\.0,\s*0\.0,\s*1\.0\)/)
  assert.ok(source.indexOf('isnan(depth)') < source.indexOf('if (value.r > 0.0)'))
})

test('version mismatch is rejected before accessing scene GPU capabilities', () => {
  for (const VERSION of ['1.142.0', '1.144', '1.143.1', undefined]) {
    assert.throws(() => new DepthPyramid143({ VERSION }, null), /requires Cesium 1\.143/)
  }
})

test('optional transparency marks base coverage unknown while retaining opaque depth bounds', () => {
  const f = fixture(), pyramid = new DepthPyramid143(f.C, f.scene)
  const transparency = { ...f.source, destroy() { assert.fail('coverage is borrowed') } }
  assert.equal(pyramid.update(f.source, 7, transparency), true)
  const levels = pyramid.getLevels(), base = levels[0].command
  assert.equal(base.uniformMap.u_hasTransparency(), true)
  assert.equal(base.uniformMap.u_transparency(), transparency)
  assert.equal(pyramid.getDiagnostics().transparencyIncluded, true)
  assert.match(base.shader, /uniform bool u_hasTransparency;/)
  assert.match(base.shader, /texelFetch\(u_transparency, pixel, 0\)\.r > 0\.0/)
  assert.match(base.shader, /value\.b = 0\.0;/)
  assert.match(base.shader, /value\.a = float\(int\(value\.a\) \| 2\);/)
  assert.doesNotMatch(base.shader, /value\.[rg] =/)
  for (const level of levels.slice(1)) assert.doesNotMatch(level.command.shader, /u_transparency/)
  const resourceCount = f.resources.length
  assert.equal(pyramid.update(f.source, 7), true)
  assert.equal(f.resources.length, resourceCount)
  assert.equal(base.uniformMap.u_hasTransparency(), false)
  assert.equal(base.uniformMap.u_transparency(), f.source)
  assert.equal(pyramid.getDiagnostics().transparencyIncluded, false)
  pyramid.update(f.source, 7, transparency)
  pyramid.release()
  assert.equal(pyramid.getDiagnostics().transparencyIncluded, false)
  assert.equal(pyramid.transparency, undefined)
  pyramid.destroy()
})

test('destroyed or mismatched borrowed transparency cannot publish a partial conservative pyramid', () => {
  const f = fixture(), pyramid = new DepthPyramid143(f.C, f.scene)
  for (const transparency of [{ ...f.source, width: 3 }, { ...f.source, isDestroyed: () => true }]) {
    assert.equal(pyramid.update(f.source, 7, transparency), false)
    assert.equal(f.resources.length, 0)
    assert.equal(pyramid.getLevels(), null)
  }
  const transparency = { ...f.source }
  assert.equal(pyramid.update(f.source, 7, transparency), true)
  transparency.isDestroyed = () => true
  assert.equal(pyramid.getLevels(), null)
  pyramid.destroy()
})

test('emitted mask expressions preserve opaque and transparent bits within pixels and across levels', () => {
  const f = fixture(), pyramid = new DepthPyramid143(f.C, f.scene)
  pyramid.update(f.source, 7, { ...f.source })
  const levels = pyramid.getLevels()
  // Evaluate the emitted scalar GLSL expressions with equivalent integer casts;
  // this tests bit arithmetic without claiming shader compilation or GPU execution.
  const evaluate = (source, assignment) => {
    const expression = source.match(assignment)[1]
    return new Function('value', 'unknown', `const int = Math.trunc, float = Number, max = Math.max; return ${expression};`)
  }
  const cover = evaluate(levels[0].command.shader, /value\.a = ([^;]+);/)
  assert.equal(cover({ a: 0 }), 2, 'transparent-only pixel carries bit 2')
  assert.equal(cover({ a: 1 }), 3, 'unknown opaque plus transparency retains both bits')
  let mask = 0
  for (const [index, level] of levels.entries()) {
    const combine = evaluate(level.command.shader, /unknown = (?!0\.0)([^;]+);/)
    mask = index === 0 ? [1, 2, 0, 0].reduce((sum, a) => combine({ a }, sum), 0)
      : [0, mask, 0, 0].reduce((sum, a) => combine({ a }, sum), 0)
    assert.equal(mask, 3, `level ${index} retains children with different bits`)
    for (const children of [[0, 0], [0, 1], [1, 1]]) {
      assert.equal(children.reduce((sum, a) => combine({ a }, sum), 0), Math.max(...children),
        'without transparency the original 0/1 result is unchanged')
    }
  }
  assert.equal(pyramid.getDiagnostics().unknownMaskContractVersion, 2)
  assert.deepEqual(pyramid.getDiagnostics().unknownMaskBits, { opaque: 1, transparency: 2 })
  pyramid.destroy()
})
