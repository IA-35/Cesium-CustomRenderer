import test from 'node:test'
import assert from 'node:assert/strict'
import RenderGraph143 from '../../src/pipeline/RenderGraph143.js'

test('graph allocator owns one lease per alias group and resolves physical resources', () => {
  const leases = []
  const allocator = {
    acquire(descriptor, group) {
      const lease = { descriptor, group: group.aliasSlot, released: false, release() { this.released = true } }
      leases.push(lease)
      return lease
    },
    release(lease) { lease.release() },
  }
  const graph = new RenderGraph143({ transientAllocator: allocator })
  const screen = graph.importResource('screen', { keepAlive: true })
  const a = graph.createResource('a', { width: 8, height: 8, format: 'rgba8' })
  const b = graph.createResource('b', { width: 8, height: 8, format: 'rgba8' })
  graph.addPass('a.pass', p => { p.write(a); p.write(screen) })
  graph.addPass('b.pass', p => { p.write(b); p.write(screen) })
  const report = graph.describe()
  assert.equal(report.graphTransientActive, true)
  assert.equal(report.logicalSlots, 1)
  assert.equal(report.aliasGroups.length, 1)
  graph.beginFrame({})
  assert.equal(leases.length, 0)
  assert.equal(graph.resolve(a), leases[0])
  assert.equal(graph.resolve(b), leases[0])
  graph.completePass('b.pass')
  assert.equal(leases[0].released, true)
  graph.endFrame()
})

test('graph allocator releases all active leases on frame failure', () => {
  let released = 0
  const graph = new RenderGraph143({ transientAllocator: {
    acquire() { return { release() { released++ } } },
    release(lease) { lease.release() },
  } })
  const screen = graph.importResource('screen', { keepAlive: true }), target = graph.createResource('target', { width: 4, height: 4, format: 'rgba8' })
  graph.addPass('write', p => { p.write(target); p.write(screen) })
  graph.registerPassLifecycle('write', { begin() { graph.resolve(target); throw new Error('begin failed') } })
  assert.throws(() => graph.beginFrame(), /begin failed/)
  assert.equal(released, 1)
  assert.equal(graph.activeFrame, null)
})

test('graph allocator acquires a transient group only when the resource is resolved', () => {
  const leases = []
  const graph = new RenderGraph143({ transientAllocator: {
    acquire(descriptor, group) {
      const lease = { descriptor, group: group.aliasSlot, release() {} }
      leases.push(lease)
      return lease
    },
    release(lease) { lease.release() },
  } })
  const screen = graph.importResource('screen', { keepAlive: true })
  const target = graph.createResource('target', { width: 4, height: 4, format: 'rgba8' })
  graph.addPass('write', p => { p.write(target); p.write(screen) })
  graph.beginFrame()
  assert.equal(leases.length, 0)
  assert.equal(graph.resolve(target), leases[0])
  assert.equal(leases.length, 1)
  graph.endFrame()
})

test('retained transient outputs keep their alias slot away from later consumers', () => {
  const graph = new RenderGraph143()
  const screen = graph.importResource('screen', { keepAlive: true })
  const retained = graph.createResource('retained', { width: 8, height: 8, format: 'rgba8', keepAlive: true })
  const consumer = graph.createResource('consumer', { width: 8, height: 8, format: 'rgba8' })
  graph.addPass('retain', p => { p.write(retained); p.write(screen) }, null, { sideEffect: true })
  graph.addPass('consume', p => { p.write(consumer); p.write(screen) }, null, { sideEffect: true })
  const report = graph.describe()
  assert.equal(report.aliasGroups.length, 2)
  assert.notEqual(report.aliases.find(alias => alias.resource === 'retained').aliasSlot,
    report.aliases.find(alias => alias.resource === 'consumer').aliasSlot)
})

test('unbound external writers are culled unless the resource is explicitly kept alive', () => {
  const graph = new RenderGraph143()
  const external = graph.importResource('external')
  graph.addPass('writer', p => p.write(external))
  assert.deepEqual(graph.describe().culled, ['writer'])
})

test('graph refreshes scaled transient descriptors before lazy allocation', () => {
  let descriptor
  const graph = new RenderGraph143({ transientAllocator: {
    acquire(value) { descriptor = value; return { release() {} } },
    release(lease) { lease.release() },
  } })
  const screen = graph.importResource('screen', { keepAlive: true })
  const target = graph.createResource('scaled', { width: 1, height: 1, scale: 0.5, format: 'rgba8' })
  graph.addPass('write', p => { p.write(target); p.write(screen) })
  graph.beginFrame({ drawingBuffer: { width: 10, height: 6 } })
  graph.resolve(target)
  assert.equal(descriptor.width, 5)
  assert.equal(descriptor.height, 3)
  graph.endFrame()
})
