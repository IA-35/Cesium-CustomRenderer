import test from 'node:test'
import assert from 'node:assert/strict'
import { createFrameState143, isColorFrame143 } from '../../src/core/FrameState143.js'
import { createRenderItem143, sortRenderItems143 } from '../../src/renderer/RenderItem143.js'
import { resolveRendererCapabilities143 } from '../../src/diagnostics/CapabilityResolver143.js'
import CesiumSceneAdapter143 from '../../src/scene/CesiumSceneAdapter143.js'
import RenderGraph143 from '../../src/pipeline/RenderGraph143.js'
import RenderItemQueue143 from '../../src/renderer/RenderItemQueue143.js'

test('FrameState is immutable and describes Cesium color frames', () => {
  const scene = { frameState: { frameNumber: 9, passes: { render: true } }, context: { drawingBufferWidth: 80, drawingBufferHeight: 40 }, _environmentState: { useOIT: true }, _view: { frustumCommandsList: [1, 2] } }
  const state = createFrameState143(scene, { generation: 3 })
  assert.equal(state.frameNumber, 9)
  assert.deepEqual(state.drawingBuffer, { width: 80, height: 40 })
  assert.equal(state.useOIT, true)
  assert.equal(state.frustumCount, 2)
  assert.equal(isColorFrame143(state), true)
  assert.throws(() => { state.frameNumber = 10 }, TypeError)
})

test('RenderItems sort collected commands without taking ownership of them', () => {
  const a = { id: 'a' }, b = { id: 'b' }
  const items = sortRenderItems143([
    createRenderItem143(a, { sortKey: 20, materialKey: 'z' }),
    createRenderItem143(b, { sortKey: 10, materialKey: 'a' }),
  ])
  assert.deepEqual(items.map(item => item.command.id), ['b', 'a'])
  assert.equal(items[0].source, 'cesium.draw-command')
})

test('capability resolver exposes effective fallback mode', () => {
  const report = resolveRendererCapabilities143({ maxDrawBuffers: 4, maxColorAttachments: 4, attachmentsNeeded: 6, floatingPointTexture: true, colorBufferFloat: true, halfFloatingPointTexture: true, colorBufferHalfFloat: true }, { lightingMode: 'deferred' }, {})
  assert.equal(report.requestedMode, 'deferred')
  assert.equal(report.effectiveMode, 'enhanced')
  assert.equal(report.fallback, 'enhanced')
})

test('Cesium scene adapter bridges collected commands into CCR items', () => {
  const C = { Pass: { TRANSLUCENT: 2 } }
  const scene = { frameState: { frameNumber: 4, passes: { render: true } }, context: { drawingBufferWidth: 1, drawingBufferHeight: 1 } }
  const adapter = new CesiumSceneAdapter143(C, scene)
  const items = adapter.collect([{ pass: 2, owner: { id: 3 } }, { pass: 1, owner: { id: 1 } }])
  assert.equal(items.length, 2)
  assert.equal(items[0].pass, 'native.forward')
  assert.equal(items[1].pass, 'transparent.forward')
})

test('Render Graph binds external history handles for native stage outputs', () => {
  const graph = new RenderGraph143()
  const history = graph.importResource('taa.history.colorA')
  graph.addPass('taa.read', pass => { pass.read(history); pass.sideEffect() })
  const texture = { width: 4, height: 4 }
  graph.bindExternal(history, texture)
  assert.equal(graph.externalOf(history), texture)
  assert.equal(graph.describe().resources.find(resource => resource.name === 'taa.history.colorA').bound, true)
})

test('RenderItem queue collects and sorts a frame without owning Cesium commands', () => {
  const queue = new RenderItemQueue143(), frameState = { frameNumber: 8 }
  queue.begin(frameState)
  const first = createRenderItem143({ id: 'first' }, { pass: 'transparent.forward', sortKey: 20, frameState })
  const second = createRenderItem143({ id: 'second' }, { pass: 'transparent.forward', sortKey: 10, frameState })
  queue.submit(first); queue.submit(second)
  assert.deepEqual(queue.snapshot('transparent.forward').map(item => item.command.id), ['second', 'first'])
  assert.equal(queue.getDiagnostics().count, 2)
  queue.begin({ frameNumber: 9 })
  assert.equal(queue.getDiagnostics().count, 0)
})
