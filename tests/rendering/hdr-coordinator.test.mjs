import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHdrEffect } from '../../src/environment/HdrCoordinator143.js'
import HdrEnvironmentPass143 from '../../src/environment/HdrEnvironmentPass143.js'

function fixture() {
  const events = []
  const context = { depthTexture: true, floatingPointTexture: true, colorBufferFloat: true,
    uniformState: { viewport: { x: 0, y: 0, width: 800, height: 600 } } }
  const native = { execute(...args) { events.push(['tone', ...args]); return { receiver: this, args } } }
  const original = native.execute
  const scene = { postProcessStages: native, context, highDynamicRange: true, mode: 3,
    frameState: { useLogDepth: true }, _view: { frustumCommandsList: [{}] } }
  const effect = name => (c, color, depth, id) => {
    assert.equal(c, context)
    assert.equal(depth, 'depth')
    assert.equal(id, 'id')
    events.push([name, color])
    return `${color}:${name}`
  }
  return { scene, context, native, original, events, effect,
    execute: () => native.execute(context, 'HDR', 'depth', 'id', 'extra') }
}

for (const order of [['ao', 'environment'], ['environment', 'ao']]) {
  test(`priority orders ${order.join(' then ')} before native tone mapping`, () => {
    const f = fixture()
    const detach = order.map(name => registerHdrEffect(f.scene, name === 'ao' ? 10 : 20, f.effect(name)))
    const result = f.execute()
    assert.deepEqual(f.events.map(e => e[0]), ['ao', 'environment', 'tone'])
    assert.deepEqual(result.args, [f.context, 'HDR:ao:environment', 'depth', 'id', 'extra'])
    assert.equal(result.receiver, f.native)
    detach.forEach(remove => remove())
    assert.equal(f.native.execute, f.original)
  })
}

test('environment adapter retains AO priority after disable and reenable', () => {
  const f = fixture()
  class Collection {
    constructor() {
      this.fxaa = {}; this.ambientOcclusion = {}; this.bloom = {}; this.ready = true
    }
    add() {}
    update() {}
    clear() {}
    execute(c, color, depth, id) { this.outputTexture = f.effect('environment')(c, color, depth, id) }
    destroy() { this.destroyed = true }
    isDestroyed() { return !!this.destroyed }
  }
  const C = { VERSION: '1.143', SceneMode: { SCENE3D: 3 }, PostProcessStageCollection: Collection }
  const environment = new HdrEnvironmentPass143(C, f.scene, () => ({ ready: true }))
  environment.setEnabled(true)
  const detach = registerHdrEffect(f.scene, 10, f.effect('ao'))
  for (let i = 0; i < 2; i++) {
    f.events.length = 0
    f.execute()
    assert.deepEqual(f.events.map(e => e[0]), ['ao', 'environment', 'tone'])
    assert.equal(environment.inputColor, 'HDR:ao')
    environment.setEnabled(false)
    f.events.length = 0
    f.execute()
    assert.deepEqual(f.events.map(e => e[0]), ['ao', 'tone'])
    environment.setEnabled(true)
  }
  environment.destroy()
  detach()
  assert.equal(f.native.execute, f.original)
})

test('SMAA outer wrapper preserves one native tone invocation in either installation order', () => {
  for (const hdrFirst of [true, false]) {
    const f = fixture()
    let detachAo
    if (hdrFirst) detachAo = registerHdrEffect(f.scene, 10, f.effect('ao'))
    const previous = f.native.execute
    f.native.execute = function(...args) {
      const result = previous.apply(this, args)
      f.events.push(['smaa'])
      return result
    }
    if (!hdrFirst) detachAo = registerHdrEffect(f.scene, 10, f.effect('ao'))
    const detachEnvironment = registerHdrEffect(f.scene, 20, f.effect('environment'))
    f.execute()
    assert.deepEqual(f.events.map(e => e[0]), ['ao', 'environment', 'tone', 'smaa'])
    detachEnvironment()
    detachAo()
  }
})

test('foreign wrappers survive final detach and retired hooks stay inert after new registration', () => {
  const f = fixture()
  const removeOld = registerHdrEffect(f.scene, 10, f.effect('old'))
  const retiredHook = f.native.execute
  const foreign = function(...args) { f.events.push(['foreign']); return retiredHook.apply(this, args) }
  f.native.execute = foreign
  removeOld()
  assert.equal(f.native.execute, foreign)
  const removeNew = registerHdrEffect(f.scene, 10, f.effect('new'))
  const newHook = f.native.execute
  removeOld()
  assert.equal(f.native.execute, newHook)
  f.execute()
  assert.deepEqual(f.events.map(e => e[0]), ['new', 'foreign', 'tone'])
  f.events.length = 0
  retiredHook.call(f.native, f.context, 'HDR', 'depth', 'id')
  assert.deepEqual(f.events.map(e => e[0]), ['tone'])
  removeNew()
  assert.equal(f.native.execute, foreign)
})

test('duplicate callbacks are independent registrations and detach is idempotent', () => {
  const f = fixture()
  const process = f.effect('ao')
  const removeFirst = registerHdrEffect(f.scene, 10, process)
  const removeSecond = registerHdrEffect(f.scene, 10, process)
  f.execute()
  assert.deepEqual(f.events.map(e => e[0]), ['ao', 'ao', 'tone'])
  removeFirst()
  removeFirst()
  f.events.length = 0
  f.execute()
  assert.deepEqual(f.events.map(e => e[0]), ['ao', 'tone'])
  removeSecond()
  assert.equal(f.native.execute, f.original)
})

test('effects removed during a callback do not execute in the same frame', () => {
  const f = fixture()
  let removeEnvironment
  const removeAo = registerHdrEffect(f.scene, 10, (c, color) => {
    f.events.push(['ao'])
    removeEnvironment()
    return color
  })
  removeEnvironment = registerHdrEffect(f.scene, 20, f.effect('environment'))
  f.execute()
  assert.deepEqual(f.events.map(e => e[0]), ['ao', 'tone'])
  removeAo()
})

test('callback and native exceptions propagate without retrying native execution', () => {
  for (const failing of ['effect', 'native']) {
    const f = fixture()
    const expected = new Error(failing)
    let nativeCalls = 0
    f.native.execute = () => { nativeCalls++; throw expected }
    const detach = registerHdrEffect(f.scene, 10, (c, color) => {
      if (failing === 'effect') throw expected
      return color
    })
    assert.throws(f.execute, error => error === expected)
    assert.equal(nativeCalls, failing === 'native' ? 1 : 0)
    detach()
  }
})

test('registrations share a collection coordinator and remain isolated from other collections', () => {
  const f = fixture(), other = fixture()
  const detachAo = registerHdrEffect(f.scene, 10, f.effect('ao'))
  const hook = f.native.execute
  const detachEnvironment = registerHdrEffect({ postProcessStages: f.native }, 20, f.effect('environment'))
  assert.equal(f.native.execute, hook)
  assert.equal(other.native.execute, other.original)
  f.execute()
  assert.deepEqual(f.events.map(e => e[0]), ['ao', 'environment', 'tone'])
  detachAo()
  detachEnvironment()
})
