import test from 'node:test'
import assert from 'node:assert/strict'
import RenderGraph143 from '../../src/pipeline/RenderGraph143.js'

test('compiles deferred, transparent and TAA dependencies in order', () => {
  const graph = new RenderGraph143()
  const screen = graph.importResource('cesium.screenColor', { keepAlive: true })
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
  const screen = graph.importResource('screen', { keepAlive: true })
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
  const screen = graph.importResource('screen', { keepAlive: true })
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
  const graph = new RenderGraph143(), screen = graph.importResource('screen', { keepAlive: true })
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

test('culls an unbound external writer without side effects', () => {
  const graph = new RenderGraph143()
  const external = graph.importResource('unused.external', { keepAlive: false })
  graph.addPass('dead.external', pass => pass.write(external))
  assert.deepEqual(graph.describe().culled, ['dead.external'])
})

test('wraps graph pass execution in optional asynchronous GPU scopes', () => {
  const graph = new RenderGraph143(), screen = graph.importResource('screen', { keepAlive: true }), events=[]
  graph.addPass('present', p => p.write(screen), () => events.push('pass'))
  const timer = { supported: true, pending: [], samples: [], measure(label, fn) { events.push(`begin:${label}`); const result=fn(); events.push(`end:${label}`); return result } }
  graph.setGpuTimer(timer);graph.beginFrame();graph.executePass('present');graph.endFrame()
  assert.deepEqual(events, ['begin:graph:present', 'pass', 'end:graph:present'])
  assert.equal(graph.setGpuTimer(null), graph)
})

test('steady frames neither serialise the graph nor build diagnostics', () => {
  const graph = new RenderGraph143()
  const screen = graph.importResource('screen', { keepAlive: true })
  const gbuffer = graph.createResource('gbuffer', { width: 8, height: 8, format: 'rgba16f' })
  graph.addPass('geometry', p => p.write(gbuffer))
  graph.addPass('lighting', p => { p.read(gbuffer); p.write(screen) })
  const calls = { hash: 0, diagnostics: 0, aliases: 0 }
  for (const [name, key] of [['_hash', 'hash'], ['_diagnostics', 'diagnostics'], ['_assignAliases', 'aliases']]) {
    const original = graph[name].bind(graph)
    graph[name] = (...args) => { calls[key]++; return original(...args) }
  }
  for (let i = 0; i < 20; i++) {
    const summary = graph.beginFrame({})
    assert.deepEqual(summary.passes, ['geometry', 'lighting'])
    graph.executePass('geometry'); graph.executePass('lighting'); graph.endFrame()
  }
  assert.deepEqual(calls, { hash: 0, diagnostics: 0, aliases: 1 }, 'compile once, then only a version compare per frame')
  const report = graph.describe()
  assert.equal(typeof report.hash, 'string', 'diagnostics are still complete when read')
  assert.equal(report.version, graph.version)
  assert.equal(calls.aliases, 1)
})

test('every structural change recompiles; rebinding the same external does not', () => {
  const graph = new RenderGraph143()
  const out = graph.importResource('out')
  const scaled = graph.createResource('scaled', { scale: 0.5, format: 'rgba8' })
  graph.addPass('producer', p => { p.write(scaled); p.write(out) })
  let compiles = 0
  const assign = graph._assignAliases.bind(graph)
  graph._assignAliases = order => { compiles++; return assign(order) }
  const passes = () => { const names = graph.beginFrame({ drawingBuffer: { width: 16, height: 8 } }).passes; graph.endFrame(); return names }
  assert.deepEqual(passes(), [], 'a pass writing an unbound, non-keepAlive external is culled')
  graph.bindExternal(out, { width: 16 })
  assert.deepEqual(passes(), ['producer'], 'binding the external keeps its writer alive')
  const before = compiles
  graph.bindExternal(out, { width: 16 }); passes()
  assert.equal(compiles, before, 'replacing a bound value does not change the binding set')
  assert.equal(graph.describe().aliasGroups[0].descriptor.width, 8)
  graph.beginFrame({ drawingBuffer: { width: 32, height: 8 } }); graph.endFrame()
  assert.equal(graph.describe().aliasGroups[0].descriptor.width, 16, 'a canvas resize recompiles scaled transients')
  graph.addPass('present', p => p.read(out), null, { sideEffect: true })
  assert.deepEqual(passes(), ['producer', 'present'])
  graph.bindExternal(out, null)
  assert.deepEqual(passes(), ['producer', 'present'], 'the side-effect reader keeps the producer alive after unbinding')
  graph.reset()
  assert.deepEqual(passes(), [])
})

test('binding and unbinding within a frame does not recompile the next frame', () => {
  const graph = new RenderGraph143()
  const input = graph.importResource('input'), out = graph.createResource('out', { width: 4, height: 4 })
  graph.addPass('stage', p => { p.read(input); p.write(out); p.sideEffect() })
  let compiles = 0
  const assign = graph._assignAliases.bind(graph)
  graph._assignAliases = order => { compiles++; return assign(order) }
  for (let i = 0; i < 10; i++) {
    graph.beginFrame({})
    // 环境图在帧内反复绑定/解绑外部纹理。
    for (let j = 0; j < 50; j++) { graph.bindExternal(input, { id: j }); graph.bindExternal(input, null) }
    graph.executePass('stage'); graph.endFrame()
  }
  assert.equal(compiles, 1)
  graph.bindExternal(input, { id: 'kept' })
  graph.beginFrame({}); graph.endFrame()
  assert.equal(compiles, 2, 'a different net binding set at frame start recompiles once')
  graph.beginFrame({}); graph.endFrame()
  assert.equal(compiles, 2)
})
