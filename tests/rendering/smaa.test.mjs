import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import SmaaPass143 from '../../src/antialiasing/SmaaPass143.js'
import { edgesShader, weightsShader, blendShader } from '../../src/antialiasing/smaaShaders.js'
import HdrEnvironmentPass143 from '../../src/environment/HdrEnvironmentPass143.js'

const Cesium = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')

function fixture() {
  const events = [], requests = [], textures = [], collections = []
  const context = { webgl2: true, drawingBufferWidth: 800, drawingBufferHeight: 600,
    uniformState: { viewport: { x: 3, y: 5, width: 800, height: 600 } } }
  class Texture {
    constructor(options) { Object.assign(this, options); this.width = options.source.width; this.height = options.source.height; textures.push(this) }
    destroy() { this.destroyed = true }
    isDestroyed() { return !!this.destroyed }
  }
  class Stage {
    constructor(options) { Object.assign(this, options); this.ready = true; this.outputTexture = { width: 800, height: 600 } }
  }
  class Composite {
    constructor(options) { Object.assign(this, options); this.ready = true }
  }
  class Collection {
    constructor() {
      collections.push(this)
      this.fxaa = { enabled: true }; this.bloom = { enabled: true }; this.ambientOcclusion = { enabled: true }
      this._tonemapping = { enabled: false }; this.ready = true
      this.outputTexture = { width: 800, height: 600 }
    }
    add(composite) { this.composite = composite; return composite }
    update(...args) { events.push(['update', ...args]); if (this.fail) throw new Error('SMAA GPU error') }
    clear() { events.push(['clear']) }
    execute(c, color) { events.push(['smaa', color]); c.uniformState.viewport.width = 64 }
    copy(...args) { events.push(['smaa-copy', ...args]); return 'own copy' }
    destroy() { this.destroyed = true }
    isDestroyed() { return !!this.destroyed }
  }
  const C = { ...Cesium, Texture, PostProcessStage: Stage, PostProcessStageComposite: Composite,
    PostProcessStageCollection: Collection, buildModuleUrl: path => `https://host/app/Cesium/${path}`,
    Resource: { fetchImage(options) { return new Promise((resolve, reject) => requests.push({ options, resolve, reject })) } } }
  const native = { fxaa: { enabled: false }, outputTexture: { width: 800, height: 600, color: 'tonemapped' },
    execute(...args) { events.push(['native', this, ...args]); return 'native result' },
    copy(...args) { events.push(['native-copy', this, ...args]); return 'native copy' } }
  const originalExecute = native.execute, originalCopy = native.copy
  const scene = { context, postProcessStages: native, frameState: { frameNumber: 1, useLogDepth: true },
    requestRender() {}, isDestroyed: () => false }
  const pass = new SmaaPass143(C, scene)
  const ready = async () => {
    requests[requests.length - 2].resolve({ width: 160, height: 560 })
    requests[requests.length - 1].resolve({ width: 66, height: 33 })
    await pass.readyPromise
  }
  return { C, pass, context, scene, native, events, textures, collections, requests, ready, originalExecute, originalCopy,
    execute: () => native.execute(context, { width: 800, height: 600, color: 'HDR' }, 'depth', 'id'),
    copy: () => native.copy(context, 'framebuffer') }
}

test('no allocation until enabled; lookup fallback gives way to three post-tone-map passes', async () => {
  const f = fixture()
  assert.equal(f.collections.length, 0)
  assert.equal(f.native.execute, f.originalExecute)
  f.pass.setEnabled(true)
  assert.equal(f.native.fxaa.enabled, true)
  assert.equal(f.pass.getDiagnostics().effective, 'fxaa')
  assert.equal(f.execute(), 'native result')
  assert.equal(f.copy(), 'native copy')
  await f.ready()
  assert.equal(f.native.fxaa.enabled, false)
  for (const name of ['fxaa', 'bloom', 'ambientOcclusion']) assert.equal(f.pass.collection[name].enabled, false)
  f.events.length = 0
  assert.equal(f.execute(), 'native result')
  assert.equal(f.events.find(e => e[0] === 'native')[1], f.native)
  assert.equal(f.events.find(e => e[0] === 'smaa')[1], f.native.outputTexture)
  assert.ok(f.events.findIndex(e => e[0] === 'native') < f.events.findIndex(e => e[0] === 'smaa'))
  assert.deepEqual(f.events.find(e => e[0] === 'update').slice(1), [f.context, true, false])
  assert.deepEqual(f.context.uniformState.viewport, { x: 3, y: 5, width: 800, height: 600 })
  assert.equal(f.copy(), 'native copy', 'hook preserves original copy return value')
  assert.ok(f.events.some(e => e[0] === 'smaa-copy'))
  assert.equal(f.pass.getDiagnostics().effective, 'smaa')
  f.pass.destroy()
})

test('lookup images keep exact dimensions, orientation and sampler settings', async () => {
  const f = fixture(); f.pass.setEnabled(true); await f.ready()
  assert.deepEqual(f.textures.map(t => [t.width, t.height]), [[160, 560], [66, 33]])
  assert.ok(f.requests.every(r => r.options.preferImageBitmap === false))
  assert.ok(f.textures.every(t => t.flipY === false && t.pixelDatatype === Cesium.PixelDatatype.UNSIGNED_BYTE))
  assert.equal(f.textures[0].sampler.minificationFilter, Cesium.TextureMinificationFilter.LINEAR)
  assert.equal(f.textures[1].sampler.minificationFilter, Cesium.TextureMinificationFilter.NEAREST)
  assert.equal(f.textures[1].sampler.magnificationFilter, Cesium.TextureMagnificationFilter.NEAREST)
  f.pass.destroy()
  assert.ok(f.textures.every(t => t.destroyed))
})

test('disable and destroy cancel late loads without GPU allocations or revival', async () => {
  for (const action of ['disable', 'destroy']) {
    const f = fixture(); f.pass.setEnabled(true)
    const pending = f.pass.readyPromise
    action === 'destroy' ? f.pass.destroy() : f.pass.setEnabled(false)
    await f.ready(); await pending
    assert.equal(f.textures.length, 0)
    assert.equal(f.native.fxaa.enabled, false)
    assert.equal(f.native.execute, f.originalExecute)
    assert.equal(f.native.copy, f.originalCopy)
    assert.equal(f.pass.getDiagnostics().ready, false)
    assert.equal(f.pass.collection, undefined)
  }
})

test('lookup and own GPU errors retain native rendering with FXAA fallback', async () => {
  const f = fixture(); f.pass.setEnabled(true)
  f.requests[0].reject(new Error('lookup unavailable'))
  f.requests[1].resolve({ width: 66, height: 33 })
  await f.pass.readyPromise
  assert.equal(f.pass.getDiagnostics().effective, 'fxaa')
  assert.match(f.pass.getDiagnostics().error, /lookup unavailable/)
  assert.equal(f.copy(), 'native copy')
  f.pass.destroy()
  const g = fixture(); g.pass.setEnabled(true); await g.ready()
  const collection = g.pass.collection; collection.fail = true
  assert.equal(g.execute(), 'native result')
  assert.equal(g.copy(), 'native copy')
  assert.equal(g.native.fxaa.enabled, true)
  assert.match(g.pass.getDiagnostics().error, /SMAA GPU error/)
  assert.equal(collection.destroyed, true)
  assert.ok(g.textures.every(t => t.destroyed))
  g.pass.destroy()
})

test('native errors propagate, invalidating old output without mislabeling own failure', async () => {
  const f = fixture()
  const original = f.native.execute
  let fail = false
  f.native.execute = function(...args) { if (fail) throw new Error('native failed'); return original.apply(this, args) }
  f.pass.setEnabled(true); await f.ready(); f.execute(); fail = true
  assert.throws(() => f.execute(), /native failed/)
  f.events.length = 0; f.copy()
  assert.equal(f.events.some(e => e[0] === 'smaa-copy'), false)
  assert.equal(f.pass.getDiagnostics().error, null)
  f.pass.destroy()
})

test('copy never reuses prior-frame output or output from a bypassed execution', async () => {
  const f = fixture(); f.pass.setEnabled(true); await f.ready(); f.execute()
  f.scene.frameState.frameNumber++
  f.events.length = 0; f.copy()
  assert.equal(f.events.some(e => e[0] === 'smaa-copy'), false)
  f.execute(); f.pass.collection.ready = false; f.execute()
  f.events.length = 0; f.copy()
  assert.equal(f.events.some(e => e[0] === 'smaa-copy'), false)
  f.pass.destroy()
})

test('foreign wrappers survive disable, old tokens remain inert on reenable', async () => {
  const f = fixture(); f.pass.setEnabled(true); await f.ready()
  const executeHook = f.native.execute, copyHook = f.native.copy
  const foreignExecute = function(...args) { f.events.push(['foreign']); return executeHook.apply(this, args) }
  const foreignCopy = function(...args) { return copyHook.apply(this, args) }
  f.native.execute = foreignExecute; f.native.copy = foreignCopy
  const oldCollection = f.pass.collection
  f.pass.setEnabled(false)
  assert.equal(oldCollection.destroyed, true)
  assert.equal(f.native.execute, foreignExecute); assert.equal(f.native.copy, foreignCopy)
  f.pass.setEnabled(true); await f.ready(); f.events.length = 0; f.execute(); f.copy()
  assert.equal(f.events.filter(e => e[0] === 'smaa').length, 1)
  assert.equal(f.events.filter(e => e[0] === 'smaa-copy').length, 1)
  f.pass.destroy(); f.pass.destroy(); f.pass.setEnabled(true)
  assert.equal(f.native.execute, foreignExecute); assert.equal(f.native.copy, foreignCopy)
  f.events.length = 0; f.execute(); f.copy()
  assert.equal(f.events.some(e => e[0] === 'smaa' || e[0] === 'smaa-copy'), false)
})

test('external FXAA changes are respected and bypass SMAA to avoid two filters', async () => {
  const f = fixture(); f.pass.setEnabled(true); await f.ready()
  f.native.fxaa.enabled = true
  f.execute(); f.copy()
  assert.equal(f.events.some(e => e[0] === 'smaa'), false)
  f.pass.setEnabled(false)
  assert.equal(f.native.fxaa.enabled, true)
})

test('resize follows current output dimensions and linear edge/weight outputs', async () => {
  const f = fixture(); f.pass.setEnabled(true); await f.ready()
  f.native.outputTexture = { width: 1200, height: 900 }
  f.pass.collection.outputTexture = { width: 1200, height: 900 }
  f.context.drawingBufferWidth = 1200; f.context.drawingBufferHeight = 900
  f.execute()
  assert.deepEqual(f.pass.stages.edges.uniforms.resolution(), new Cesium.Cartesian2(1 / 1200, 1 / 900))
  for (const stage of [f.pass.stages.edges, f.pass.stages.weights]) {
    assert.equal(stage.outputTexture.sampler.minificationFilter, Cesium.TextureMinificationFilter.LINEAR)
  }
  assert.deepEqual(f.pass.getDiagnostics().outputDimensions, { width: 1200, height: 900 })
  f.pass.destroy()
})

test('real Cesium stage names connect dependencies and preserve original color for blend', () => {
  const f = fixture()
  f.C.PostProcessStage = Cesium.PostProcessStage
  f.C.PostProcessStageComposite = Cesium.PostProcessStageComposite
  f.C.PostProcessStageCollection = Cesium.PostProcessStageCollection
  f.pass.setEnabled(true)
  const { edges, weights, blend } = f.pass.stages
  assert.equal(f.pass.composite.inputPreviousStageTexture, false)
  assert.equal(weights.uniforms.tDiffuse, edges.name)
  assert.equal(blend.uniforms.tDiffuse, weights.name)
  for (const stage of [edges, weights, blend]) {
    assert.equal(stage.pixelFormat, Cesium.PixelFormat.RGBA)
    assert.equal(stage.pixelDatatype, Cesium.PixelDatatype.UNSIGNED_BYTE)
    assert.equal(stage.textureScale, 1)
    const combined = new Cesium.ShaderSource({ sources: [stage.fragmentShader] }).createCombinedFragmentShader({ webgl2: true })
    assert.match(combined, /out vec4 out_FragColor;/)
    assert.doesNotMatch(combined, /gl_FragColor|texture2D|projectionMatrix|modelViewMatrix|varying /)
  }
  assert.equal(f.pass.collection._tonemapping.enabled, false)
  assert.equal(f.pass.collection._autoExposureEnabled, false)
  f.pass.destroy()
})

test('SMAA lookup PNG headers and full three.js port remain paired', () => {
  for (const [name, width, height] of [['AreaTex.png', 160, 560], ['SearchTex.png', 66, 33]]) {
    const bytes = readFileSync(new URL(`../../public/rendering/smaa/${name}`, import.meta.url))
    assert.equal(bytes.readUInt32BE(16), width); assert.equal(bytes.readUInt32BE(20), height)
  }
  assert.match(edgesShader, /#define SMAA_THRESHOLD 0\.1/)
  assert.match(weightsShader, /#define SMAA_MAX_SEARCH_STEPS 8/)
  for (const direction of ['XLeft', 'XRight', 'YUp', 'YDown']) assert.match(weightsShader, new RegExp(`SMAASearch${direction}`))
  // The scalar conversion and explicit Y compensation are a paired WebGL port
  // convention: (1,0) samples right, (0,1) samples down in texture coordinates.
  assert.match(weightsShader, /coord \+ float\(\s*offset\s*\) \* resolution/)
  for (const offset of ['1, 0', '0, 1']) {
    assert.ok(weightsShader.includes('coords.y -= 1.0 * resolution.y; // WebGL port note: Added\n' +
      `\t\tfloat e2 = SMAASampleLevelZeroOffset( edgesTex, coords, ivec2( ${offset} ) )`))
  }
  assert.match(blendShader, /vec4 mixed = mix\(C, Cop, s\)/)
})

test('scene destruction during loading never creates textures on a dead context', async () => {
  const f = fixture(); f.pass.setEnabled(true)
  f.scene.isDestroyed = () => true
  await f.ready()
  assert.equal(f.textures.length, 0)
  assert.equal(f.pass.ready, false)
  f.pass.destroy()
})

test('overlapping lookup generations cannot revive a disabled pass', async () => {
  const f = fixture(); f.pass.setEnabled(true)
  const firstReady = f.pass.readyPromise
  f.pass.setEnabled(false); f.pass.setEnabled(true)
  await f.ready()
  const activeCollection = f.pass.collection
  f.requests[0].resolve({ width: 160, height: 560 }); f.requests[1].resolve({ width: 66, height: 33 })
  await firstReady
  assert.equal(f.pass.collection, activeCollection)
  assert.equal(f.textures.length, 2)
  assert.equal(f.native.fxaa.enabled, false)
  f.pass.destroy()
})

test('unexpected lookup layout and partial texture allocation fail to FXAA without leaks', async () => {
  const badLayout = fixture(); badLayout.pass.setEnabled(true)
  badLayout.requests[0].resolve({ width: 160, height: 560 })
  badLayout.requests[1].resolve({ width: 64, height: 16 })
  await badLayout.pass.readyPromise
  assert.match(badLayout.pass.getDiagnostics().error, /dimensions/)
  assert.equal(badLayout.textures.length, 0)
  assert.equal(badLayout.native.fxaa.enabled, true)
  badLayout.pass.destroy()
  const f = fixture(), OriginalTexture = f.C.Texture
  f.C.Texture = class extends OriginalTexture {
    constructor(options) {
      if (options.source.width === 66) throw new Error('allocation failed')
      super(options)
    }
  }
  f.pass.setEnabled(true); await f.ready()
  assert.equal(f.textures.length, 1)
  assert.equal(f.textures[0].destroyed, true)
  assert.equal(f.pass.getDiagnostics().effective, 'fxaa')
  f.pass.destroy()
})

test('unsupported WebGL uses only native FXAA and restores its original value', () => {
  const f = fixture(); f.context.webgl2 = false
  f.pass.setEnabled(true)
  assert.equal(f.pass.getDiagnostics().supported, false)
  assert.equal(f.pass.getDiagnostics().effective, 'fxaa')
  assert.equal(f.collections.length, 0)
  assert.equal(f.requests.length, 0)
  f.pass.destroy()
  assert.equal(f.native.fxaa.enabled, false)
})

test('SMAA stays after native tonemap in either HDR adapter installation order', async () => {
  for (const hdrFirst of [true, false]) {
    const f = fixture()
    Object.assign(f.context, { depthTexture: true, floatingPointTexture: true, colorBufferFloat: true })
    Object.assign(f.scene, { highDynamicRange: true, mode: Cesium.SceneMode.SCENE3D, _view: { frustumCommandsList: [{}] } })
    const hdr = new HdrEnvironmentPass143(f.C, f.scene, () => ({ ready: true }))
    if (hdrFirst) hdr.setEnabled(true)
    f.pass.setEnabled(true); await f.ready()
    if (!hdrFirst) hdr.setEnabled(true)
    hdr.collection.execute = (context, color) => f.events.push(['hdr', color])
    f.events.length = 0
    assert.equal(f.execute(), 'native result')
    const sequence = f.events.filter(e => ['hdr', 'native', 'smaa'].includes(e[0])).map(e => e[0])
    assert.deepEqual(sequence, ['hdr', 'native', 'smaa'])
    assert.deepEqual(f.context.uniformState.viewport, { x: 3, y: 5, width: 800, height: 600 })
    hdr.destroy(); f.pass.destroy()
  }
})

test('real Cesium cache does not alias a sampler input with its output framebuffer', () => {
  const f = fixture()
  f.C.PostProcessStage = Cesium.PostProcessStage
  f.C.PostProcessStageComposite = Cesium.PostProcessStageComposite
  f.C.PostProcessStageCollection = Cesium.PostProcessStageCollection
  f.pass.setEnabled(true)
  const { collection, stages } = f.pass
  for (const stage of Object.values(stages)) stage._ready = true
  collection._activeStages = [f.pass.composite]
  const original = Cesium.FramebufferManager.prototype.update
  // Keep real Cesium dependency/allocation decisions; only skip GL framebuffer creation.
  Cesium.FramebufferManager.prototype.update = function() {}
  try {
    collection._textureCache.updateDependencies()
    collection._textureCache.update(f.context)
    const targets = collection._textureCache._stageNameToFramebuffer
    assert.ok(targets[stages.edges.name])
    assert.notEqual(targets[stages.edges.name], targets[stages.weights.name])
    assert.notEqual(targets[stages.weights.name], targets[stages.blend.name])
    assert.ok(collection._textureCache._framebuffers.every(t => t.textureScale === 1 && t.pixelDatatype === Cesium.PixelDatatype.UNSIGNED_BYTE))
  } finally {
    Cesium.FramebufferManager.prototype.update = original
    f.pass.destroy()
  }
})
