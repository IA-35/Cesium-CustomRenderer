// B01 unit tests for FrameBridge143.
//
// These run in Node without a GL context. They cover the parts that are pure bookkeeping and
// lifecycle -- the parts most likely to break silently -- while the rendered-result proof lives in
// `scripts/check-frame-bridge.cjs`, which needs a real browser.
//
// A fake scene is used deliberately: it lets the test assert the *shape* of the patch (own property,
// restored only if still ours, foreign wrappers preserved) without a Cesium runtime.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFrameBridge, FRAME_BRIDGE_PHASES } from '../../src/pipeline/FrameBridge143.js'

/** Minimal Cesium stand-in: the bridge only needs VERSION, a scene with the methods it wraps. */
function fakeCesium() {
  return {
    VERSION: '1.143.0',
    Cartesian4: class Cartesian4 {
      constructor(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w }
    },
  }
}

function fakeScene({ withOit = true } = {}) {
  const calls = { updateAndExecute: 0, resolve: 0, oitExecute: 0, oitExecuteCommands: 0 }
  const prototype = {
    updateAndExecuteCommands() { calls.updateAndExecute++; return 'update' },
    resolveFramebuffers() { calls.resolve++; return 'resolve' },
  }
  const scene = Object.create(prototype)
  scene.id = 'scene-under-test'
  scene.context = { drawingBufferWidth: 100, drawingBufferHeight: 50, uniformState: {} }
  scene._frameState = { frameNumber: 7 }
  scene.frameState = { frameNumber: 7, passes: { render: true, pick: false } }
  scene._environmentState = { useOIT: withOit }
  scene.postRender = { addEventListener: () => () => {} }
  if (withOit) {
    const oit = Object.create({
      executeCommands() { calls.oitExecuteCommands++; return 'oit-commands' },
      execute() { calls.oitExecute++; return 'oit-execute' },
    })
    scene._view = { oit }
  } else {
    scene._view = {}
  }
  return { scene, calls, prototype }
}

test('rejects a Cesium version it has not been verified against', () => {
  const Cesium = fakeCesium()
  Cesium.VERSION = '1.144.0'
  const { scene } = fakeScene()
  assert.throws(() => createFrameBridge({ Cesium, scene }), /requires Cesium 1\.143/)
})

test('requires an explicit Cesium and scene', () => {
  assert.throws(() => createFrameBridge({}), /requires \{ Cesium, scene \}/)
  assert.throws(() => createFrameBridge({ Cesium: fakeCesium() }), /requires \{ Cesium, scene \}/)
})

test('installing adds own properties and leaves the prototype untouched', () => {
  const Cesium = fakeCesium()
  const { scene, prototype } = fakeScene()
  const untouched = prototype.updateAndExecuteCommands
  const bridge = createFrameBridge({ Cesium, scene })
  bridge.install()

  assert.equal(Object.prototype.hasOwnProperty.call(scene, 'updateAndExecuteCommands'), true)
  assert.equal(Object.prototype.hasOwnProperty.call(scene, 'resolveFramebuffers'), true)
  // The prototype must not be modified: another scene would inherit the wrapper.
  assert.equal(prototype.updateAndExecuteCommands, untouched)
  assert.equal(Object.prototype.hasOwnProperty.call(prototype, 'updateAndExecuteCommands'), true)
})

test('wrappers still call through to the native implementation exactly once', () => {
  const Cesium = fakeCesium()
  const { scene, calls } = fakeScene()
  const bridge = createFrameBridge({ Cesium, scene })
  bridge.install()

  assert.equal(scene.updateAndExecuteCommands(), 'update')
  assert.equal(scene.resolveFramebuffers(), 'resolve')
  assert.equal(scene._view.oit.executeCommands(), 'oit-commands')
  assert.equal(scene._view.oit.execute(), 'oit-execute')
  assert.deepEqual(calls, { updateAndExecute: 1, resolve: 1, oitExecute: 1, oitExecuteCommands: 1 })
})

test('a throwing callback is contained and the native call still runs', () => {
  const Cesium = fakeCesium()
  const { scene, calls } = fakeScene()
  const bridge = createFrameBridge({ Cesium, scene })
  bridge.on('resolve', () => { throw new Error('callback exploded') })
  bridge.install()

  assert.equal(scene.resolveFramebuffers(), 'resolve')
  assert.equal(calls.resolve, 1)
  const diagnostics = bridge.getDiagnostics()
  assert.equal(diagnostics.errors.length, 1)
  assert.match(diagnostics.errors[0], /callback exploded/)
})

test('phases are dispatched with frame, view and generation attached, in order', () => {
  const Cesium = fakeCesium()
  const { scene } = fakeScene()
  const bridge = createFrameBridge({ Cesium, scene })
  const seen = []
  for (const phase of FRAME_BRIDGE_PHASES) bridge.on(phase, context => seen.push({ phase, ...context }))
  bridge.install()

  scene.updateAndExecuteCommands()
  scene._view.oit.executeCommands()
  scene._view.oit.execute()
  scene.resolveFramebuffers()

  assert.deepEqual(seen.map(entry => entry.phase), ['opaqueFrame', 'opaqueReadHook', 'translucent', 'resolve'])
  for (const entry of seen) {
    assert.equal(typeof entry.frameNumber, 'number')
    assert.equal(typeof entry.frameGeneration, 'number')
    assert.equal(typeof entry.generation, 'number')
    assert.equal(entry.sceneId, 'scene-under-test')
    assert.equal(entry.generation, 1)
    // Every phase after the per-view wrapper knows which view it belongs to.
    if (entry.phase !== 'opaqueFrame') assert.equal(entry.viewId, 'scene-under-test:0')
  }
  assert.deepEqual(seen[0].drawingBuffer, { width: 100, height: 50 })
})

test('without OIT the bridge reports the phases it can and says which it cannot', () => {
  const Cesium = fakeCesium()
  const { scene } = fakeScene({ withOit: false })
  const bridge = createFrameBridge({ Cesium, scene })
  const seen = []
  for (const phase of FRAME_BRIDGE_PHASES) bridge.on(phase, context => seen.push(context.phase))
  bridge.install()

  scene.updateAndExecuteCommands()
  scene.resolveFramebuffers()

  // No OIT means no per-frustum boundary, so `translucent` must never be invented.
  assert.deepEqual(seen, ['resolve'])
  const diagnostics = bridge.getDiagnostics()
  assert.equal(diagnostics.oitPatched, false)
  assert.ok(diagnostics.unidentifiedPhases.some(entry => entry.phase === 'opaqueReadHook'))
})

test('a disposal removes only its own callback', () => {
  const Cesium = fakeCesium()
  const { scene } = fakeScene()
  const bridge = createFrameBridge({ Cesium, scene })
  const first = []
  const second = []
  const disposeFirst = bridge.on('resolve', () => first.push(1))
  bridge.on('resolve', () => second.push(1))
  bridge.install()

  scene.resolveFramebuffers()
  disposeFirst()
  scene.resolveFramebuffers()

  assert.equal(first.length, 1)
  assert.equal(second.length, 2)
  assert.equal(bridge.getDiagnostics().tokens, 1)
})

test('setEnabled suspends callbacks without losing them', () => {
  const Cesium = fakeCesium()
  const { scene } = fakeScene()
  const bridge = createFrameBridge({ Cesium, scene })
  let count = 0
  bridge.on('resolve', () => count++)
  bridge.install()

  scene.resolveFramebuffers()
  bridge.setEnabled(false)
  scene.resolveFramebuffers()
  assert.equal(count, 1)
  bridge.setEnabled(true)
  scene.resolveFramebuffers()
  assert.equal(count, 2)
})

test('uninstall restores the native methods and is idempotent', () => {
  const Cesium = fakeCesium()
  const { scene, prototype } = fakeScene()
  const bridge = createFrameBridge({ Cesium, scene })
  bridge.install()
  const wrapped = scene.updateAndExecuteCommands
  assert.notEqual(wrapped, prototype.updateAndExecuteCommands)

  bridge.uninstall()
  assert.equal(Object.prototype.hasOwnProperty.call(scene, 'updateAndExecuteCommands'), false)
  assert.equal(scene.updateAndExecuteCommands, prototype.updateAndExecuteCommands)
  assert.equal(Object.prototype.hasOwnProperty.call(scene._view.oit, 'execute'), false)

  // A second uninstall must not throw or restore something twice.
  bridge.uninstall()
  assert.equal(scene.updateAndExecuteCommands, prototype.updateAndExecuteCommands)
})

test('uninstall leaves a foreign wrapper that wrapped us in place', () => {
  const Cesium = fakeCesium()
  const { scene } = fakeScene()
  const bridge = createFrameBridge({ Cesium, scene })
  bridge.install()

  // Someone else wraps our wrapper (the normal case in a host that also instruments the scene).
  const ours = scene.resolveFramebuffers
  let foreignCalls = 0
  const foreign = function (...args) { foreignCalls++; return ours.apply(this, args) }
  scene.resolveFramebuffers = foreign

  bridge.uninstall()
  // Removing the foreign wrapper would break the host, so it must survive.
  assert.equal(scene.resolveFramebuffers, foreign)
  scene.resolveFramebuffers()
  assert.equal(foreignCalls, 1)
})

test('installing twice does not double-wrap, and a destroyed bridge refuses work', () => {
  const Cesium = fakeCesium()
  const { scene, calls } = fakeScene()
  const bridge = createFrameBridge({ Cesium, scene })
  bridge.install()
  bridge.install()
  scene.resolveFramebuffers()
  assert.equal(calls.resolve, 1)

  bridge.destroy()
  assert.equal(bridge.getDiagnostics().destroyed, true)
  assert.equal(Object.prototype.hasOwnProperty.call(scene, 'resolveFramebuffers'), false)
  assert.throws(() => bridge.on('resolve', () => {}), /destroyed/)
  // A destroyed bridge must not keep patching or dispatching.
  assert.equal(scene.resolveFramebuffers(), 'resolve')
  assert.equal(calls.resolve, 2)
})

test('callback priority is honoured within a phase', () => {
  const Cesium = fakeCesium()
  const { scene } = fakeScene()
  const bridge = createFrameBridge({ Cesium, scene })
  const order = []
  bridge.on('resolve', () => order.push('late'), { priority: 10 })
  bridge.on('resolve', () => order.push('early'), { priority: -10 })
  bridge.install()
  scene.resolveFramebuffers()
  assert.deepEqual(order, ['early', 'late'])
})

test('an unknown phase is rejected instead of silently ignored', () => {
  const Cesium = fakeCesium()
  const { scene } = fakeScene()
  const bridge = createFrameBridge({ Cesium, scene })
  assert.throws(() => bridge.on('translucentCompose', () => {}), /unknown frame phase/)
})

test('retired wrappers stay retired after reinstall through a foreign wrapper', () => {
  const { scene, calls } = fakeScene()
  const bridge = createFrameBridge({ Cesium: fakeCesium(), scene })
  let count = 0
  bridge.on('resolve', () => count++)
  bridge.install()
  const first = scene.resolveFramebuffers
  scene.resolveFramebuffers = function(...args) { return first.apply(this, args) }
  for (let i = 0; i < 3; i++) {
    bridge.uninstall(); bridge.install(); scene.resolveFramebuffers()
  }
  assert.equal(count, 3)
  assert.equal(calls.resolve, 3)
})

test('same frame number preserves frame generation across repeated entry calls', () => {
  const { scene } = fakeScene()
  const bridge = createFrameBridge({ Cesium: fakeCesium(), scene }).install()
  scene.updateAndExecuteCommands(); scene.updateAndExecuteCommands()
  assert.equal(bridge.getDiagnostics().frameGeneration, 1)
  scene.frameState.frameNumber++
  scene.updateAndExecuteCommands()
  assert.equal(bridge.getDiagnostics().frameGeneration, 2)
})

test('an existing but inactive OIT has no fabricated opaque boundary and rejects writes', () => {
  const { scene } = fakeScene()
  const bridge = createFrameBridge({ Cesium: fakeCesium(), scene }).install()
  const phases = []
  for (const phase of FRAME_BRIDGE_PHASES) bridge.on(phase, () => phases.push(phase))
  scene._environmentState.useOIT = false
  scene.resolveFramebuffers()
  assert.deepEqual(phases, ['resolve'])
  assert.equal(bridge.uploadOpaqueColor([1,0,0,1]).applied, false)
})

test('pick frames cannot invoke render callbacks or mutate colors', () => {
  const { scene } = fakeScene()
  const bridge = createFrameBridge({ Cesium: fakeCesium(), scene }).install()
  let callbacks = 0
  bridge.on('resolve', () => callbacks++)
  scene.frameState.passes = { render: false, pick: true }
  scene.resolveFramebuffers(); scene._view.oit.execute()
  assert.equal(callbacks, 0)
  assert.equal(bridge.uploadOpaqueColor([1,0,0,1]).applied, false)
})

test('callbacks registered while disabled stay disabled until enabled', () => {
  const { scene } = fakeScene()
  const bridge = createFrameBridge({ Cesium: fakeCesium(), scene }).install()
  bridge.setEnabled(false)
  let count = 0
  bridge.on('resolve', () => count++)
  scene.resolveFramebuffers()
  assert.equal(count, 0)
  bridge.setEnabled(true); scene.resolveFramebuffers()
  assert.equal(count, 1)
})

test('context loss retires the installation instead of reusing invalid GPU resources', () => {
  const { scene } = fakeScene()
  const listeners = new Map()
  scene.canvas = { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) }
  const bridge = createFrameBridge({ Cesium: fakeCesium(), scene }).install()
  assert.equal(typeof listeners.get('webglcontextlost'), 'function')
  listeners.get('webglcontextlost')()
  assert.equal(bridge.installed, false)
  assert.equal(listeners.size, 0)
})

test('uninstall inside a callback stops the remaining dispatch', () => {
 const {scene}=fakeScene(),bridge=createFrameBridge({Cesium:fakeCesium(),scene}).install()
 let called=0
 bridge.on('resolve',()=>bridge.uninstall(),{priority:-1})
 bridge.on('resolve',()=>called++)
 scene.resolveFramebuffers()
 assert.equal(called,0)
})

test('failed installation rolls back wrappers already installed', () => {
 const {scene}=fakeScene(),original=scene.updateAndExecuteCommands
 Object.defineProperty(scene,'resolveFramebuffers',{value:()=>{},writable:false})
 const bridge=createFrameBridge({Cesium:fakeCesium(),scene})
 assert.throws(()=>bridge.install())
 assert.equal(bridge.installed,false)
 assert.equal(scene.updateAndExecuteCommands,original)
})
