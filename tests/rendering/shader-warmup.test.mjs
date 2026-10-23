import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import ShaderWarmup143, { viewportQuadTexts143 } from '../../src/rhi/ShaderWarmup143.js'
import WebGLDevice143 from '../../src/rhi/WebGLDevice143.js'

const C = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')
const context = () => ({ webgl2: true, textureFloatLinear: true, floatingPointTexture: true, _gl: {} })

// 记录调用的假 WebGL2 + KHR_parallel_shader_compile。complete(program) 控制后台编译何时完成。
function fakeGl({ parallel = true, linkOk = true } = {}) {
  const calls = [], done = new Set(), deleted = new Set()
  let lost = false, nextId = 1
  const ext = { COMPLETION_STATUS_KHR: 0x91b1 }
  const gl = {
    VERTEX_SHADER: 0x8b31, FRAGMENT_SHADER: 0x8b30, LINK_STATUS: 0x8b82,
    getExtension: name => name === 'KHR_parallel_shader_compile' && parallel ? ext : null,
    isContextLost: () => lost,
    createProgram: () => ({ id: nextId++, kind: 'program', attached: [], bound: {} }),
    createShader: type => ({ id: nextId++, kind: 'shader', type }),
    shaderSource: (shader, text) => { shader.text = text },
    compileShader: shader => calls.push(['compileShader', shader.type]),
    attachShader: (program, shader) => program.attached.push(shader),
    bindAttribLocation: (program, index, name) => { program.bound[name] = index },
    linkProgram: program => calls.push(['linkProgram', program.id]),
    getProgramParameter: (program, name) => {
      calls.push(['getProgramParameter', name])
      if (name === ext.COMPLETION_STATUS_KHR) return lost ? null : done.has(program)
      if (name === gl.LINK_STATUS) return linkOk
    },
    deleteProgram: program => deleted.add(program),
    deleteShader: shader => deleted.add(shader),
  }
  return { gl, ext, calls, deleted, complete: program => done.add(program), lose: () => { lost = true },
    programs: () => calls.filter(c => c[0] === 'linkProgram').length }
}

const texts = (fragment = 'void main(){ out_FragColor = vec4(1.0); }') =>
  viewportQuadTexts143(C, context(), fragment, ['LOG_DEPTH'])

test('viewport-quad texts are byte-identical to what Cesium compiles for a post-process stage', () => {
  // PostProcessStage.createDrawCommand：defines 为 ['LOG_DEPTH'] 或 ['']，再经 createViewportQuadCommand
  // → ShaderProgram.fromCache({ vertexShaderSource: ViewportQuadVS, attributeLocations: { position: 0, textureCoordinates: 1 } })。
  const fragment = 'uniform sampler2D colorTexture; in vec2 v_textureCoordinates;\nvoid main(){ out_FragColor = texture(colorTexture, v_textureCoordinates); }'
  for (const defines of [['LOG_DEPTH'], ['']]) {
    const ctx = context()
    const cesium = new C.ShaderCache(ctx).getShaderProgram({ context: ctx, vertexShaderSource: C._shadersViewportQuadVS,
      fragmentShaderSource: new C.ShaderSource({ defines, sources: [fragment] }), attributeLocations: { position: 0, textureCoordinates: 1 } })
    const ours = viewportQuadTexts143(C, ctx, fragment, defines)
    assert.equal(ours.vertexShaderText, cesium._vertexShaderText)
    assert.equal(ours.fragmentShaderText, cesium._fragmentShaderText)
    assert.deepEqual(ours.attributeLocations, { position: 0, textureCoordinates: 1 })
  }
})

test('plain viewport-quad shaders match Cesium without stage defines', () => {
  // AtmosphereLut143、CloudTemporal143 直接 createViewportQuadCommand(字符串)：fromCache 把字符串包成无 defines 的 ShaderSource。
  const f = fakeGl(), ctx = context(), warmup = new ShaderWarmup143(C, { ...ctx, _gl: f.gl })
  const fragment = 'uniform float u; void main(){ out_FragColor = vec4(u); }'
  const cesium = new C.ShaderCache(ctx).getShaderProgram({ context: ctx, vertexShaderSource: C._shadersViewportQuadVS,
    fragmentShaderSource: fragment, attributeLocations: { position: 0, textureCoordinates: 1 } })
  const keys = warmup.warmViewportShaders([fragment, fragment], { context: ctx })
  assert.equal(keys.length, 1)
  assert.equal([...warmup.pending.values()][0].fragmentShaderText, cesium._fragmentShaderText)
})

test('warm submits a background compile and never blocks on the link result', () => {
  const f = fakeGl(), warmup = new ShaderWarmup143(C, { _gl: f.gl })
  const t = texts(), key = warmup.warm(t)
  assert.ok(key)
  assert.deepEqual(f.calls.map(c => c[0]), ['compileShader', 'compileShader', 'linkProgram'])
  assert.equal(f.calls.some(c => c[0] === 'getProgramParameter'), false, 'submitting must not query any program status')
  assert.equal(warmup.warm(t), key, 'identical texts are submitted once')
  assert.equal(f.programs(), 1)
})

test('isReady polls completion without blocking, then releases the temporary program', () => {
  const f = fakeGl(), warmup = new ShaderWarmup143(C, { _gl: f.gl })
  const keys = [warmup.warm(texts('void main(){ out_FragColor = vec4(0.1); }')), warmup.warm(texts('void main(){ out_FragColor = vec4(0.2); }'))]
  assert.equal(warmup.isReady(keys), false)
  assert.equal(f.calls.filter(c => c[0] === 'getProgramParameter' && c[1] === f.gl.LINK_STATUS).length, 0, 'LINK_STATUS would block')
  const [first, second] = [...warmup.pending.values()].map(entry => entry.program)
  f.complete(first)
  assert.equal(warmup.isReady(keys), false)
  assert.ok(f.deleted.has(first), 'a finished program is deleted at once')
  f.complete(second)
  assert.equal(warmup.isReady(keys), true)
  assert.equal(warmup.pending.size, 0)
  const before = f.calls.length
  assert.equal(warmup.isReady(keys), true)
  assert.equal(f.calls.length, before, 'ready keys need no further GL calls')
  assert.deepEqual(warmup.getDiagnostics(), { parallel: true, pending: 0, ready: 2, failed: 0, timedOut: 0 })
})

test('a failed warm link is still reported ready, so Cesium compiles and reports the real error itself', () => {
  const f = fakeGl({ linkOk: false }), warmup = new ShaderWarmup143(C, { _gl: f.gl })
  const key = warmup.warm(texts())
  f.complete([...warmup.pending.values()][0].program)
  assert.equal(warmup.isReady([key]), true)
  assert.equal(warmup.getDiagnostics().failed, 1)
})

test('without the parallel extension nothing is compiled ahead and nothing waits', () => {
  const f = fakeGl({ parallel: false }), warmup = new ShaderWarmup143(C, { _gl: f.gl })
  assert.equal(warmup.warm(texts()), null)
  assert.equal(f.programs(), 0)
  assert.equal(warmup.isReady([]), true)
  assert.equal(warmup.getDiagnostics().parallel, false)
})

test('a lost context or a stalled compile never keeps callers waiting', () => {
  const lost = fakeGl(), a = new ShaderWarmup143(C, { _gl: lost.gl })
  const key = a.warm(texts())
  lost.lose()
  assert.equal(a.isReady([key]), true)

  let now = 0
  const slow = fakeGl(), b = new ShaderWarmup143(C, { _gl: slow.gl }, { now: () => now, timeoutMs: 1000 })
  const stalled = b.warm(texts())
  now = 999
  assert.equal(b.isReady([stalled]), false)
  now = 1001
  assert.equal(b.isReady([stalled]), true)
  assert.equal(b.getDiagnostics().timedOut, 1)
  assert.equal(b.pending.size, 0)
})

test('post-process stage trees are walked to their leaves and warmed with the frame log-depth define', () => {
  const f = fakeGl(), warmup = new ShaderWarmup143(C, { _gl: f.gl }), ctx = context()
  const leaf = fragmentShader => ({ fragmentShader })
  const composite = (...stages) => ({ length: stages.length, get: i => stages[i] })
  const shared = 'void main(){ out_FragColor = vec4(0.3); }'
  const tree = [composite(leaf(shared), composite(leaf('void main(){ out_FragColor = vec4(0.4); }'))), leaf(shared)]
  const keys = warmup.warmPostProcessStages(tree, { useLogDepth: true, context: ctx })
  assert.equal(keys.length, 2, 'identical stage shaders share one warm-up')
  assert.equal(f.programs(), 2)
  const linked = [...warmup.pending.values()].map(entry => entry.fragmentShaderText)
  assert.ok(linked.every(text => text.includes('#define LOG_DEPTH')))
  assert.deepEqual([...warmup.pending.values()][0].program.bound, { position: 0, textureCoordinates: 1 })
})

test('the RHI owns one shader warm-up per device and releases it on destroy', () => {
  const f = fakeGl()
  const device = Object.assign(Object.create(WebGLDevice143.prototype), { C, context: { _gl: f.gl }, resources: new Set(), transientOwners: new Set(),
    pool: { detach() {} }, owner: {}, destroyed: false })
  const warmup = device.shaderWarmup
  assert.ok(warmup instanceof ShaderWarmup143)
  assert.equal(device.shaderWarmup, warmup)
  const key = warmup.warm(texts())
  const program = [...warmup.pending.values()][0].program
  device.destroy()
  assert.ok(f.deleted.has(program), 'pending warm-up programs are released with the device')
  assert.ok(key)
})
