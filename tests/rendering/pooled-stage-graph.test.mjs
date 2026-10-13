import test from 'node:test'
import assert from 'node:assert/strict'
import RenderGraph143 from '../../src/pipeline/RenderGraph143.js'
import PooledStageCache143 from '../../src/pipeline/PooledStageCache143.js'

function engine() {
  let id = 0
  return {
    TextureMinificationFilter: { NEAREST: 1 }, TextureMagnificationFilter: { NEAREST: 1 },
    Texture: class { constructor(options) { Object.assign(this, options); this.id = ++id; this.sizeInBytes = options.width * options.height * 4 } isDestroyed() { return !!this.dead } destroy() { this.dead = true } },
    Sampler: class {},
    Framebuffer: class { constructor(options) { Object.assign(this, options); this.status = 1 } isDestroyed() { return !!this.dead } destroy() { this.dead = true } getColorTexture() { return this.colorTextures[0] } },
    ClearCommand: class { constructor(options) { Object.assign(this, options) } execute() {} },
  }
}

test('pooled stage cache declares slots and transfers acquired leases to Render Graph', () => {
  const C = engine()
  const context = { _gl: { FRAMEBUFFER_COMPLETE: 1, canvas: new EventTarget() } }
  const scene = { context, drawingBufferWidth: 16, drawingBufferHeight: 8 }
  const stages = [
    { name: 'raw', textureScale: 0.5, pixelFormat: 1, pixelDatatype: 2, uniforms: {}, clearColor: {} },
    { name: 'resolve', textureScale: 1, pixelFormat: 1, pixelDatatype: 2, uniforms: { u_input: 'raw' }, clearColor: {}, execute() {} },
  ]
  const collection = { _textureCache: { destroy() {} }, getStageByName(name) { return stages.find(stage => stage.name === name) } }
  const cache = new PooledStageCache143(C, scene, collection, stages, 'ao')
  const graph = new RenderGraph143()
  const screen = graph.importResource('screen')
  graph.addPass('screen', pass => pass.write(screen), null, { sideEffect: true })
  cache.declareGraph(graph)
  const result = graph.describe()
  assert.ok(result.passes.includes('ao.raw'))
  assert.ok(result.passes.includes('ao.resolve'))
  graph.beginFrame()
  cache.update(context)
  assert.equal(cache.slots.every(slot => slot.lease?.valid), true)
  cache.finishStage(0)
  assert.equal(cache.slots.every(slot => slot.lease?.valid), true)
  cache.finishStage(1)
  assert.equal(cache.slots[0].lease?.valid, false)
  assert.equal(cache.slots[1].lease?.valid, false)
  graph.endFrame()
  assert.equal(cache.slots.some(slot => slot.lease?.valid), false)
  cache.destroy()
})
