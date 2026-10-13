import test from 'node:test'
import assert from 'node:assert/strict'
import DeferredReflectionTarget143 from '../../src/lighting/DeferredReflectionTarget143.js'

function fakeCesium() {
  return {
    VERSION: '1.143.0', PixelFormat: { RGBA: 1 }, PixelDatatype: { HALF_FLOAT: 2 },
    TextureMinificationFilter: { NEAREST: 1 }, TextureMagnificationFilter: { NEAREST: 1 },
    Sampler: class {}, ClearCommand: class {}, Color: { TRANSPARENT: {} },
    RenderState: { fromCache: options => options, removeFromCache() {} },
    PassState: class {}, BoundingRectangle: class { constructor(x,y,w,h) { Object.assign(this,{x,y,width:w,height:h}) } },
  }
}

test('Deferred reflection auxiliary targets allocate through the WebGL RHI', () => {
  const C = fakeCesium(), released = []
  const device = {
    createTexture(spec) { const texture = { ...spec, isDestroyed: () => false }; return { texture, release: () => released.push(texture) } },
    createFramebuffer(colorTextures) { const framebuffer = { colorTextures, status: 1, isDestroyed: () => false }; return { framebuffer, release: () => released.push(framebuffer) } }
  }
  const context = { _gl: { FRAMEBUFFER_COMPLETE: 1 }, createViewportQuadCommand() { return { shaderProgram: { isDestroyed: () => true }, execute() {} } } }
  const target = new DeferredReflectionTarget143(C, { context }, device)
  const color = { width: 8, height: 4 }
  const output = target.update(color)
  assert.equal(output.textures.length, 3)
  assert.equal(output.lighting.colorTextures.length, 3)
  target.destroy()
  assert.equal(released.length, 7)
})
