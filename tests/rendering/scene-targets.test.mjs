import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { acquireSceneTargets143, FRAME_BITS } from '../../src/pipeline/SceneTargets143.js'
import ContextDrawDispatcher143 from '../../src/pipeline/ContextDrawDispatcher143.js'
import TaaMotion143 from '../../src/antialiasing/TaaMotion143.js'

const C = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')

// 模拟 1.143 的场景：每次 updateAndExecuteCommands 开头按 picking 切换 globeDepth 的目标，拾取前可替换 _view。
function sceneFixture() {
  const fb = name => ({ name })
  const makeView = prefix => {
    const output = fb(prefix + 'globe'), pick = fb(prefix + 'globePick')
    const globeDepth = { picking: false, get colorFramebufferManager() { return { framebuffer: this.picking ? pick : output } },
      get framebuffer() { return this.colorFramebufferManager.framebuffer } }
    return { globeDepth, sceneFramebuffer: { _colorFramebuffer: { framebuffer: fb(prefix + 'scene') }, idFramebuffer: fb(prefix + 'id') },
      oit: { _translucentFBO: { framebuffer: fb(prefix + 'oitT') }, _alphaFBO: { framebuffer: fb(prefix + 'oitA') } } }
  }
  const scene = { frameState: { frameNumber: 1, passes: { render: true, pick: false, depth: false, pickVoxel: false } } }
  scene._view = makeView('a.')
  scene.updateAndExecuteCommands = function(callback) {
    const passes = this.frameState.passes
    this._view.globeDepth.picking = passes.pick || passes.pickVoxel
    return callback?.()
  }
  return { scene, makeView }
}

test('kinds cover tagged instances, the default framebuffer and anything else', () => {
  const { scene } = sceneFixture(), lease = acquireSceneTargets143(scene), targets = lease.targets, view = scene._view
  scene.updateAndExecuteCommands(() => {
    assert.equal(targets.kindOf(view.sceneFramebuffer._colorFramebuffer.framebuffer), 'sceneColor')
    assert.equal(targets.kindOf(view.globeDepth.framebuffer), 'globeColor')
    assert.equal(targets.kindOf(view.sceneFramebuffer.idFramebuffer), 'selectedId')
    assert.equal(targets.kindOf(view.oit._translucentFBO.framebuffer), 'oitTranslucent')
    assert.equal(targets.kindOf(view.oit._alphaFBO.framebuffer), 'oitAlpha')
    assert.equal(targets.kindOf(undefined), 'default')
    assert.equal(targets.kindOf({}), 'other')
    assert.equal(targets.frameBits, FRAME_BITS.render)
  })
  lease.release()
})

test('each updateAndExecuteCommands call re-tags; within a call the snapshot is built once', () => {
  const { scene, makeView } = sceneFixture(), lease = acquireSceneTargets143(scene), targets = lease.targets
  let builds = 0
  const build = targets.build.bind(targets)
  targets.build = () => { builds++; return build() }
  const renderGlobe = scene._view.globeDepth.framebuffer
  scene.updateAndExecuteCommands(() => { for (let i = 0; i < 50; i++) targets.kindOf(renderGlobe) })
  assert.equal(builds, 1)
  // 拾取调用：同一帧号，globeDepth 切到拾取目标，帧类型变为 pick。
  scene.frameState.passes.pick = true
  scene.updateAndExecuteCommands(() => {
    assert.equal(targets.kindOf(renderGlobe), 'other', 'the render-time globe target is not the pick target')
    assert.equal(targets.kindOf(scene._view.globeDepth.framebuffer), 'globeColor')
    assert.equal(targets.frameBits, FRAME_BITS.render | FRAME_BITS.pick)
  })
  // 后处理绘制发生在调用之后，沿用这次调用的快照。
  assert.equal(targets.kindOf(scene._view.globeDepth.framebuffer), 'globeColor')
  scene.frameState.passes.pick = false
  scene._view = makeView('b.')
  scene.updateAndExecuteCommands(() => {
    assert.equal(targets.kindOf(scene._view.sceneFramebuffer._colorFramebuffer.framebuffer), 'sceneColor', 'a swapped view is re-tagged')
  })
  assert.equal(builds, 3)
  lease.release()
})

test('leases share one snapshot and release only an unwrapped hook', () => {
  const { scene } = sceneFixture(), native = scene.updateAndExecuteCommands
  const a = acquireSceneTargets143(scene), b = acquireSceneTargets143(scene)
  assert.equal(a.targets, b.targets)
  a.release(); assert.notEqual(scene.updateAndExecuteCommands, native, 'still leased')
  b.release(); assert.equal(scene.updateAndExecuteCommands, native)
  const c = acquireSceneTargets143(scene), ours = scene.updateAndExecuteCommands
  const foreign = function(...args) { return ours.apply(this, args) }
  scene.updateAndExecuteCommands = foreign
  c.release()
  assert.equal(scene.updateAndExecuteCommands, foreign, 'a foreign outer wrapper stays in place')
})

test('dispatcher calls filtered handlers only for matching pass, target and frame', () => {
  const { scene } = sceneFixture(), lease = acquireSceneTargets143(scene), view = scene._view
  const draws = [], dispatcher = new ContextDrawDispatcher143({ draw(command) { draws.push(command) } }).install().attachTargets(lease.targets)
  const calls = []
  dispatcher.addHandler(event => { calls.push(['motion', event.target]); return 'continue' },
    { name: 'motion', passes: [C.Pass.OPAQUE], targets: ['sceneColor', 'globeColor'], frame: { render: true, pick: false, depth: false } })
  dispatcher.addHandler(() => { calls.push(['all']); return 'continue' }, { name: 'all' })
  const scene_ = view.sceneFramebuffer._colorFramebuffer.framebuffer
  scene.updateAndExecuteCommands(() => {
    dispatcher.context.draw({ pass: C.Pass.OPAQUE, framebuffer: scene_ })
    dispatcher.context.draw({ pass: C.Pass.TRANSLUCENT, framebuffer: scene_ })
    dispatcher.context.draw({ pass: C.Pass.OPAQUE }, { framebuffer: view.sceneFramebuffer.idFramebuffer })
  })
  scene.frameState.passes.pick = true
  scene.updateAndExecuteCommands(() => dispatcher.context.draw({ pass: C.Pass.OPAQUE, framebuffer: scene._view.globeDepth.framebuffer }))
  assert.deepEqual(calls, [['all'], ['motion', 'sceneColor'], ['all'], ['all'], ['all']], 'equal priority runs by name')
  assert.equal(draws.length, 4)
  assert.equal(dispatcher.stats.handlerCalls, 5)
  dispatcher.destroy(); lease.release()
})

test('without attached targets only pass filters exclude; routes reset when handlers change', () => {
  const dispatcher = new ContextDrawDispatcher143({ draw() {} }).install(), calls = []
  dispatcher.addHandler(event => { calls.push(event.target); return 'continue' },
    { name: 'filtered', passes: [C.Pass.GLOBE], targets: ['selectedId'], frame: { render: true } })
  dispatcher.context.draw({ pass: C.Pass.GLOBE, framebuffer: {} })
  dispatcher.context.draw({ pass: C.Pass.OPAQUE })
  assert.deepEqual(calls, [undefined], 'unknown target and frame match; the pass filter still applies')
  dispatcher.addHandler(() => { calls.push('late'); return 'continue' }, { name: 'late', passes: [C.Pass.OPAQUE] })
  dispatcher.context.draw({ pass: C.Pass.OPAQUE })
  assert.deepEqual(calls, [undefined, 'late'], 'a cached route is rebuilt after a handler is added')
  assert.throws(() => dispatcher.addHandler(() => {}, { targets: ['nope'] }), /unknown target kind/)
  // 无法识别的 pass（测试桩里没有 C.Pass）不得变成排除条件。
  dispatcher.addHandler(() => { calls.push('stub'); return 'continue' }, { name: 'stub', passes: [undefined] })
  dispatcher.context.draw({ pass: C.Pass.TRANSLUCENT })
  assert.deepEqual(calls.at(-1), 'stub')
  dispatcher.destroy()
})

test('TAA motion target check gives the same answer from the snapshot and from the view chain', () => {
  const { scene } = sceneFixture(), lease = acquireSceneTargets143(scene), targets = lease.targets
  const motion = Object.create(TaaMotion143.prototype)
  Object.assign(motion, { C, scene })
  const view = scene._view
  const framebuffers = [undefined, {}, view.sceneFramebuffer._colorFramebuffer.framebuffer, view.globeDepth.framebuffer,
    view.sceneFramebuffer.idFramebuffer, view.oit._translucentFBO.framebuffer]
  let compared = 0
  for (const flags of [{}, { pick: true }, { depth: true }, { render: false }]) {
    Object.assign(scene.frameState.passes, { render: true, pick: false, depth: false, pickVoxel: false }, flags)
    scene.updateAndExecuteCommands(() => {
      for (const pass of [C.Pass.OPAQUE, C.Pass.TRANSLUCENT, C.Pass.GLOBE]) for (const framebuffer of framebuffers) {
        const command = { pass, framebuffer }
        assert.equal(Boolean(motion.isSceneColor(command, null, targets.kindOf(framebuffer))), Boolean(motion.isSceneColor(command, null)))
        compared++
      }
    })
  }
  assert.equal(compared, 72)
  lease.release()
})
