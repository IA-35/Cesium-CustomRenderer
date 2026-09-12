import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import ScreenSpaceReflection143 from '../../src/reflections/ScreenSpaceReflection143.js'
import TransparentReflection143 from '../../src/reflections/TransparentReflection143.js'
import { registerHdrEffect } from '../../src/environment/HdrCoordinator143.js'
const Cesium = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')

function fixture(realStages = false) {
  const events = [], bindings = [], targets = [], allocated = []
  const texture = bytes => ({ sizeInBytes: bytes, destroyed: false, isDestroyed() { return this.destroyed } })
  class Stage {
    constructor(options) {
      Object.assign(this, options, { ready: true, outputTexture: texture(options.textureScale === .5 ? 32 : 256) })
      allocated.push(this.outputTexture)
      const target = { status: 1 }; targets.push(target)
      this._textureCache = { getFramebuffer: () => target }
      this._command = { shaderProgram: { _program: {}, allUniforms: {} } }
    }
  }
  class Composite { constructor(options) { Object.assign(this, options, { ready: true, length: options.stages.length }) } }
  class Collection {
    constructor() { this.fxaa = {}; this.bloom = {}; this.ambientOcclusion = {}; this.ready = true }
    add(composite) { this.composite = composite }
    update() {}
    clear() {}
    execute(context, color) {
      events.push(['reflection', color])
      context.uniformState.viewport.width = 32
      this.outputTexture = this.composite.stages.at(-1).outputTexture
    }
    isDestroyed() { return !!this.destroyed }
    destroy() { this.destroyed = true; this.composite.stages.forEach(stage => { stage.outputTexture.destroyed = true }) }
  }
  const C = realStages ? Cesium : { ...Cesium, PostProcessStage: Stage, PostProcessStageComposite: Composite, PostProcessStageCollection: Collection }
  const context = { webgl2: true, depthTexture: true, floatingPointTexture: true, colorBufferFloat: true,
    halfFloatingPointTexture: true, colorBufferHalfFloat: true, defaultTexture: {},
    uniformState: { viewport: new Cesium.BoundingRectangle(3, 4, 64, 64) },
    _gl: { isContextLost: () => false, FRAMEBUFFER_COMPLETE: 1, READ_FRAMEBUFFER_BINDING: 2, DRAW_FRAMEBUFFER_BINDING: 3,
      READ_FRAMEBUFFER: 4, DRAW_FRAMEBUFFER: 5, getParameter: value => value, bindFramebuffer: (...args) => bindings.push(args) } }
  const native = { execute(c, color) { events.push(['tone', color]); return 'native result' } }
  const scene = { context, camera: { frustum: new Cesium.PerspectiveFrustum({ fov: Math.PI / 3, aspectRatio: 1, near: 1, far: 1000 }) },
    highDynamicRange: true, frameState: { frameNumber: 1, useLogDepth: true }, postProcessStages: native, requestRender() {}, isDestroyed: () => false }
  const materials = Object.fromEntries(['eyeDepth', 'normalRoughMetal', 'emissiveFlags', 'transparency', 'reflectionSpecular', 'reflectionResponse'].map(key => [key, {}]))
  const levels = [{ texture: {} }, { texture: {} }]
  const source = { getTextures: () => materials, getDepthPyramidLevels: () => levels, getReflectionDiagnostics: () => ({ valid: true }) }
  const settings = {}
  return { C, scene, native, source, materials, levels, settings, events, targets, bindings, allocated,
    ssr: new ScreenSpaceReflection143(C, scene, () => source, () => settings),
    execute: color => native.execute(context, color, 'depth', 'id') }
}

test('SSR allocates two native HDR stages only when enabled and releases its hook and resources', () => {
  const f = fixture(), original = f.native.execute
  assert.equal(f.ssr.collection, undefined)
  f.ssr.setEnabled(true)
  assert.equal(f.ssr.composite.length, 2)
  assert.equal(f.ssr.composite.inputPreviousStageTexture, false)
  assert.equal(f.ssr.stages.trace.textureScale, .5)
  assert.equal(f.ssr.stages.trace.pixelDatatype, Cesium.PixelDatatype.HALF_FLOAT)
  assert.equal(f.ssr.stages.resolve.textureScale, 1)
  assert.equal(f.ssr.stages.resolve.pixelDatatype, Cesium.PixelDatatype.FLOAT)
  assert.equal(f.ssr.stages.resolve.uniforms.u_reflection, f.ssr.stages.trace.name)
  const collection = f.ssr.collection
  f.ssr.destroy(); f.ssr.destroy(); f.ssr.setEnabled(true)
  assert.equal(collection.isDestroyed(), true)
  assert.ok(f.allocated.every(texture => texture.isDestroyed()))
  assert.equal(f.native.execute, original)
  assert.equal(f.ssr.getReflectionTexture(), null)
  assert.equal(f.ssr.getDiagnostics().bytes, 0)
})

test('current reflection, material, transparency and Hi-Z inputs are mandatory each frame', () => {
  for (const change of [f => { f.source.getTextures = () => null }, f => { delete f.materials.reflectionSpecular },
    f => { delete f.materials.reflectionResponse }, f => { delete f.materials.transparency },
    f => { f.source.getDepthPyramidLevels = () => null }, f => { f.source.getDepthPyramidLevels = () => [] },
    f => { f.source.getReflectionDiagnostics = () => ({ valid: false }) },
    f => { f.scene.highDynamicRange = false }, f => { f.scene.camera.frustum = new Cesium.PerspectiveOffCenterFrustum() },
    f => { f.scene.context._gl.isContextLost = () => true }]) {
    const f = fixture(); f.ssr.setEnabled(true); f.execute('HDR')
    assert.ok(f.ssr.getReflectionTexture())
    change(f)
    assert.equal(f.ssr.getReflectionTexture(), null)
    f.events.length = 0
    f.execute('original')
    assert.deepEqual(f.events, [['tone', 'original']])
    assert.equal(f.ssr.stats.bypasses, 1)
    f.ssr.destroy()
  }
})

test('SSR runs before AO and tone mapping, snapshots main projection and binds current inputs', () => {
  const f = fixture()
  const detachAo = registerHdrEffect(f.scene, 10, (c, color) => { f.events.push(['ao', color]); return color })
  f.ssr.setEnabled(true)
  const projection = Cesium.Matrix4.clone(f.scene.camera.frustum.projectionMatrix)
  assert.equal(f.execute('HDR'), 'native result')
  assert.deepEqual(f.events.map(e => e[0]), ['reflection', 'ao', 'tone'])
  assert.equal(f.events[1][1], f.ssr.collection.outputTexture)
  assert.deepEqual(f.scene.context.uniformState.viewport, new Cesium.BoundingRectangle(3, 4, 64, 64))
  const uniforms = f.ssr.stages.trace.uniforms
  assert.deepEqual(uniforms.u_projection(), projection)
  assert.notEqual(uniforms.u_projection(), f.scene.camera.frustum.projectionMatrix)
  assert.deepEqual(uniforms.u_inverseProjection(), Cesium.Matrix4.inverse(projection, new Cesium.Matrix4()))
  for (const [uniform, key] of [['depth', 'eyeDepth'], ['material', 'normalRoughMetal'], ['flags', 'emissiveFlags'],
    ['transparency', 'transparency'], ['specular', 'reflectionSpecular'], ['response', 'reflectionResponse']]) {
    assert.equal(uniforms[`u_${uniform}`](), f.materials[key])
  }
  assert.equal(uniforms.u_hiz0(), f.levels[0].texture)
  assert.equal(uniforms.u_hiz4(), f.levels[1].texture)
  assert.equal(uniforms.u_maxLevel(), 2)
  assert.equal(uniforms.u_near(), 1)
  assert.equal(uniforms.u_distance(), 150)
  assert.equal(uniforms.u_thickness(), .5)
  assert.equal(uniforms.u_strength(), 1)
  Object.assign(f.settings, { screenSpaceReflectionDistance: 80, screenSpaceReflectionThickness: .2, screenSpaceReflectionStrength: .3 })
  assert.equal(uniforms.u_distance(), 80); assert.equal(uniforms.u_thickness(), .2); assert.equal(uniforms.u_strength(), .3)
  f.ssr.destroy(); detachAo()
})

test('SSR output is current-frame only and byte accounting counts distinct active textures', () => {
  const f = fixture(); f.ssr.setEnabled(true)
  assert.equal(f.ssr.getReflectionTexture(), null)
  f.execute('HDR')
  assert.equal(f.ssr.getReflectionTexture(), f.ssr.stages.trace.outputTexture)
  assert.equal(f.ssr.getDiagnostics().bytes, 288)
  f.scene.frameState.frameNumber++
  assert.equal(f.ssr.getReflectionTexture(), null)
  f.ssr.stages.resolve.outputTexture = f.ssr.stages.trace.outputTexture
  assert.equal(f.ssr.getDiagnostics().bytes, 32)
  f.ssr.collection.ready = false
  f.execute('HDR')
  assert.equal(f.ssr.getReflectionTexture(), null)
  assert.equal(f.ssr.stats.bypasses, 1)
  f.ssr.destroy()
})

test('incomplete framebuffer fails closed, restores bindings and requires off-on before retry', () => {
  const f = fixture(), original = f.native.execute
  f.ssr.setEnabled(true)
  const collection = f.ssr.collection
  f.targets[0].status = 9
  f.execute('original')
  assert.deepEqual(f.events, [['tone', 'original']])
  assert.match(f.ssr.error, /incomplete/i)
  assert.equal(f.ssr.failed, true)
  assert.equal(collection.isDestroyed(), true)
  assert.equal(f.native.execute, original)
  assert.deepEqual(f.bindings.slice(-2), [[4, 2], [5, 3]])
  f.ssr.setEnabled(true)
  assert.equal(f.ssr.collection, undefined)
  f.ssr.setEnabled(false); f.ssr.setEnabled(true)
  assert.ok(f.ssr.collection)
  assert.equal(f.ssr.error, null)
  f.ssr.destroy()
})

test('own execution errors restore viewport and release output but native errors propagate', () => {
  const f = fixture(); f.ssr.setEnabled(true)
  f.ssr.collection.execute = context => { context.uniformState.viewport.width = 1; throw new Error('SSR draw failed') }
  f.execute('original')
  assert.deepEqual(f.events, [['tone', 'original']])
  assert.equal(f.scene.context.uniformState.viewport.width, 64)
  assert.match(f.ssr.error, /SSR draw failed/)
  assert.equal(f.ssr.getDiagnostics().bytes, 0)
  f.ssr.destroy()
  const g = fixture()
  g.native.execute = () => { throw new Error('native failed') }
  g.ssr.setEnabled(true)
  assert.throws(() => g.execute('HDR'), /native failed/)
  assert.equal(g.ssr.failed, false)
  g.ssr.destroy()
})

test('unsupported contexts allocate nothing and supported float fallback uses RGBA32F trace', () => {
  const f = fixture()
  f.ssr.destroy()
  f.scene.context.webgl2 = false
  const unsupported = new ScreenSpaceReflection143(f.C, f.scene, () => f.source, () => ({}))
  unsupported.setEnabled(true)
  assert.equal(unsupported.getDiagnostics().supported, false)
  assert.equal(unsupported.collection, undefined)
  unsupported.destroy()
  const g = fixture(); g.scene.context.halfFloatingPointTexture = false
  g.ssr.setEnabled(true)
  assert.equal(g.ssr.stages.trace.pixelDatatype, Cesium.PixelDatatype.FLOAT)
  g.ssr.destroy()
})

test('real Cesium composite owns two stages and named resolve dependency without native registration', () => {
  const f = fixture(true); f.ssr.setEnabled(true)
  assert.equal(f.ssr.composite.length, 2)
  assert.equal(f.ssr.collection.length, 1)
  assert.equal(f.ssr.collection._tonemapping.enabled, false)
  assert.equal(f.ssr.collection._autoExposureEnabled, false)
  assert.equal(f.ssr.stages.resolve.uniforms.u_reflection, f.ssr.stages.trace.name)
  f.ssr.destroy()
})

function addUniformBufferGl(context) {
  let generic = null
  const indexed = new Map(), buffers = [], uploads = []
  const previousGet = context._gl.getParameter
  Object.assign(context._gl, {
    UNIFORM_BUFFER: 0x8a11, UNIFORM_BUFFER_BINDING: 0x8a28, DYNAMIC_DRAW: 0x88e8,
    UNIFORM_BUFFER_START: 0x8a29, UNIFORM_BUFFER_SIZE: 0x8a2a,
    MAX_UNIFORM_BUFFER_BINDINGS: 0x8a2f, MAX_UNIFORM_BLOCK_SIZE: 0x8a30,
    UNIFORM_BLOCK_DATA_SIZE: 0x8a40, UNIFORM_BLOCK_BINDING: 0x8a3f, ACTIVE_UNIFORM_BLOCKS: 0x8a36, INVALID_INDEX: 0xffffffff,
    createBuffer() { const value = { deleted: 0 }; buffers.push(value); return value },
    bindBuffer(target, value) { generic = value },
    bufferData(target, size) { generic.bytes = new Uint8Array(size) },
    bufferSubData(target, offset, value) { generic.bytes.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength), offset); uploads.push(generic) },
    deleteBuffer(value) { value.deleted++ },
    getParameter(name) {
      if (name === this.UNIFORM_BUFFER_BINDING) return generic
      if (name === this.MAX_UNIFORM_BUFFER_BINDINGS) return 24
      if (name === this.MAX_UNIFORM_BLOCK_SIZE) return 65536
      return previousGet(name)
    },
    getIndexedParameter(target, index) { return target === this.UNIFORM_BUFFER_BINDING ? indexed.get(index) || null : 0 },
    bindBufferBase(target, index, value) { indexed.set(index, value); generic = value },
    bindBufferRange(target, index, value) { indexed.set(index, value); generic = value },
    getUniformBlockIndex(program, name) { return name === 'CampusCamera' ? 0 : 1 },
    getProgramParameter() { return 2 },
    getActiveUniformBlockParameter(program, index, parameter) { return parameter === this.UNIFORM_BLOCK_BINDING ? 0 : index === 0 ? 160 : 16 },
    uniformBlockBinding() {}
  })
  return { buffers, uploads, active: () => [...indexed.values()].filter(Boolean), generic: () => generic }
}

test('SSR UBO path shares the camera with transparent reflections and keeps independent 16-byte parameters', () => {
  const f = fixture(), gpu = addUniformBufferGl(f.scene.context)
  Object.assign(f.scene, { drawingBufferWidth: 64, drawingBufferHeight: 64, _environmentState: {}, _view: { frustumCommandsList: [] } })
  f.scene.context.floatBlend = true
  f.scene.frameState.passes = { render: true }
  f.materials.opaqueColor = {}
  f.source.getOpaqueColorDiagnostics = () => ({ valid: true })
  const transparent = new TransparentReflection143(f.C, f.scene, () => f.source, () => f.settings)
  f.ssr.setEnabled(true); transparent.setEnabled(true)
  assert.ok(f.ssr.cameraUniforms, 'supported GL must acquire camera uniforms')
  assert.equal(f.ssr.cameraUniforms.buffer, transparent.cameraUniforms.buffer)
  assert.notEqual(f.ssr.reflectionUniforms, transparent.reflectionUniforms)
  assert.deepEqual(gpu.buffers.map(buffer => buffer.bytes.length).sort((a, b) => a - b), [16, 16, 160])
  assert.match(f.ssr.stages.trace.fragmentShader, /#define CAMPUS_REFLECTION_UBO/)
  const execute = f.ssr.collection.execute.bind(f.ssr.collection)
  f.ssr.collection.execute = (...args) => {
    assert.deepEqual(gpu.active().map(buffer => buffer.bytes.length).sort((a, b) => a - b), [16, 160])
    execute(...args)
  }
  f.execute('HDR')
  const params = gpu.buffers.find(buffer => buffer.bytes.length === 16 && new Float32Array(buffer.bytes.buffer)[0] === 150)
  assert.deepEqual(Array.from(new Float32Array(params.bytes.buffer)), [150, .5, 1, 2])
  assert.equal(gpu.uploads.length, 2)
  f.execute('HDR'); assert.equal(gpu.uploads.length, 2, 'unchanged parameters and camera do not upload')
  f.settings.screenSpaceReflectionStrength = .25
  f.execute('HDR'); assert.equal(gpu.uploads.length, 3)
  assert.deepEqual(gpu.active(), [])
  assert.equal(gpu.generic(), null)
  assert.equal(f.ssr.getDiagnostics().uniformBuffers.camera.bytes, 160)
  assert.equal(f.ssr.getDiagnostics().uniformBuffers.reflection.bytes, 16)
  const camera = gpu.buffers.find(buffer => buffer.bytes.length === 160)
  f.ssr.destroy(); assert.equal(camera.deleted, 0)
  transparent.destroy(); assert.equal(camera.deleted, 1)
  assert.ok(gpu.buffers.every(buffer => buffer.deleted === 1))
})

test('legacy SSR uniforms remain active without full GL uniform-block support', () => {
  const f = fixture(); f.ssr.setEnabled(true)
  assert.doesNotMatch(f.ssr.stages.trace.fragmentShader, /^#define CAMPUS_REFLECTION_UBO/m)
  assert.equal(f.ssr.cameraUniforms, undefined)
  f.execute('HDR')
  assert.equal(f.ssr.stages.trace.uniforms.u_distance(), 150)
  f.ssr.destroy()
})

test('both reflection classes retain ordinary uniforms when any required UBO operation is unavailable', () => {
  for (const missing of ['getProgramParameter', 'bindBufferRange', 'getParameter', 'bindBuffer', 'bufferData', 'bufferSubData', 'deleteBuffer']) {
    const f = fixture(), gpu = addUniformBufferGl(f.scene.context)
    f.scene.context.floatBlend = true
    delete f.scene.context._gl[missing]
    const transparent = new TransparentReflection143(f.C, f.scene, () => f.source, () => f.settings)
    f.ssr.setEnabled(true); transparent.setEnabled(true)
    assert.equal(gpu.buffers.length, 0, `${missing} must select the ordinary uniform path before allocation`)
    assert.equal(f.ssr.enabled, true)
    assert.equal(transparent.enabled, true)
    assert.doesNotMatch(f.ssr.stages.trace.fragmentShader, /^#define CAMPUS_REFLECTION_UBO/m)
    f.ssr.destroy(); transparent.destroy()
  }
})
