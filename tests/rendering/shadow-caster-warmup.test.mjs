import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import ShadowReceiver143 from '../../src/shadows/ShadowReceiver143.js'
import DirectionalShadowPass, { MAX_CASTER_LINKS_PER_FRAME } from '../../src/shadows/DirectionalShadowPass.js'

const C = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')

// 不需要 GL：Cesium 的 ShaderCache 只拼接文本、创建未编译的 ShaderProgram。
function receiverFixture() {
  const context = { webgl2: true, textureFloatLinear: true, floatingPointTexture: true, _gl: {} }
  context.shaderCache = new C.ShaderCache(context)
  const scene = { context, frameState: { frameNumber: 7 } }
  const receiver = new ShaderReceiverFor(scene)
  const source = context.shaderCache.getShaderProgram({ context,
    vertexShaderSource: new C.ShaderSource({ sources: ['in vec3 position; void main(){ gl_Position = vec4(position, 1.0); }'] }),
    fragmentShaderSource: new C.ShaderSource({ sources: ['void main(){ out_FragColor = vec4(1.0); }'] }),
    attributeLocations: { position: 0 } })
  return { context, scene, receiver, source }
}
function ShaderReceiverFor(scene) { return new ShadowReceiver143(C, scene, {}) }

test('castProgram creates the caster program once per source and cast() draws with that same program', () => {
  const f = receiverFixture()
  const program = f.receiver.castProgram(f.source)
  assert.equal(f.receiver.castProgram(f.source), program)
  assert.equal(program._program, undefined, 'creating the program does not compile it')
  assert.ok(program._fragmentShaderText.includes('campus_depth_main'))
  assert.equal(f.receiver.castUsed.get(f.source.id), 7, 'a warmed caster counts as used, so it is not pruned early')
  const command = new C.DrawCommand({ shaderProgram: f.source, renderState: C.RenderState.fromCache(), uniformMap: {}, castShadows: true })
  assert.equal(f.receiver.cast(command, {}).shaderProgram, program)
})

// DirectionalShadowPass 的预热与延后逻辑只依赖 adapter.raw/castProgram 与 shaderWarmup，用替身隔离 Cesium 场景。
function passFixture({ parallel = true } = {}) {
  const programs = new Map(), warmed = [], requests = []
  const ready = new Set()
  const programFor = source => {
    if (!programs.has(source)) programs.set(source, { source, _program: undefined,
      _vertexShaderText: `vs-${source}`, _fragmentShaderText: `fs-${source}`, _attributeLocations: { position: 0 } })
    return programs.get(source)
  }
  const pass = Object.create(DirectionalShadowPass.prototype)
  Object.assign(pass, { C, scene: { requestRender: () => requests.push(1) }, stats: {}, deferredCasters: 0, linkedThisFrame: new Set(),
    warmedSources: new WeakSet(), casterKeys: new WeakMap(),
    adapter: { raw: command => command.source, castProgram: programFor },
    shaderWarmup: { parallel,
      warm: texts => { warmed.push(texts); return parallel ? texts.fragmentShaderText : null },
      isReady: keys => keys.every(key => ready.has(key)) } })
  const command = (source, extra = {}) => ({ source: { name: source, toString: () => source }, castShadows: true, shaderProgram: {}, pass: C.Pass.OPAQUE, ...extra })
  return { pass, programs, programFor, warmed, requests, ready, command }
}

test('casters are warmed as soon as their commands appear, once per source program', () => {
  const f = passFixture()
  const a = f.command('a'), b = f.command('b')
  const sameSource = { ...f.command('x'), source: a.source }
  const list = [a, sameSource, b, f.command('t', { pass: C.Pass.TRANSLUCENT }), f.command('n', { castShadows: false }), { pass: C.Pass.COMPUTE }]
  f.pass.prewarmCasters(list)
  assert.deepEqual(f.warmed.map(t => t.fragmentShaderText), ['fs-a', 'fs-b'])
  assert.deepEqual(f.warmed[0].attributeLocations, { position: 0 })
  f.pass.prewarmCasters(list)
  assert.equal(f.warmed.length, 2, 'later frames add nothing for sources already seen')
  const compiled = f.command('c'); f.programFor(compiled.source)._program = {}
  f.pass.prewarmCasters([compiled])
  assert.equal(f.warmed.length, 2, 'an already compiled caster program needs no warm-up')
})

test('a caster whose program is still compiling is deferred instead of compiled on the main thread', () => {
  const f = passFixture()
  const warm = f.command('warm'), cold = f.command('cold'), compiled = f.command('done')
  f.programFor(compiled.source)._program = {}
  f.pass.prewarmCasters([warm])
  f.ready.add('fs-warm')
  const drawn = f.pass.readyCasters([warm, cold, compiled])
  assert.deepEqual(drawn, [warm, compiled])
  assert.equal(f.pass.deferredCasters, 1)
  assert.ok(f.warmed.some(t => t.fragmentShaderText === 'fs-cold'), 'a caster first seen by the shadow pass is submitted then')
  assert.ok(f.requests.length > 0, 'requests another frame so the caster is drawn once warm')
  f.ready.add('fs-cold')
  f.pass.deferredCasters = 0 // render() 每次重画前清零；同一次重画内各级联累加
  assert.deepEqual(f.pass.readyCasters([warm, cold, compiled]), [warm, cold, compiled])
  assert.equal(f.pass.deferredCasters, 0)
})

// 预热后 Cesium 仍要在主线程按缓存重新编译（实测中位 16 ms），大量投影体同帧就绪会叠成长帧。
test('only a few newly warmed caster programs are linked per shadow render', () => {
  const f = passFixture()
  const list = Array.from({ length: MAX_CASTER_LINKS_PER_FRAME + 2 }, (_, i) => f.command(`s${i}`))
  f.pass.prewarmCasters(list)
  for (const t of f.warmed) f.ready.add(t.fragmentShaderText)
  const first = f.pass.readyCasters(list)
  assert.deepEqual(first, list.slice(0, MAX_CASTER_LINKS_PER_FRAME))
  assert.equal(f.pass.deferredCasters, 2)
  assert.ok(f.requests.length > 0)
  const shared = { ...f.command('again'), source: list[0].source }
  assert.deepEqual(f.pass.readyCasters([shared, ...list]), [shared, ...first],
    'later cascades of the same render redraw admitted programs without spending budget again')
  for (const c of first) f.programFor(c.source)._program = {}
  f.pass.linkedThisFrame.clear(); f.pass.deferredCasters = 0 // render() 每次重画前清零
  assert.deepEqual(f.pass.readyCasters(list), list)
  assert.equal(f.pass.deferredCasters, 0)
})

test('pending casters stop the shadow pass from reusing its previous frame', () => {
  const f = passFixture()
  Object.assign(f.pass, { ready: true, forceShadowUpdate: false, lastCameraView: {}, lastLightDirection: {} })
  f.pass.deferredCasters = 2
  assert.equal(f.pass.shouldReuseShadowFrame({}, {}, [], {}, {}), false)
})

test('without parallel compilation every caster is drawn as before', () => {
  const f = passFixture({ parallel: false })
  const list = [f.command('a'), f.command('b')]
  f.pass.prewarmCasters(list)
  assert.equal(f.warmed.length, 0)
  assert.equal(f.pass.readyCasters(list), list)
  const none = passFixture(); none.pass.shaderWarmup = null
  assert.equal(none.pass.readyCasters(list), list)
})
