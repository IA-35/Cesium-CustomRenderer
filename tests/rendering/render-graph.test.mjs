import test from 'node:test'
import assert from 'node:assert/strict'
import RenderGraph143 from '../../src/pipeline/RenderGraph143.js'

test('compiles deferred, transparent and TAA dependencies in order', () => {
  const graph = new RenderGraph143()
  const screen = graph.importResource('cesium.screenColor')
  const history = graph.importResource('taa.history')
  const gbuffer = graph.createResource('deferred.gbuffer', { width: 64, height: 32, format: 'rgba16f' })
  const resolved = graph.createResource('taa.resolved', { width: 64, height: 32, format: 'rgba16f' })
  graph.addPass('deferred.geometry', p => p.write(gbuffer))
  graph.addPass('deferred.lighting', p => { p.read(gbuffer); p.write(screen) })
  graph.addPass('transparent.forward', p => { p.read(screen); p.write(screen) })
  graph.addPass('taa.resolve', p => { p.read(screen); p.read(history); p.write(resolved) })
  graph.addPass('taa.present', p => { p.read(resolved); p.write(screen) })
  const result = graph.describe()
  assert.deepEqual(result.passes, ['deferred.geometry', 'deferred.lighting', 'transparent.forward', 'taa.resolve', 'taa.present'])
  assert.equal(result.culled.length, 0)
  assert.ok(result.aliases.some(alias => alias.resource === 'deferred.gbuffer'))
  assert.match(graph.toMermaid(), /transparent\.forward/)
})

test('culls disconnected passes and aliases non-overlapping transient resources', () => {
  const graph = new RenderGraph143()
  const screen = graph.importResource('screen')
  const first = graph.createResource('first', { width: 8, height: 8, format: 'rgba8' })
  const second = graph.createResource('second', { width: 8, height: 8, format: 'rgba8' })
  graph.addPass('first.pass', p => { p.write(first); p.write(screen) })
  graph.addPass('second.pass', p => { p.write(second); p.write(screen) })
  graph.addPass('dead.pass', p => p.write(graph.createResource('dead', { width: 1, height: 1, format: 'rgba8' })))
  const result = graph.describe()
  assert.deepEqual(result.culled, ['dead.pass'])
  assert.equal(result.aliases.filter(alias => alias.aliasSlot.endsWith('#0')).length, 2)
})

test('tracks and releases transient target leases at frame end', () => {
  const graph = new RenderGraph143()
  const screen = graph.importResource('screen')
  const transient = graph.createResource('transient', { width: 4, height: 4, format: 'rgba8' })
  graph.addPass('producer', p => { p.write(transient); p.write(screen) })
  let releases = 0
  graph.beginFrame()
  graph.trackLease(transient, { release() { releases++ } })
  assert.equal(graph.leaseOf(transient) !== undefined, true)
  graph.endFrame()
  assert.equal(releases, 1)
  assert.throws(() => graph.trackLease(transient, { release() {} }), /active frame/)
})



test('executes a compiled pass once and reports execution state', () => {
  const graph = new RenderGraph143(), screen = graph.importResource('screen')
  let calls = 0
  graph.addPass('present', p => p.write(screen), () => { calls++ })
  graph.beginFrame({ frameNumber: 3 })
  assert.equal(graph.executePass('present', { frameNumber: 3 }), true)
  assert.equal(graph.executePass('present', { frameNumber: 3 }), true)
  assert.equal(calls, 1)
  assert.deepEqual(graph.describe().activeFrame.executed, ['present'])
  graph.endFrame()
})

test('rejects cycles and invalid resource handles', () => {
  const graph = new RenderGraph143()
  const a = graph.createResource('a')
  const b = graph.createResource('b')
  graph.addPass('a.pass', p => { p.read(b); p.write(a) }, null, { sideEffect: true })
  graph.addPass('b.pass', p => { p.read(a); p.write(b) }, null, { sideEffect: true })
  assert.throws(() => graph.describe(), /cyclic dependency/)
  assert.throws(() => graph.addPass('invalid', p => p.read({ id: 99 })), /invalid resource/)
})
