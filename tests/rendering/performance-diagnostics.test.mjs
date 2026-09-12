import test from 'node:test'
import assert from 'node:assert/strict'
import SampleGuard from '../../src/diagnostics/SampleGuard.js'
import GpuTimer from '../../src/diagnostics/GpuTimer.js'
import RenderProfiler143 from '../../src/diagnostics/RenderProfiler143.js'

test('sampling rejects transient camera/configuration changes even after restoration', () => {
  const state = { camera: [1, 2, 3], options: { aa: 'smaa' } }
  const guard = new SampleGuard(state)
  guard.observe(state)
  state.camera[0] = 9
  guard.observe(state)
  state.camera[0] = 1
  guard.observe(state)
  assert.equal(guard.valid, false)
  assert.deepEqual(guard.changedFields, ['camera'])
  state.options.aa = 'fxaa'
  guard.observe(state)
  assert.deepEqual(guard.changedFields, ['camera', 'options'])
})

function fixture() {
  const ext = { TIME_ELAPSED_EXT: 1, GPU_DISJOINT_EXT: 2 }
  const queries = [], deleted = []
  const gl = {
    QUERY_RESULT_AVAILABLE: 3, QUERY_RESULT: 4, CURRENT_QUERY: 5,
    disjoint: false, lost: false, current: null,
    getExtension: () => ext, isContextLost() { return this.lost },
    getParameter() { return this.disjoint },
    getQuery() { return this.current },
    createQuery() { const q = { ready: false, ns: 2500000 }; queries.push(q); return q },
    beginQuery(target, q) { assert.equal(this.current, null); this.current = q },
    endQuery() { this.current = null },
    getQueryParameter(q, name) { if (name === 3) return q.ready; assert.ok(q.ready); return q.ns },
    deleteQuery(q) { deleted.push(q) }
  }
  return { gl, queries, deleted, timer: new GpuTimer(gl) }
}

test('GPU queries are asynchronous, preserve callback results and release completed queries', () => {
  const { timer, queries, deleted } = fixture()
  assert.equal(timer.measure('shadow', () => 42), 42)
  timer.poll()
  assert.deepEqual(timer.samples, [])
  queries[0].ready = true
  timer.poll()
  assert.deepEqual(timer.samples, [{ label: 'shadow', milliseconds: 2.5 }])
  assert.equal(deleted.length, 1)
})

test('disjoint invalidates all outstanding queries and does not report misleading timings', () => {
  const { timer, gl, queries, deleted } = fixture()
  timer.measure('one', () => {})
  timer.measure('two', () => {})
  queries[0].ready = true
  gl.disjoint = true
  timer.poll()
  assert.equal(timer.samples.length, 0)
  assert.equal(deleted.length, 2)
  assert.equal(timer.discarded, 2)
})

test('nested/foreign queries are untouched; thrown draws end and discard only owned queries', () => {
  const { timer, gl, queries, deleted } = fixture()
  timer.measure('outer', () => timer.measure('inner', () => {}))
  assert.equal(queries.length, 1)
  gl.current = { foreign: true }
  timer.measure('foreign', () => 12)
  assert.deepEqual(gl.current, { foreign: true })
  gl.current = null
  assert.throws(() => timer.measure('failure', () => { throw new Error('draw failed') }), /draw failed/)
  assert.equal(gl.current, null)
  assert.equal(deleted.length, 1)
  timer.destroy(); timer.destroy()
  assert.equal(deleted.length, 2)
})

test('pending GPU queries are bounded and unsupported/context-lost timers still execute draws', () => {
  const { timer, gl, queries } = fixture()
  for (let i = 0; i < 100; i++) timer.measure('frame', () => {})
  assert.ok(queries.length <= 32)
  gl.lost = true
  assert.equal(timer.measure('lost', () => 7), 7)
  timer.poll()
  assert.equal(timer.samples.length, 0)
  const unsupported = new GpuTimer({ getExtension: () => null })
  assert.equal(unsupported.supported, false)
  assert.equal(unsupported.measure('unsupported', () => 9), 9)
  timer.destroy()
})

test('profiler records real draw submissions and restores hooks without overwriting later owners', () => {
  const { gl } = fixture()
  const context = { _gl: gl, draw() { return 17 } }
  const scene = { context, frameState: { commandList: [1, 2] },
    render() { context.draw(); context.draw(); return 23 } }
  const pipeline = { viewer: { scene } }
  const originalRender = scene.render, originalDraw = context.draw
  const profiler = new RenderProfiler143({ VERSION: '1.143' }, pipeline)
  assert.equal(scene.render(), 23)
  assert.equal(profiler.frames[0].drawCalls, 2)
  assert.equal(profiler.frames[0].submittedCommands, 2)
  const previous = scene.render
  scene.render = function() { return previous.apply(this, arguments) }
  const foreign = scene.render
  profiler.destroy(); profiler.destroy()
  assert.equal(scene.render, foreign)
  assert.equal(context.draw, originalDraw)
  scene.render()
  assert.equal(profiler.frames.length, 1)
  scene.render = originalRender
})

test('profiler alternates whole-frame and pass timings without nested elapsed queries', () => {
  const { gl, queries } = fixture()
  const shadow = { render() {} }, hdr = { _execute() {} }, smaa = { _execute() {} }
  const scene = { context: { _gl: gl, draw() {} }, frameState: { commandList: [] },
    render() { shadow.render(); hdr._execute(); smaa._execute() } }
  const p = new RenderProfiler143({ VERSION: '1.143' }, {
    viewer: { scene }, customShadow: shadow, environmentRenderer: { hdr }, smaa
  })
  for (let i = 0; i < 8; i++) { scene.render(); queries.forEach(q => { q.ready = true }) }
  p.timer.poll()
  assert.deepEqual([...new Set(p.timer.samples.map(s => s.label))], ['frame', 'shadow', 'environment', 'smaa'])
  assert.equal(p.timer.samples.length, 8)
  p.destroy()
})

test('texture inventory deduplicates aliases, excludes destroyed resources, and retains the observed peak', () => {
  const { gl } = fixture()
  const texture = { width: 4, height: 4, sizeInBytes: 64, isDestroyed: () => false }
  const scene = { context: { _gl: gl, draw() {} }, frameState: { commandList: [] }, render() {} }
  const pipeline = { viewer: { scene }, color: { outputTexture: texture, isDestroyed: () => false },
    smaa: { _execute() {}, areaTexture: texture,
      searchTexture: { sizeInBytes: 500, isDestroyed: () => true } } }
  const p = new RenderProfiler143({ VERSION: '1.143' }, pipeline)
  scene.render()
  assert.equal(p.getReport().textures.currentBytes, 64)
  pipeline.color.outputTexture = undefined
  pipeline.smaa.areaTexture = undefined
  scene.render()
  assert.equal(p.getReport().textures.currentBytes, 0)
  assert.equal(p.getReport().textures.peakBytes, 64)
  p.destroy()
})

test('profiler includes enabled material replay and all five owned MRT textures', () => {
  const { gl, queries } = fixture()
  const texture = { width: 4, height: 4, sizeInBytes: 64, isDestroyed: () => false }
  const materialChannels = { _render() {}, target: { normalRoughMetal: texture,
    emissiveFlags: { ...texture, sizeInBytes: 128 }, eyeDepth: { ...texture }, depthStencil: { ...texture }, transparency: { ...texture, sizeInBytes: 16 } } }
  const scene = { context: { _gl: gl, draw() {} }, frameState: { commandList: [] }, render() { materialChannels._render() } }
  const p = new RenderProfiler143({ VERSION: '1.143' }, { viewer: { scene }, materialChannels })
  for (let i = 0; i < 4; i++) { scene.render(); queries.forEach(q => { q.ready = true }) }
  const report = p.getReport()
  assert.ok(report.gpu.some(sample => sample.label === 'materials'))
  assert.equal(report.textures.currentBytes, 336)
  p.destroy()
})

test('profiler counts the albedo attachment once and excludes released storage', () => {
  const { gl } = fixture()
  const albedo = { width: 4, height: 4, sizeInBytes: 128, isDestroyed: () => false }
  const materialChannels = { _render() {}, target: { albedoOcclusion: albedo } }
  const scene = { context: { _gl: gl, draw() {} }, frameState: { commandList: [] }, render() {} }
  const pipeline = { viewer: { scene }, materialChannels, color: { outputTexture: albedo, isDestroyed: () => false } }
  const p = new RenderProfiler143({ VERSION: '1.143' }, pipeline)
  scene.render()
  assert.equal(p.getReport().textures.currentBytes, 128)
  assert.deepEqual(p.getReport().textures.entries.map(entry => entry.name), ['materials.albedoOcclusion'])
  materialChannels.target = undefined
  pipeline.color.outputTexture = undefined
  scene.render()
  assert.equal(p.getReport().textures.currentBytes, 0)
  assert.equal(p.getReport().textures.peakBytes, 128)
  p.destroy()
})

test('profiler includes Hi-Z update and reduction textures separately from material source', () => {
  const { gl, queries } = fixture()
  const texture = { width: 4, height: 4, sizeInBytes: 256, isDestroyed: () => false }
  const depthPyramid = { update() {}, levels: [{ texture }] }
  const materialChannels = { _render() { depthPyramid.update() }, depthPyramid }
  const scene = { context: { _gl: gl, draw() {} }, frameState: { commandList: [] }, render() { materialChannels._render() } }
  const p = new RenderProfiler143({ VERSION: '1.143' }, { viewer: { scene }, materialChannels })
  for (let i = 0; i < 6; i++) { scene.render(); queries.forEach(q => { q.ready = true }) }
  const report = p.getReport()
  assert.ok(report.gpu.some(sample => sample.label === 'hiz'))
  assert.equal(report.textures.currentBytes, 256)
  p.destroy()
})

test('profiler includes AO HDR work and distinct intermediate textures', () => {
  const { gl, queries } = fixture()
  const texture = { width: 4, height: 4, sizeInBytes: 256, isDestroyed: () => false }
  const stage = { isDestroyed: () => false, outputTexture: texture }
  const screenSpaceAO = { _execute() {}, stages: { raw: stage, vertical: stage } }
  const scene = { context: { _gl: gl, draw() {} }, frameState: { commandList: [] }, render() { screenSpaceAO._execute() } }
  const p = new RenderProfiler143({ VERSION: '1.143' }, { viewer: { scene }, screenSpaceAO })
  for (let i = 0; i < 4; i++) { scene.render(); queries.forEach(q => { q.ready = true }) }
  const report = p.getReport()
  assert.ok(report.gpu.some(sample => sample.label === 'ao'))
  assert.equal(report.textures.currentBytes, 256)
  p.destroy()
})

test('profiler times SSR HDR work and restores its execution hook', () => {
  const { gl, queries } = fixture()
  const screenSpaceReflections = { _execute(value) { return value + 1 } }
  const original = screenSpaceReflections._execute
  const scene = { context: { _gl: gl, draw() {} }, frameState: { commandList: [] },
    render() { return screenSpaceReflections._execute(20) } }
  const p = new RenderProfiler143({ VERSION: '1.143' }, { viewer: { scene }, screenSpaceReflections })
  for (let i = 0; i < 4; i++) {
    assert.equal(scene.render(), 21)
    queries.forEach(q => { q.ready = true })
  }
  const report = p.getReport()
  assert.deepEqual([...new Set(report.gpu.map(sample => sample.label))], ['frame', 'ssr'])
  assert.equal(report.cpu.filter(sample => sample.label === 'ssr').length, 4)
  p.destroy()
  assert.equal(screenSpaceReflections._execute, original)
})

test('SSR inventory includes reflection attachments and stages once and preserves peak after release', () => {
  const { gl } = fixture()
  const texture = bytes => ({ width: 4, height: 4, sizeInBytes: bytes, isDestroyed: () => false })
  const specular = texture(256), response = texture(128), trace = texture(64), resolve = texture(256)
  const stage = outputTexture => ({ isDestroyed: () => false, outputTexture })
  const materialChannels = { _render() {}, target: { reflectionSpecular: specular, reflectionResponse: response,
    eyeDepth: trace, transparency: { ...texture(999), isDestroyed: () => true } } }
  const screenSpaceReflections = { _execute() {}, stages: { trace: stage(trace), resolve: stage(resolve),
    unavailable: stage(undefined), destroyed: { ...stage(texture(999)), isDestroyed: () => true } } }
  const scene = { context: { _gl: gl, draw() {} }, frameState: { commandList: [] }, render() {} }
  const pipeline = { viewer: { scene }, materialChannels, screenSpaceReflections, color: stage(resolve) }
  const p = new RenderProfiler143({ VERSION: '1.143' }, pipeline)
  scene.render()
  const active = p.getReport().textures
  assert.equal(active.currentBytes, 704)
  assert.equal(active.entries.length, 4)
  assert.ok(active.entries.some(entry => entry.name === 'materials.reflectionSpecular'))
  assert.ok(active.entries.some(entry => entry.name === 'materials.reflectionResponse'))
  assert.ok(active.entries.some(entry => entry.name === 'ssr.resolve'))
  materialChannels.target = undefined
  screenSpaceReflections.stages = undefined
  pipeline.color.outputTexture = undefined
  scene.render()
  const released = p.getReport().textures
  assert.equal(released.currentBytes, 0)
  assert.equal(released.peakBytes, 704)
  p.destroy()
})

test('uniform-buffer inventory is empty before reflection buffers are enabled', () => {
  const { gl } = fixture()
  const scene = { context: { _gl: gl, draw() {} }, frameState: { commandList: [] }, render() {} }
  const p = new RenderProfiler143({ VERSION: '1.143' }, { viewer: { scene } })
  const report = p.getReport()
  assert.equal(report.uniformBuffers.currentBytes, 0)
  assert.equal(report.uniformBuffers.peakBytes, 0)
  assert.deepEqual(report.uniformBuffers.entries, [])
  assert.equal(report.frames.length, 0)
  p.destroy()
})

test('uniform-buffer inventory deduplicates the shared camera and reads uploads without issuing work', () => {
  const { gl } = fixture()
  const buffer = bytes => ({ destroyed: false, uploads: 1, uploadedBytes: bytes,
    isDestroyed() { return this.destroyed },
    getDiagnostics() { return { bytes: this.destroyed ? 0 : bytes, uploads: this.uploads, uploadedBytes: this.uploadedBytes } } })
  const camera = buffer(160), reflection = buffer(16), transparent = buffer(16)
  const screenSpaceReflections = { _execute() {}, cameraUniforms: { buffer: camera }, reflectionUniforms: reflection }
  const transparentReflections = { _execute() {}, cameraUniforms: { buffer: camera }, reflectionUniforms: transparent }
  const scene = { context: { _gl: gl, draw() { return 12 } }, frameState: { commandList: [1] },
    render() { return this.context.draw() } }
  const p = new RenderProfiler143({ VERSION: '1.143' }, { viewer: { scene }, screenSpaceReflections, transparentReflections })
  assert.equal(scene.render(), 12)
  const first = p.getReport()
  assert.equal(first.uniformBuffers.currentBytes, 192)
  assert.equal(first.uniformBuffers.peakBytes, 192)
  assert.deepEqual(first.uniformBuffers.entries, [
    { name: 'ssr.camera', bytes: 160, uploads: 1, uploadedBytes: 160 },
    { name: 'ssr.reflection', bytes: 16, uploads: 1, uploadedBytes: 16 },
    { name: 'transparentSsr.reflection', bytes: 16, uploads: 1, uploadedBytes: 16 }
  ])
  assert.equal(first.textures.currentBytes, 0)
  assert.deepEqual(first.textures.entries, [])
  assert.equal(first.frames.length, 1)
  assert.equal(first.frames[0].drawCalls, 1)
  assert.equal(first.frames[0].submittedCommands, 1)
  camera.uploads = 2
  camera.uploadedBytes = 176
  const updated = p.getReport()
  assert.equal(updated.uniformBuffers.entries[0].uploads, 2)
  assert.equal(updated.uniformBuffers.entries[0].uploadedBytes, 176)
  assert.deepEqual(updated.frames, first.frames)
  assert.deepEqual(updated.cpu, first.cpu)
  camera.destroyed = reflection.destroyed = transparent.destroyed = true
  const released = p.getReport().uniformBuffers
  assert.equal(released.currentBytes, 0)
  assert.equal(released.peakBytes, 192)
  assert.deepEqual(released.entries, [])
  p.destroy()
})

test('frame sampling retains a uniform-buffer peak even when resources are released before reporting', () => {
  const { gl } = fixture()
  const buffer = { isDestroyed: () => false, getDiagnostics: () => ({ bytes: 160, uploads: 3, uploadedBytes: 192 }) }
  const screenSpaceReflections = { _execute() {}, cameraUniforms: { buffer } }
  const scene = { context: { _gl: gl, draw() {} }, frameState: { commandList: [] }, render() {} }
  const p = new RenderProfiler143({ VERSION: '1.143' }, { viewer: { scene }, screenSpaceReflections })
  scene.render()
  screenSpaceReflections.cameraUniforms = undefined
  assert.equal(p.getReport().uniformBuffers.currentBytes, 0)
  assert.equal(p.getReport().uniformBuffers.peakBytes, 160)
  p.destroy()
})
