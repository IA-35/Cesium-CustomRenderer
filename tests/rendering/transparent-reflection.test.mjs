import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import TransparentReflection143 from '../../src/reflections/TransparentReflection143.js'
import { registerHdrEffect } from '../../src/environment/HdrCoordinator143.js'
const Cesium = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')

test('each replay command keeps its original strict or inclusive opaque comparison', () => {
  const f = fixture()
  const near = f.scene._view.frustumCommandsList[0].commands[f.C.Pass.TRANSLUCENT][0]
  near.renderState.depthTest.func = f.C.DepthFunction.LESS_OR_EQUAL
  f.pass.setEnabled(true); f.execute()
  const draws = f.events.filter(event => event[0] === 'draw')
  assert.equal(draws[0][2].uniformMap.campus_transparentStrictDepth(), true)
  assert.equal(draws.at(-1)[2].uniformMap.campus_transparentStrictDepth(), false)
  f.pass.destroy()
})

function fixture() {
  const events = [], textures = [], programs = [], states = [], bindings = []
  class Resource {
    constructor(options = {}) { Object.assign(this, options); this.status = 1 }
    destroy() { this.destroyed = true }
    isDestroyed() { return !!this.destroyed }
  }
  class Texture extends Resource { constructor(options) { super(options); this.sizeInBytes = this.width * this.height * 16; textures.push(this) } }
  const C = { ...Cesium, Texture, Framebuffer: Resource,
    ShaderProgram: { fromCache(options) { const value = new Resource(options); programs.push(value); return value } },
    RenderState: { getState: state => structuredClone(state), fromCache(options) { states.push(options); return options }, removeFromCache() {} },
    DrawCommand: { shallowClone: command => ({ ...command, execute(context) {
      events.push(['draw', this.label, this, context.uniformState.frustumNear]); context._currentFramebuffer = this.framebuffer
      if (this.fail) throw new Error('draw failed')
    } }) },
    ClearCommand: class extends Resource { execute() { events.push(['clear']) } } }
  const uniforms = { viewport: new C.BoundingRectangle(3, 4, 64, 64), pass: 17,
    updateCamera() {}, updateFrustum(frustum) { this.frustumNear = frustum.near }, updatePass(value) { this.pass = value } }
  const context = { webgl2: true, depthTexture: true, floatingPointTexture: true, colorBufferFloat: true, floatBlend: true,
    uniformState: uniforms, _currentFramebuffer: 'native-cache',
    _gl: { isContextLost: () => false, FRAMEBUFFER_COMPLETE: 1, READ_FRAMEBUFFER_BINDING: 2, DRAW_FRAMEBUFFER_BINDING: 3,
      READ_FRAMEBUFFER: 4, DRAW_FRAMEBUFFER: 5, getParameter: value => value, bindFramebuffer: (...args) => bindings.push(args) },
    createViewportQuadCommand(shader, options) {
      const shaderProgram = new Resource(); programs.push(shaderProgram)
      return { ...options, shader, shaderProgram, execute(c) { events.push(['resolve', this]); c._currentFramebuffer = this.framebuffer } }
    } }
  const native = { execute(c, color) { events.push(['native', color]); return 'native' } }
  const scene = { context, drawingBufferWidth: 64, drawingBufferHeight: 64,
    camera: { frustum: new C.PerspectiveFrustum({ fov: Math.PI / 3, aspectRatio: 1, near: 1, far: 1000 }) },
    highDynamicRange: true, frameState: { frameNumber: 1, useLogDepth: true, passes: { render: true } },
    _environmentState: { useOIT: false }, _view: { frustumCommandsList: [] }, postProcessStages: native,
    requestRender() {}, isDestroyed: () => false }
  const materials = Object.fromEntries(['eyeDepth', 'normalRoughMetal', 'emissiveFlags', 'transparency', 'reflectionSpecular', 'reflectionResponse', 'opaqueColor'].map(key => [key, {}]))
  const levels = [{ texture: {} }]
  const source = { getTextures: () => materials, getDepthPyramidLevels: () => levels, getOpaqueColorDiagnostics: () => ({ valid: true }) }
  const settings = {}, input = { width: 64, height: 64 }
  let nextId = 0
  const command = label => ({ label, pass: C.Pass.TRANSLUCENT, uniformMap: { original: () => label },
    shaderProgram: { id: ++nextId, _attributeLocations: { position: 0 },
      vertexShaderSource: new C.ShaderSource({ sources: ['void main(){gl_Position=vec4(1.0);}'] }),
      fragmentShaderSource: new C.ShaderSource({ sources: ['void main(){out_FragColor=vec4(1.0);}'] }) },
    renderState: { id: nextId, depthTest: { enabled: true, func: C.DepthFunction.LESS }, depthMask: false,
      blending: { ...C.BlendingState.ALPHA_BLEND }, colorMask: { red: true, green: true, blue: true, alpha: true }, stencilTest: { enabled: false },
      cull: { enabled: true }, scissorTest: { enabled: true, rectangle: { x: 1, y: 2, width: 3, height: 4 } } } })
  const bin = (near, far, commands) => ({ near, far, commands: { [C.Pass.TRANSLUCENT]: commands }, indices: { [C.Pass.TRANSLUCENT]: commands.length } })
  scene._view.frustumCommandsList = [bin(1, 10, [command('near')]), bin(10, 100, [command('far-a'), command('far-b')])]
  return { C, scene, native, source, settings, materials, levels, events, textures, programs, states, bindings, input, command,
    pass: new TransparentReflection143(C, scene, () => source, () => settings), execute: () => native.execute(context, input, 'depth', 'id') }
}

test('transparent replay preserves native sorted order, far-to-near bins, state and current-frame output', () => {
  const f = fixture(), original = f.native.execute
  assert.equal(f.pass.getDiagnostics().bytes, 0)
  f.pass.setEnabled(true); assert.equal(f.execute(), 'native')
  const draws = f.events.filter(event => event[0] === 'draw')
  assert.deepEqual(draws.map(event => [event[1], event[3]]), [['far-a', 10], ['far-b', 10], ['near', 1]])
  const derived = draws[0][2]
  assert.equal(derived.renderState.depthTest.enabled, false)
  assert.equal(derived.renderState.depthMask, false)
  assert.equal(derived.renderState.stencilTest.enabled, false)
  assert.equal(derived.renderState.cull.enabled, true)
  assert.equal(derived.renderState.scissorTest.enabled, true)
  assert.equal(derived.renderState.blending.functionSourceRgb, f.C.BlendFunction.SOURCE_ALPHA)
  assert.equal(derived.renderState.blending.functionDestinationRgb, f.C.BlendFunction.ONE_MINUS_SOURCE_ALPHA)
  assert.equal(derived.uniformMap.original(), 'far-a')
  assert.equal(derived.uniformMap.u_sourceColor(), f.materials.opaqueColor)
  assert.equal(derived.uniformMap.u_hiz4(), f.levels[0].texture)
  assert.equal(f.scene.context.uniformState.pass, 17)
  assert.equal(f.scene.context.uniformState.frustumNear, 1)
  assert.deepEqual(f.scene.context.uniformState.viewport, new f.C.BoundingRectangle(3, 4, 64, 64))
  assert.equal(f.scene.context._currentFramebuffer, 'native-cache')
  assert.deepEqual(f.bindings.slice(-2), [[4, 2], [5, 3]])
  assert.ok(f.pass.getDeltaTexture())
  assert.equal(f.pass.getDiagnostics().bytes, 64 * 64 * 32)
  f.scene.frameState.frameNumber++
  assert.equal(f.pass.getDeltaTexture(), null)
  f.pass.destroy(); f.pass.destroy()
  assert.equal(f.native.execute, original)
  assert.ok(f.textures.every(texture => texture.destroyed))
  assert.ok(f.programs.every(program => program.destroyed))
})

test('all commands are preflighted so an unsupported front layer bypasses the whole transparent pass', () => {
  for (const change of [command => { command.uniformMap.u_isEdgePass = () => true },
    command => { command.renderState.stencilTest = { enabled: true, frontFunction: 1, backFunction: 1 } },
    command => { command.shaderProgram.fragmentShaderSource.defines.push('OIT') }]) {
    const f = fixture(); change(f.scene._view.frustumCommandsList[0].commands[f.C.Pass.TRANSLUCENT][0])
    f.pass.setEnabled(true); f.execute()
    assert.deepEqual(f.events, [['native', f.input]])
    assert.equal(f.pass.failed, false)
    assert.equal(f.pass.getDeltaTexture(), null)
    f.pass.destroy()
  }
})

test('uses raw log-depth HDR shader instead of native OIT derived shader and caches by mode', () => {
  const f = fixture(), raw = f.scene._view.frustumCommandsList[0].commands[f.C.Pass.TRANSLUCENT][0]
  const hdr = f.command('hdr'), log = f.command('log')
  raw.derivedCommands = { logDepth: { command: log }, oit: { command: f.command('wrong') } }
  log.derivedCommands = { hdr: { command: hdr } }
  f.pass.setEnabled(true); f.execute()
  assert.equal(f.events.filter(event => event[0] === 'draw').at(-1)[1], 'hdr')
  const sortedPrograms = [...f.pass.programs.keys()]
  const accum = {}, reveal = {}
  f.scene._environmentState.useOIT = true
  f.scene._view.oit = { _accumulationTexture: accum, _revealageTexture: reveal, _translucentMRTSupport: true }
  f.events.length = 0; f.execute()
  assert.ok([...f.pass.programs.keys()].some(key => !sortedPrograms.includes(key)))
  const draw = f.events.find(event => event[0] === 'draw')[2]
  assert.equal(draw.renderState.blending.functionSourceRgb, f.C.BlendFunction.ONE)
  assert.equal(draw.renderState.blending.functionDestinationRgb, f.C.BlendFunction.ONE)
  const resolve = f.events.find(event => event[0] === 'resolve')[1]
  assert.equal(resolve.uniformMap.u_accumulation(), accum)
  assert.equal(resolve.uniformMap.u_revealage(), reveal)
  assert.equal(resolve.uniformMap.u_oit(), true)
  assert.equal(resolve.uniformMap.u_mrt(), true)
  assert.match(resolve.shader, /u_mrt \? revealage : accumulation.a/)
  assert.match(resolve.shader, /u_mrt \? accumulation.a : revealage/)
  assert.match(resolve.shader, /\(1.0 - transparency\) \/ clamp\(denominator, 1.0e-4, 5.0e4\)/)
  assert.match(resolve.shader, /vec4\(color.rgb \+ delta \* factor, color.a\)/)
  const combined = new Cesium.ShaderSource({ sources: [resolve.shader] }).createCombinedFragmentShader({ webgl2: true })
  assert.match(combined, /out vec4 out_FragColor/)
  f.scene._view.oit._translucentMRTSupport = false
  assert.equal(resolve.uniformMap.u_mrt(), false)
  f.pass.destroy()
})

test('current shared opaque color and Hi-Z, float blend and color-render scope are mandatory', () => {
  for (const change of [f => { f.source.getOpaqueColorDiagnostics = () => ({ valid: false }) },
    f => { f.source.getTextures = () => null }, f => { f.source.getDepthPyramidLevels = () => [] },
    f => { f.scene.frameState.passes.pick = true }, f => { f.scene.highDynamicRange = false },
    f => { f.scene.camera.frustum.xOffset = 1 }, f => { f.scene._environmentState.useOIT = true }]) {
    const f = fixture(); f.pass.setEnabled(true); change(f); f.execute()
    assert.deepEqual(f.events, [['native', f.input]])
    assert.equal(f.pass.getDeltaTexture(), null); f.pass.destroy()
  }
  const f = fixture(); f.scene.context.floatBlend = false
  const pass = new TransparentReflection143(f.C, f.scene, () => f.source, () => ({}))
  pass.setEnabled(true); assert.equal(pass.getDiagnostics().supported, false); assert.equal(f.textures.length, 0)
  pass.destroy(); f.pass.destroy()
})

test('draw failure restores state, releases resources and only retries after disable', () => {
  const f = fixture(), original = f.native.execute
  f.scene._view.frustumCommandsList[1].commands[f.C.Pass.TRANSLUCENT][0].fail = true
  f.pass.setEnabled(true); f.execute()
  assert.equal(f.events.at(-1)[1], f.input)
  assert.equal(f.pass.failed, true)
  assert.equal(f.native.execute, original)
  assert.equal(f.scene.context._currentFramebuffer, 'native-cache')
  assert.equal(f.pass.getDiagnostics().bytes, 0)
  f.pass.setEnabled(true); assert.equal(f.pass.enabled, false)
  f.pass.setEnabled(false); f.pass.setEnabled(true); assert.equal(f.pass.enabled, true)
  f.pass.destroy()
})

test('resize frees both old targets; HDR ordering and foreign wrappers survive release', () => {
  const f = fixture()
  const removeAo = registerHdrEffect(f.scene, 10, (c, color) => { f.events.push(['ao']); return color })
  const removeOpaque = registerHdrEffect(f.scene, 5, (c, color) => { f.events.push(['opaque']); return color })
  f.pass.setEnabled(true); f.execute()
  assert.deepEqual(f.events.filter(e => ['opaque', 'resolve', 'ao', 'native'].includes(e[0])).map(e => e[0]), ['opaque', 'resolve', 'ao', 'native'])
  const old = [...f.textures]
  f.scene.drawingBufferWidth = f.input.width = 80
  f.execute(); assert.ok(old.every(texture => texture.destroyed))
  assert.equal(f.pass.getDiagnostics().bytes, 80 * 64 * 32)
  const hook = f.native.execute, foreign = function(...args) { return hook.apply(this, args) }
  f.native.execute = foreign
  f.pass.destroy(); removeAo(); removeOpaque()
  assert.equal(f.native.execute, foreign)
})

test('incomplete target allocation releases partial textures and restores framebuffer bindings', () => {
  const f = fixture(), Framebuffer = f.C.Framebuffer
  f.C.Framebuffer = class extends Framebuffer { constructor(options) { super(options); this.status = 9 } }
  f.pass.setEnabled(true); f.execute()
  assert.equal(f.pass.failed, true)
  assert.match(f.pass.error, /incomplete/)
  assert.ok(f.textures.every(texture => texture.destroyed))
  assert.deepEqual(f.events, [['native', f.input]])
  assert.deepEqual(f.bindings.slice(-2), [[4, 2], [5, 3]])
  assert.equal(f.scene.context._currentFramebuffer, 'native-cache')
  f.pass.destroy()
})

test('input/output feedback bypasses without drawing and native exceptions are not owned failures', () => {
  const f = fixture(); f.pass.setEnabled(true); f.execute()
  f.events.length = 0
  const feedback = f.pass.target.output
  assert.equal(f.pass._execute(f.scene.context, feedback), feedback)
  assert.deepEqual(f.events, [])
  assert.match(f.pass.reason, /feedback/)
  assert.equal(f.pass.getDeltaTexture(), null)
  f.pass.destroy()
  const g = fixture()
  g.native.execute = () => { throw new Error('native failure') }
  g.pass.setEnabled(true)
  assert.throws(g.execute, /native failure/)
  assert.equal(g.pass.failed, false)
  g.pass.destroy()
})

test('compiled programs unused for 120 frames are released without discarding current programs', () => {
  const f = fixture(); f.pass.setEnabled(true); f.execute()
  const old = [...f.pass.programs.values()].map(record => record.program)
  f.scene.frameState.frameNumber = 122
  const bin = f.scene._view.frustumCommandsList[0]
  bin.commands[f.C.Pass.TRANSLUCENT] = [f.command('new')]
  f.scene._view.frustumCommandsList.length = 1
  f.execute()
  assert.ok(old.every(program => program.destroyed))
  assert.equal(f.pass.programs.size, 1)
  assert.equal([...f.pass.programs.values()][0].program.destroyed, undefined)
  f.pass.destroy()
})

test('additive or nonstandard sorted front layers bypass all deltas before any back layer draws', () => {
  for (const change of [state => { state.blending.functionDestinationRgb = Cesium.BlendFunction.ONE },
    state => { state.blending.functionSourceRgb = Cesium.BlendFunction.ONE },
    state => { state.blending.equationRgb = Cesium.BlendEquation.SUBTRACT },
    state => { state.blending.enabled = false }]) {
    const f = fixture(), front = f.scene._view.frustumCommandsList[0].commands[f.C.Pass.TRANSLUCENT][0]
    change(front.renderState)
    f.pass.setEnabled(true); f.execute()
    assert.deepEqual(f.events.map(event => event[0]), ['native'], 'unsupported front layer must not erase or expose a back delta')
    assert.equal(f.events[0][1], f.input)
    assert.equal(f.pass.failed, false)
    assert.match(f.pass.reason, /blend/i)
    assert.equal(f.pass.getDeltaTexture(), null)
    f.pass.destroy()
  }
})

test('sorted and OIT reject disabled/special depth tests, depth writes and masked color channels', () => {
  for (const mode of ['sorted', 'oit']) for (const change of [state => { state.depthTest.enabled = false },
    state => { state.depthTest.func = Cesium.DepthFunction.ALWAYS },
    state => { state.depthTest.func = Cesium.DepthFunction.GREATER }, state => { state.depthMask = true },
    ...['red', 'green', 'blue', 'alpha'].map(channel => state => { state.colorMask[channel] = false })]) {
    const f = fixture(), front = f.scene._view.frustumCommandsList[0].commands[f.C.Pass.TRANSLUCENT][0]
    if (mode === 'oit') {
      f.scene._environmentState.useOIT = true
      f.scene._view.oit = { _accumulationTexture: {}, _revealageTexture: {}, _translucentMRTSupport: true }
    }
    change(front.renderState)
    f.pass.setEnabled(true); f.execute()
    assert.deepEqual(f.events.map(event => event[0]), ['native'])
    assert.equal(f.events[0][1], f.input)
    assert.equal(f.pass.failed, false)
    assert.match(f.pass.reason, /depth|mask/i)
    f.pass.destroy()
  }
})

test('native Cesium model alpha pipeline state is supported with LESS or LESS_OR_EQUAL', () => {
  for (const func of [Cesium.DepthFunction.LESS, Cesium.DepthFunction.LESS_OR_EQUAL]) {
    const f = fixture(), resources = { alphaOptions: { pass: Cesium.Pass.TRANSLUCENT }, model: {}, uniformMap: {},
      renderStateOptions: { cull: { enabled: true }, depthTest: { enabled: true, func } } }
    Cesium.AlphaPipelineStage.process(resources)
    const state = Cesium.RenderState.getState(Cesium.RenderState.fromCache(resources.renderStateOptions))
    assert.equal(state.depthMask, false)
    assert.equal(state.blending.functionSourceRgb, Cesium.BlendFunction.SOURCE_ALPHA)
    assert.equal(state.blending.functionSourceAlpha, Cesium.BlendFunction.ONE)
    const front = f.scene._view.frustumCommandsList[0].commands[f.C.Pass.TRANSLUCENT][0]
    front.renderState = { ...state, id: front.renderState.id }
    f.pass.setEnabled(true); f.execute()
    assert.ok(f.pass.getDeltaTexture())
    f.pass.destroy()
  }
})

test('sorted source alpha attachment factors do not restrict supported native RGB blending', () => {
  const f = fixture(), front = f.scene._view.frustumCommandsList[0].commands[f.C.Pass.TRANSLUCENT][0]
  front.renderState.blending.functionSourceAlpha = Cesium.BlendFunction.SOURCE_ALPHA
  front.renderState.blending.functionDestinationAlpha = Cesium.BlendFunction.ZERO
  front.renderState.blending.equationAlpha = Cesium.BlendEquation.SUBTRACT
  f.pass.setEnabled(true); f.execute()
  assert.ok(f.pass.getDeltaTexture())
  f.pass.destroy()
})

test('transparent UBO data binds across the complete replay, skips unchanged uploads and restores on draw failure', () => {
  const f = fixture(), gl = f.scene.context._gl, previousGet = gl.getParameter
  for (const bin of f.scene._view.frustumCommandsList) for (const command of bin.commands[f.C.Pass.TRANSLUCENT]) {
    command.shaderProgram.vertexShaderSource = new Cesium.ShaderSource({ sources: [Cesium._shadersModelVS] })
    command.shaderProgram.fragmentShaderSource = new Cesium.ShaderSource({
      defines: ['HDR', 'LIGHTING_PBR', 'HAS_NORMALS', 'SPECULAR_IBL', 'USE_IBL_LIGHTING', 'ALPHA_MODE_BLEND'],
      sources: [Cesium._shadersMaterialStageFS, Cesium._shadersImageBasedLightingStageFS, Cesium._shadersLightingStageFS, Cesium._shadersModelFS] })
  }
  let generic = null
  const indexed = new Map(), buffers = [], uploads = []
  Object.assign(gl, {
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
    getActiveUniformBlockParameter(program, index, parameter) { return parameter === this.UNIFORM_BLOCK_BINDING ? 0 : index === 0 ? 160 : 16 }, uniformBlockBinding() {}
  })
  const compile = f.C.ShaderProgram.fromCache
  f.C.ShaderProgram.fromCache = options => Object.assign(compile(options), { _program: {}, allUniforms: {} })
  const clone = f.C.DrawCommand.shallowClone
  f.C.DrawCommand.shallowClone = command => {
    const derived = clone(command), execute = derived.execute
    derived.execute = function(...args) {
      assert.deepEqual([...indexed.values()].filter(Boolean).map(buffer => buffer.bytes.length).sort((a, b) => a - b), [16, 160])
      return execute.apply(this, args)
    }
    return derived
  }
  f.pass.setEnabled(true)
  assert.ok(f.pass.cameraUniforms, 'supported GL must acquire transparent camera uniforms')
  f.execute()
  assert.equal(f.pass.failed, false)
  assert.equal(uploads.length, 2)
  for (const record of f.pass.programs.values()) {
    assert.ok(record.program.fragmentShaderSource.defines.includes('CAMPUS_REFLECTION_UBO'))
    const source = record.program.fragmentShaderSource.sources.join('\n')
    assert.match(source, /uniform CampusCamera/)
    assert.match(source, /uniform CampusReflection/)
  }
  const params = buffers.find(buffer => buffer.bytes.length === 16)
  assert.deepEqual(Array.from(new Float32Array(params.bytes.buffer)), [150, .5, 1, 1])
  f.execute(); assert.equal(uploads.length, 2)
  f.scene.camera.frustum.near = 2
  f.execute(); assert.equal(uploads.length, 3)
  assert.equal(f.pass.getDiagnostics().uniformBuffers.reflection.bytes, 16)
  f.scene._view.frustumCommandsList[1].commands[f.C.Pass.TRANSLUCENT][0].fail = true
  f.execute()
  assert.equal(f.pass.failed, true)
  assert.deepEqual([...indexed.values()].filter(Boolean), [])
  assert.equal(generic, null)
  assert.ok(buffers.every(buffer => buffer.deleted === 1))
  f.pass.destroy()
})
