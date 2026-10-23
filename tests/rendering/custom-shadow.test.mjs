import test from 'node:test'
import assert from 'node:assert/strict'
import { receiverSource, casterSources, pcf } from '../../src/shadows/shaderAdapter143.js'
import ShadowCache, { UNIFORM_CHECK_ROUNDS } from '../../src/shadows/ShadowCache.js'
import LightFrustum from '../../src/shadows/LightFrustum.js'
import { createRequire } from 'node:module'
import selectLightTiles from '../../src/shadows/CasterCommands143.js'
import ShadowReceiver143, { clippingPlanesInLightSpace } from '../../src/shadows/ShadowReceiver143.js'
import DirectionalShadowPass from '../../src/shadows/DirectionalShadowPass.js'

const C = { Pass: { GLOBE: 2 }, ShaderSource: class {
  constructor(options) { Object.assign(this, options) }
  static replaceMain(source, name) { return source.replace(/void\s+main\s*\(/g, `void ${name}(`) }
} }

test('globe receiver attenuates imagery lighting before atmosphere instead of replacing the final color', () => {
  const engine = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')
  const original = new engine.ShaderSource({ sources: [engine._shadersGlobeFS], defines: [] })
  const result = receiverSource(engine, original, true)
  const source = result.sources.join('\n')
  assert.match(source, /mix\(0.35, 1.0, campus_shadowVisibility\(v_positionEC, normalEC\)\)/)
  assert.match(source, /czm_fog/)
  assert.equal(receiverSource(engine, original, false), null)
})

test('receiver shadows direct lighting while retaining IBL and emissive terms', () => {
  const source = new C.ShaderSource({ defines: ['LIGHTING_PBR'], sources: [
    'vec3 directColor = lightColorHdr * directLighting;\nvec3 color = directColor + material.emissive;\ncolor += computeIBL(position, normal, lightDirection, lightColorHdr, material);'
  ] })
  const result = receiverSource(C, source)
  assert.match(result.sources.join('\n'), /directColor.*campus_shadowVisibility/)
  assert.match(result.sources.join('\n'), /color = directColor \+ material.emissive/)
  assert.match(result.sources.join('\n'), /color \+= computeIBL/)
  assert.doesNotMatch(source.sources[0], /campus_/)
})

test('unsupported and unlit shaders are left untouched', () => {
  assert.equal(receiverSource(C, { defines: [], sources: ['void main() { out_FragColor = vec4(1.0); }'] }), null)
  assert.equal(receiverSource(C, { defines: [], sources: ['vec3 directColor = lightColorHdr * directLighting;'] }), null)
})

test('depth shader preserves mask discard, clipping and original vertex transforms', () => {
  const program = {
    vertexShaderSource: { defines: ['HAS_INSTANCING', 'LOG_DEPTH'], sources: ['void main(){ gl_Position = instancedPosition(); }'] },
    fragmentShaderSource: { defines: ['ALPHA_MODE_MASK', 'LOG_DEPTH'], sources: ['void main(){ lightingStage(material, attributes); if(alpha < cutoff) discard; clippingStage(); out_FragColor=vec4(1.0); }'] }
  }
  const result = casterSources(C, program)
  assert.ok(result.vertexShaderSource.defines.includes('SHADOW_MAP'))
  assert.ok(!result.vertexShaderSource.defines.includes('LOG_DEPTH'))
  assert.ok(!result.fragmentShaderSource.defines.includes('LOG_DEPTH'))
  assert.match(result.vertexShaderSource.sources[0], /instancedPosition/)
  assert.match(result.fragmentShaderSource.sources.join('\n'), /if\(alpha < cutoff\) discard/)
  assert.match(result.fragmentShaderSource.sources.join('\n'), /campus_depth_main\(\);/)
  assert.doesNotMatch(result.fragmentShaderSource.sources.join('\n'), /lightingStage\(material, attributes\);/)
  assert.match(program.fragmentShaderSource.sources[0], /void main/)
})

test('caster commands reuse storage while following the current source draw',()=>{
  const E=createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')
  const source={id:17},program={},state={},adapter=new ShadowReceiver143(E,{frameState:{frameNumber:1}},{})
  adapter.castPrograms.set(source.id,program);adapter.castStates.set(8,{value:state})
  const command=new E.DrawCommand({shaderProgram:source,renderState:{id:8},uniformMap:{},count:3,offset:0})
  const first=adapter.cast(command,{})
  command.count=12;command.offset=6;command.uniformMap={changed:()=>1}
  const target={},second=adapter.cast(command,target)
  assert.equal(second,first);assert.notEqual(second,command)
  assert.equal(second.count,12);assert.equal(second.offset,6);assert.equal(second.uniformMap,command.uniformMap)
  assert.equal(second.framebuffer,target);assert.equal(second.shaderProgram,program)
  assert.equal(command.shaderProgram,source)
})

test('static cache detects transform, alpha, shader, resource and selection changes', () => {
  const cache = new ShadowCache()
  let alpha = 0.5
  const matrix = Array.from({ length: 16 }, (_, i) => i % 5 === 0 ? 1 : 0)
  const command = { vertexArray: {}, shaderProgram: { id: 1, vertexShaderSource: { defines: [] }, _manualUniforms: [{ name: 'alpha' }] },
    renderState: { id: 1 }, count: 36, modelMatrix: matrix.slice(), uniformMap: { alpha: () => alpha } }
  // 头部刚变的那次只记录头部；头部一致后补记明细，之后才命中。
  const settle = (m = matrix, size = 2048, list = [command]) => { cache.matches(m, size, list); cache.commit(); cache.matches(m, size, list); cache.commit() }
  const matches = () => cache.matches(matrix, 2048, [command])
  settle()
  assert.equal(matches(), true)
  alpha = 0.2
  assert.equal(matches(), false)
  cache.commit()
  assert.equal(matches(), true)
  command.modelMatrix[12] = 2
  assert.equal(matches(), false)
  cache.commit()
  command.vertexArray = {}
  assert.equal(matches(), false)
  cache.commit()
  command.shaderProgram.id = 2
  assert.equal(matches(), false)
  cache.commit()
  assert.equal(cache.matches(matrix, 2048, []), false)
  assert.equal(cache.matches(matrix, 4096, [command]), false)
  settle()
  cache.invalidate()
  assert.equal(matches(), false)
})

test('a changed light matrix skips the per-caster signature entirely', () => {
  const cache = new ShadowCache(), matrix = Array.from({ length: 16 }, (_, i) => i)
  let reads = 0
  const command = { vertexArray: {}, shaderProgram: { id: 1, vertexShaderSource: { defines: [] }, _manualUniforms: [{ name: 'u' }] },
    renderState: { id: 1 }, count: 3, uniformMap: { u: () => { reads++; return 1 } } }
  cache.matches(matrix, 1024, [command]); cache.commit(); cache.matches(matrix, 1024, [command]); cache.commit()
  reads = 0
  const moved = matrix.slice(); moved[12] = 5
  assert.equal(cache.matches(moved, 1024, [command]), false)
  assert.equal(reads, 0, 'uniforms are not read when the cheap header already differs')
  cache.commit()
  assert.equal(cache.matches(moved, 1024, [command]), false, 'the first stable refresh records the detail and redraws')
  cache.commit()
  assert.equal(cache.matches(moved, 1024, [command]), true)
})

test('uninitialized and deforming shaders cannot reuse static cached depth', () => {
  const cache = new ShadowCache()
  const command = { shaderProgram: { vertexShaderSource: { defines: ['HAS_SKINNING'] }, _manualUniforms: [] } }
  assert.equal(ShadowCache.cacheable(command), false)
  assert.equal(cache.matches([], 2048, [command]), false)
  command.shaderProgram._manualUniforms = undefined
  command.shaderProgram.vertexShaderSource.defines = []
  assert.equal(ShadowCache.cacheable(command), false)
  cache.commit()
  assert.equal(cache.matches([], 2048, [command]), false)
})

test('reordering identical depth casters is cacheable but changing their render pass is not', () => {
  const cache = new ShadowCache()
  const command = () => ({ vertexArray: {}, shaderProgram: { id: 1, vertexShaderSource: { defines: [] }, _manualUniforms: [] },
    renderState: { id: 1 }, pass: 5, count: 3, uniformMap: {} })
  const a = command(), b = command()
  cache.matches([], 1024, [a,b]); cache.commit(); cache.matches([], 1024, [a,b]); cache.commit()
  assert.equal(cache.matches([], 1024, [b,a]), true)
  b.pass = 7
  assert.equal(cache.matches([], 1024, [b,a]), false)
})

// 校园 521 个静态投影体每次重画都读约 4500 个 uniform 值并排序比较（约 1.8 ms）。命令对象与顺序
// 不变时走快速比对：只比固定字段（几何、程序、状态、绘制范围、模型矩阵），uniform 值按轮转抽查。
function staticCasters(count) {
  const values = Array.from({ length: count }, () => 1), reads = { n: 0 }
  const commands = values.map((_, i) => ({ vertexArray: {}, renderState: { id: 1 }, count: 3, pass: 1,
    modelMatrix: Array.from({ length: 16 }, (_, k) => k % 5 === 0 ? 1 : 0),
    shaderProgram: { id: 100 + i, vertexShaderSource: { defines: [] }, _manualUniforms: [{ name: 'u' }] },
    uniformMap: { u: () => { reads.n++; return values[i] } } }))
  const cache = new ShadowCache(), matrix = Array.from({ length: 16 }, (_, i) => i)
  const matches = (list = commands) => cache.matches(matrix, 1024, list)
  const settle = () => { matches(); cache.commit(); matches(); cache.commit() }
  return { values, reads, commands, cache, matches, settle }
}

test('an unchanged static caster list hits through the identity fast path and samples only a slice of uniforms', () => {
  const f = staticCasters(UNIFORM_CHECK_ROUNDS * 4)
  f.settle()
  for (let round = 0; round < UNIFORM_CHECK_ROUNDS * 2; round++) {
    f.reads.n = 0
    assert.equal(f.matches(), true)
    f.cache.commit()
    assert.equal(f.reads.n, 4, 'each refresh re-reads the uniforms of one slice, not every caster')
  }
})

test('a uniform change on a static caster is caught within one full rotation', () => {
  const f = staticCasters(UNIFORM_CHECK_ROUNDS * 4)
  f.settle()
  f.values[f.values.length - 1] = 0.5
  let missed = 0
  for (let round = 0; round < UNIFORM_CHECK_ROUNDS; round++) { if (!f.matches()) missed++; f.cache.commit() }
  assert.equal(missed, 1, 'the changed caster is found once its slice comes up, and the redraw records the new state')
  assert.equal(f.matches(), true)
})

test('a reordered list that hits the full signature becomes the new fast-path snapshot without a commit', () => {
  // renderLayered 命中时不调 commit：重排后的顺序必须在命中时就被采用，否则此后每次都走完整签名。
  const f = staticCasters(UNIFORM_CHECK_ROUNDS * 4)
  f.settle()
  f.commands.reverse()
  assert.equal(f.matches(), true)
  f.reads.n = 0
  assert.equal(f.matches(), true)
  assert.equal(f.reads.n, 4, 'the next refresh is back on the fast path')
})

test('fixed-field changes miss immediately and identical replacements or reorders fall back to the full signature', () => {
  const f = staticCasters(UNIFORM_CHECK_ROUNDS * 4)
  const check = (mutate, expected, message) => { f.settle(); mutate(); assert.equal(f.matches(), expected, message); f.cache.commit() }
  check(() => { f.commands[5].modelMatrix[12] = 3 }, false, 'a moved caster')
  check(() => { f.commands[6].vertexArray = {} }, false, 'new geometry')
  check(() => { f.commands[7].renderState = { id: 2 } }, false, 'a new render state')
  check(() => { f.commands[8].count = 6 }, false, 'a new draw range')
  check(() => { f.commands[9] = { ...f.commands[9] } }, true, 'a new command object with identical content still hits')
  check(() => { f.commands.reverse() }, true, 'the same casters in another order still hit')
  f.settle(); f.cache.invalidate()
  assert.equal(f.matches(), false, 'invalidate still forces a redraw')
})

test('static mode keeps buildings in a cached layer and redraws only dynamic casters', () => {
  const engine = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')
  const pass = Object.create(DirectionalShadowPass.prototype)
  const draws = [], copies = []
  const target = name => ({ name, framebuffer: { name }, passState: {}, size: 1024, copyTo(ctx, to) { copies.push([name, to.name]) } })
  const program = { id: 1, vertexShaderSource: { defines: [] }, _manualUniforms: [] }
  const building = { owner: {}, vertexArray: {}, shaderProgram: program, renderState: { id: 1 }, count: 3, uniformMap: {} }
  const car = { owner: {}, vertexArray: {}, shaderProgram: program, renderState: { id: 1 }, count: 3, uniformMap: {} }
  Object.assign(pass, { C: engine, dynamicOwners: new WeakSet([car.owner]), stats: { cacheHits: 0 },
    adapter: { raw: command => command.shaderProgram, castProgram: source => source }, // 未替换程序：投影程序即源程序
    drawDepth(level, to, commands, ctx, us, camera, clear = true) { draws.push([to.name, commands.length, clear]) } })
  const level = { light: { viewProjection: Array.from({ length: 16 }, (_, i) => i) }, target: target('live'), cache: new ShadowCache(),
    staticTarget: target('static'), staticReady: false, staticVersion: 0, composedVersion: -1, composedDynamic: false, updates: 0, cacheHits: 0 }
  const frame = commands => { draws.length = 0; copies.length = 0; pass.renderLayered(level, commands, 1024, {}, {}, {}) }
  frame([building, car])
  assert.deepEqual(draws, [['static', 1, true], ['live', 1, false]])
  frame([building, car])
  assert.deepEqual(draws, [['static', 1, true], ['live', 1, false]], 'detail is recorded on the first stable refresh')
  frame([car, building])
  assert.deepEqual(draws, [['live', 1, false]], 'a moving car does not redraw the static layer')
  assert.deepEqual(copies, [['static', 'live']])
  frame([building])
  assert.deepEqual(draws, [], 'the car leaving still recomposes the live map')
  assert.deepEqual(copies, [['static', 'live']])
  frame([building])
  assert.deepEqual([draws, copies], [[], []], 'nothing changed: no draw and no copy')
})

// 增强模式下 ShadowReceiver143.receive 把 command.shaderProgram 换成接收程序；Cesium 实际画的是由它
// 派生的 logDepth 程序，接收程序本身从不绑定，_manualUniforms 永远为空。静态层的判定与签名
// 若读它，所有投影体都会被当成不可缓存（校园实测 521/521 进动态层，静态层形同虚设）。
test('static mode judges and signs casters by their compiled caster program, not the swapped receiver program', () => {
  const engine = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')
  const pass = Object.create(DirectionalShadowPass.prototype)
  const draws = []
  const target = name => ({ name, framebuffer: { name }, passState: {}, size: 1024, copyTo() {} })
  const receiver = { id: 10, vertexShaderSource: { defines: [] } }           // 从未绑定：没有 _manualUniforms
  const source = { id: 11, vertexShaderSource: { defines: [] } }
  const caster = { id: 12, vertexShaderSource: { defines: [] }, _manualUniforms: [{ name: 'u_color' }] }
  let color = 1
  const building = { owner: {}, vertexArray: {}, shaderProgram: receiver, renderState: { id: 1 }, count: 3, uniformMap: { u_color: () => color } }
  Object.assign(pass, { C: engine, dynamicOwners: new WeakSet(), stats: { cacheHits: 0 },
    adapter: { raw: command => command === building ? source : command.shaderProgram, castProgram: program => program === source ? caster : null },
    drawDepth(level, to, commands) { draws.push([to.name, commands.length]) } })
  assert.equal(pass.isDynamicCaster(building), false, 'a static building is judged by its caster program')
  const level = { light: { viewProjection: Array.from({ length: 16 }, (_, i) => i) }, target: target('live'), cache: new ShadowCache(),
    staticTarget: target('static'), staticReady: false, staticVersion: 0, composedVersion: -1, composedDynamic: false, updates: 0, cacheHits: 0 }
  const frame = () => { draws.length = 0; pass.renderLayered(level, [building], 1024, {}, {}, {}) }
  frame(); frame()
  assert.deepEqual(draws, [['static', 1]], 'detail is recorded on the first stable refresh')
  frame()
  assert.deepEqual(draws, [], 'the cached static layer is reused')
  assert.equal(level.cacheHits, 1)
  color = 0.5
  frame()
  assert.deepEqual(draws, [['static', 1]], "a change to the caster program's uniforms still redraws")
  caster._manualUniforms = undefined
  assert.equal(pass.isDynamicCaster(building), true, 'a caster program not yet compiled stays dynamic')
})

test('light frustum remains finite at the pole and independent of view-camera changes', () => {
  const C = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')
  const light = new LightFrustum(C, { mapProjection: new C.GeographicProjection(), drawingBufferWidth: 800,
    drawingBufferHeight: 600, mode: C.SceneMode.SCENE3D })
  light.update(new C.Cartesian3(0, 0, 6356752), C.Cartesian3.UNIT_Z, 100, 2048)
  assert.ok(light.camera.frustum instanceof C.OrthographicFrustum,
    'Cesium3DTile SSE recognizes OrthographicFrustum, not its off-center implementation')
  assert.ok(Array.from({ length: 16 }, (_, i) => light.viewProjection[i]).every(Number.isFinite))
  const before = C.Matrix4.clone(light.viewProjection)
  light.receiverMatrix({ inverseViewMatrix: C.Matrix4.fromTranslation(new C.Cartesian3(1, 2, 3)) })
  assert.ok(C.Matrix4.equals(before, light.viewProjection))
})

test('light camera updates never invoke interactive setView/picking during rendering', () => {
  const C = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')
  const light = new LightFrustum(C, { mapProjection: new C.GeographicProjection(), drawingBufferWidth: 800,
    drawingBufferHeight: 600, mode: C.SceneMode.SCENE3D })
  light.camera.setView = () => { throw new Error('setView may re-enter Scene picking') }
  assert.doesNotThrow(() => light.update(C.Cartesian3.fromDegrees(123, 41), C.Cartesian3.UNIT_Z, 2000, 2048))
})

test('sub-pixel TAA jitter does not invalidate the shadow frame cache', () => {
  const engine = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')
  const root = {}
  const scene = { primitives: { length: 1, _primitives: [root] } }
  const frustum = new engine.PerspectiveFrustum({ fov: Math.PI / 3, aspectRatio: 1.57, near: 1, far: 500000 })
  const camera = {
    viewMatrix: engine.Matrix4.clone(engine.Matrix4.IDENTITY),
    positionWC: new engine.Cartesian3(0, 0, 1),
    frustum
  }
  const options = { shadowCascades: 1, shadowSize: 4096, shadowDistance: 4000, shadowUpdateInterval: 2 }
  const caster = { castShadows: true, shaderProgram: {}, pass: engine.Pass.OPAQUE }
  const base = pass => {
    Object.assign(pass, {
      C: engine, scene, ready: true, forceShadowUpdate: false,
      lastCameraView: engine.Matrix4.clone(camera.viewMatrix),
      lastLightDirection: engine.Cartesian3.clone(engine.Cartesian3.UNIT_Z),
      lastCommandCount: 1, lastCommandRefs: [caster], lastPrimitiveCount: 1, lastPrimitiveRefs: [root],
      lastFrustumKey: pass.cameraFrustumKey(camera),
      lastShadowOptionsKey: pass.shadowOptionsKey(options), lastShadowFrame: 10, shadowFrameCounter: 10,
      levels: [{ target: { size: 4096 } }]
    })
    return pass
  }
  const list = () => [caster, { pass: engine.Pass.COMPUTE }]
  const toLight = engine.Cartesian3.UNIT_Z
  // Each frame writes the jitter phase TaaJitter143 would apply (fraction of a pixel
  // near the frustum plane). The key must be blind to it.
  const phase = i => ({ xOffset: (i % 2 ? 1 : -1) * 0.00022838 * (1 + i), yOffset: (i % 3 ? 1 : -1) * 0.00011419 * (1 + i) })
  const run = jitter => {
    const pass = base(Object.create(DirectionalShadowPass.prototype))
    pass.rememberShadowFrame({ frameNumber: 10 }, camera, list(), toLight, options)
    let updates = 0
    for (let i = 0; i < 24; i++) {
      if (jitter) Object.assign(frustum, phase(i))
      else Object.assign(frustum, { xOffset: 0, yOffset: 0 })
      const frame = { frameNumber: 11 + i }
      if (pass.shouldReuseShadowFrame(frame, camera, list(), toLight, options)) continue
      updates++
      pass.rememberShadowFrame(frame, camera, list(), toLight, options)
    }
    return updates
  }
  const withoutJitter = run(false)
  const withJitter = run(true)
  assert.equal(withoutJitter, 12, 'a stationary camera refreshes every other frame at interval 2')
  assert.equal(withJitter, withoutJitter, 'TAA jitter must not force a shadow-map redraw')
})

test('a deferred invalidation drops the cache signature without pinning a full redraw', () => {
  const engine = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')
  const root = {}
  const scene = { primitives: { length: 1, _primitives: [root] } }
  const camera = {
    viewMatrix: engine.Matrix4.clone(engine.Matrix4.IDENTITY),
    positionWC: new engine.Cartesian3(0, 0, 1),
    frustum: { near: 1, far: 4000, fovy: 1, aspectRatio: 1 }
  }
  const options = { shadowCascades: 1, shadowSize: 2048, shadowDistance: 4000, shadowUpdateInterval: 3 }
  const caster = { castShadows: true, shaderProgram: {}, pass: engine.Pass.OPAQUE }
  const list = () => [caster, { pass: engine.Pass.COMPUTE }]
  const setup = () => {
    const pass = Object.create(DirectionalShadowPass.prototype)
    Object.assign(pass, {
      C: engine, scene, enabled: true, ready: true, forceShadowUpdate: false, version: 0,
      lastCameraView: engine.Matrix4.clone(camera.viewMatrix),
      lastLightDirection: engine.Cartesian3.clone(engine.Cartesian3.UNIT_Z),
      lastCommandCount: 1, lastCommandRefs: [caster], lastPrimitiveCount: 1, lastPrimitiveRefs: [root],
      lastFrustumKey: pass.cameraFrustumKey(camera), lastShadowOptionsKey: pass.shadowOptionsKey(options),
      lastShadowFrame: 10, shadowFrameCounter: 10, stats: { updates: 0, cacheHits: 0, skippedFrames: 0, lastSkipReason: '' },
      levels: [{ target: { size: 2048 }, cache: new ShadowCache() }]
    })
    return pass
  }
  // Immediate is the default and must still force the next frame to redraw.
  const immediate = setup()
  immediate.invalidate()
  assert.equal(immediate.forceShadowUpdate, true)
  assert.equal(immediate.ready, false)
  assert.equal(immediate.shouldReuseShadowFrame({ frameNumber: 11 }, camera, list(), engine.Cartesian3.UNIT_Z, options), false)

  // Deferred keeps the interval authoritative: the next frame after a redraw may reuse,
  // which is what a continuously moving caster needs.
  const deferred = setup()
  deferred.invalidate({ immediate: false })
  assert.equal(deferred.forceShadowUpdate, false)
  assert.equal(deferred.ready, true)
  assert.equal(deferred.levels[0].cache.valid, false, 'the signature is dropped so the contents are rebuilt at the next scheduled update')
  deferred.rememberShadowFrame({ frameNumber: 10 }, camera, list(), engine.Cartesian3.UNIT_Z, options)
  assert.equal(deferred.shouldReuseShadowFrame({ frameNumber: 11 }, camera, list(), engine.Cartesian3.UNIT_Z, options), true,
    'deferring must not make every frame miss the reuse gate')
  assert.equal(deferred.shouldReuseShadowFrame({ frameNumber: 13 }, camera, list(), engine.Cartesian3.UNIT_Z, options), false,
    'the configured interval still refreshes mutable casters')
})

test('continuous per-frame invalidation with the deferred form keeps the shadow duty cycle at the interval', () => {
  const engine = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')
  const root = {}
  const scene = { primitives: { length: 1, _primitives: [root] } }
  const camera = {
    viewMatrix: engine.Matrix4.clone(engine.Matrix4.IDENTITY),
    positionWC: new engine.Cartesian3(0, 0, 1),
    frustum: { near: 1, far: 4000, fovy: 1, aspectRatio: 1 }
  }
  const options = { shadowCascades: 1, shadowSize: 2048, shadowDistance: 4000, shadowUpdateInterval: 3 }
  const caster = { castShadows: true, shaderProgram: {}, pass: engine.Pass.OPAQUE }
  const list = () => [caster, { pass: engine.Pass.COMPUTE }]
  const run = immediate => {
    const pass = Object.create(DirectionalShadowPass.prototype)
    Object.assign(pass, {
      C: engine, scene, enabled: true, ready: true, forceShadowUpdate: false, version: 0,
      lastCameraView: engine.Matrix4.clone(camera.viewMatrix),
      lastLightDirection: engine.Cartesian3.clone(engine.Cartesian3.UNIT_Z),
      lastCommandCount: 1, lastCommandRefs: [caster], lastPrimitiveCount: 1, lastPrimitiveRefs: [root],
      lastFrustumKey: pass.cameraFrustumKey(camera), lastShadowOptionsKey: pass.shadowOptionsKey(options),
      lastShadowFrame: 10, shadowFrameCounter: 10, stats: { updates: 0, cacheHits: 0, skippedFrames: 0, lastSkipReason: '' },
      levels: [{ target: { size: 2048 }, cache: new ShadowCache() }]
    })
    let updates = 0
    for (let i = 0; i < 30; i++) {
      // A moving caster touches the cache every frame, exactly like TrafficSystem does.
      pass.invalidate({ immediate })
      const frame = { frameNumber: 11 + i }
      if (pass.shouldReuseShadowFrame(frame, camera, list(), engine.Cartesian3.UNIT_Z, options)) continue
      updates++
      pass.rememberShadowFrame(frame, camera, list(), engine.Cartesian3.UNIT_Z, options)
    }
    return updates
  }
  assert.equal(run(true), 30, 'the immediate form redraws every frame, which is the defect being fixed')
  assert.equal(run(false), 10, 'the deferred form restores the configured every-third-frame cadence')
})

test('adaptive shadow reuse ignores scheduling commands and never skips consecutive frames', () => {
  const engine = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')
  const root = {}
  const scene = { primitives: { length: 1, _primitives: [root] } }
  const camera = {
    viewMatrix: engine.Matrix4.clone(engine.Matrix4.IDENTITY),
    positionWC: new engine.Cartesian3(0, 0, 1),
    frustum: { near: 1, far: 4000, fovy: 1, aspectRatio: 1, xOffset: 0, yOffset: 0 }
  }
  const options = { shadowCascades: 1, shadowSize: 2048, shadowDistance: 4000, shadowUpdateInterval: 3 }
  const pass = Object.create(DirectionalShadowPass.prototype)
  const caster = { castShadows: true, shaderProgram: {}, pass: engine.Pass.OPAQUE }
  Object.assign(pass, {
    C: engine, scene, ready: true, forceShadowUpdate: false, lastCameraView: engine.Matrix4.clone(camera.viewMatrix),
    lastLightDirection: engine.Cartesian3.clone(engine.Cartesian3.UNIT_Z), lastCommandCount: 1, lastCommandRefs: [caster],
    lastPrimitiveCount: 1, lastPrimitiveRefs: [root], lastFrustumKey: pass.cameraFrustumKey(camera),
    lastShadowOptionsKey: pass.shadowOptionsKey(options), lastShadowFrame: 10, shadowFrameCounter: 10,
    levels: [{ target: { size: 2048 } }]
  })
  const list = () => [caster, { pass: engine.Pass.COMPUTE }]
  assert.equal(pass.getFrameNumber({ frameNumber: 11 }), 11, 'Cesium passes a FrameState directly')
  assert.equal(pass.shouldReuseShadowFrame({ frameNumber: 11 }, camera, list(), engine.Cartesian3.UNIT_Z, options), true)
  assert.equal(pass.shouldReuseShadowFrame({ frameNumber: 12 }, camera, list(), engine.Cartesian3.UNIT_Z, options), true,
    'configured shadow interval may reuse an additional display frame')
  assert.equal(pass.shouldReuseShadowFrame({ frameNumber: 13 }, camera, list(), engine.Cartesian3.UNIT_Z, options), false,
    'stationary camera must still refresh mutable caster contents')
  camera.viewMatrix = engine.Matrix4.fromTranslation(new engine.Cartesian3(1, 0, 0))
  assert.equal(pass.shouldReuseShadowFrame({ frameNumber: 11 }, camera, list(), engine.Cartesian3.UNIT_Z, options), true)
  assert.equal(pass.shouldReuseShadowFrame({ frameNumber: 12 }, camera, list(), engine.Cartesian3.UNIT_Z, options), true)
  assert.equal(pass.shouldReuseShadowFrame({ frameNumber: 13 }, camera, list(), engine.Cartesian3.UNIT_Z, options), false)
  assert.equal(pass.shouldReuseShadowFrame({ frameNumber: 11 }, camera, [{ ...caster }], engine.Cartesian3.UNIT_Z, options), false)
  pass.rememberShadowFrame({ frameNumber: 12 }, camera, list(), engine.Cartesian3.UNIT_Z, options)
  assert.deepEqual(pass.lastCommandRefs, [caster])
  assert.equal(pass.lastShadowFrame, 12)
  pass.forceShadowUpdate = true
  assert.equal(pass.shouldReuseShadowFrame({ frameNumber: 13 }, camera, list(), engine.Cartesian3.UNIT_Z, options), false)
})

test('shadow receiver uses a 4x4 tent PCF footprint that avoids stair-step edges', () => {
  assert.match(pcf, /for \(int y = 0; y < 4; y\+\+\)/)
  assert.match(pcf, /for \(int x = 0; x < 4; x\+\+\)/)
  // The tent weights must stay normalized so the result is a coverage fraction.
  assert.match(pcf, /visibility \/ 16\.0/)
  // A 2x2 footprint turned any multi-texel transition into visible stair-steps.
  assert.doesNotMatch(pcf, /weightX = x == 0 \? 1\.0 - fraction\.x : fraction\.x/)
})

test('a fixed campus anchor does not drift when the sun rotates', () => {
  const C = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')
  const light = new LightFrustum(C, { mapProjection: new C.GeographicProjection(), drawingBufferWidth: 800,
    drawingBufferHeight: 600, mode: C.SceneMode.SCENE3D })
  const origin = C.Cartesian3.fromDegrees(123.42, 41.77, 40)
  for (let i = 0; i < 60; i++) {
    const direction = C.Cartesian3.normalize(new C.Cartesian3(-.697 + i * .00005, .71 + i * .00005, .1), new C.Cartesian3())
    light.update(origin, direction, 2000, 4096)
    const center = C.Cartesian3.subtract(light.camera.positionWC, C.Cartesian3.multiplyByScalar(direction, 4000, new C.Cartesian3()), new C.Cartesian3())
    assert.ok(C.Cartesian3.distance(center, origin) < .000001, 'rotating light must not quantize Earth-scale anchor coordinates')
  }
})

test('clipping planes use the light camera without changing main-camera plane data', () => {
  const C = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')
  const mainView = C.Matrix4.fromTranslation(new C.Cartesian3(-5, -10, -15))
  const lightView = C.Matrix4.fromTranslation(new C.Cartesian3(-20, 3, 7))
  const mainPlanes = C.Matrix4.inverseTranspose(mainView, new C.Matrix4())
  const saved = C.Matrix4.clone(mainPlanes)
  const actual = clippingPlanesInLightSpace(C,
    { inverseViewMatrix: C.Matrix4.inverse(mainView, new C.Matrix4()) }, { viewMatrix: lightView }, mainPlanes)
  assert.ok(C.Matrix4.equalsEpsilon(actual, C.Matrix4.inverseTranspose(lightView, new C.Matrix4()), 1e-10))
  assert.ok(C.Matrix4.equals(mainPlanes, saved))
})

function receiverFixture() {
  let id = 100
  const engine = { ...C, ShaderProgram: { fromCache(options) {
    return { ...options, id: id++, dead: false, destroy() { this.dead = true }, isDestroyed() { return this.dead } }
  } } }
  const scene = { context: {}, frameState: { frameNumber: 1, passes: { render: true } }, updateDerivedCommands() {} }
  const source = n => ({ id: n, vertexShaderSource: {}, _attributeLocations: {},
    fragmentShaderSource: { defines: ['LIGHTING_PBR'], sources: ['vec3 directColor = lightColorHdr * directLighting;'] } })
  const uniforms = { materialAlpha: () => 1 }
  const command = { shaderProgram: source(1), uniformMap: uniforms, receiveShadows: true }
  return { scene, source, uniforms, command, adapter: new ShadowReceiver143(engine, scene, { campus_shadowDepth: () => 0 }) }
}

test('material shader replacement does not retain nested shadow uniform wrappers', () => {
  const f = receiverFixture()
  f.adapter.receive(f.command)
  const replacement = f.source(2)
  f.command.shaderProgram = replacement
  f.adapter.receive(f.command)
  f.adapter.detach()
  assert.equal(f.command.shaderProgram, replacement)
  assert.equal(f.command.uniformMap, f.uniforms)
})

test('inactive commands and their receiver programs are released after the grace period', () => {
  const f = receiverFixture()
  const original = f.command.shaderProgram
  f.adapter.receive(f.command)
  const program = f.command.shaderProgram
  f.scene.frameState.frameNumber = 122
  f.adapter.prune()
  assert.equal(f.adapter.commands.size, 0)
  assert.equal(f.adapter.programs.size, 0)
  assert.equal(f.command.shaderProgram, original)
  assert.equal(program.isDestroyed(), true)
})

test('a later external hook can retain the old wrapper without reviving detached shadows', () => {
  const f = receiverFixture()
  const source = f.command.shaderProgram
  f.adapter.install()
  const previous = f.scene.updateDerivedCommands
  let calls = 0
  const external = function(command) { calls++; return previous.call(this, command) }
  f.scene.updateDerivedCommands = external
  f.adapter.detach()
  f.scene.updateDerivedCommands(f.command)
  assert.equal(f.command.shaderProgram, source)
  assert.equal(f.scene.updateDerivedCommands, external)
  f.adapter.install()
  f.scene.updateDerivedCommands(f.command)
  assert.equal(calls, 2)
  f.adapter.destroy()
  assert.equal(f.scene.updateDerivedCommands, external)
})

test('a replaced uniform map remains usable with the existing receiver shader', () => {
  const f = receiverFixture()
  f.adapter.receive(f.command)
  const replacement = { materialAlpha: () => .5 }
  f.command.uniformMap = replacement
  f.command.dirty = false
  f.adapter.receive(f.command)
  assert.equal(typeof f.command.uniformMap.campus_shadowDepth, 'function')
  assert.equal(f.command.uniformMap.materialAlpha(), .5)
  assert.equal(f.command.dirty, true)
  f.adapter.detach()
  assert.equal(f.command.uniformMap, replacement)
})

test('light traversal respects hidden tilesets and hidden parent collections', () => {
  const calls = []
  const tile = (name, show = true) => ({ show, updateForPass: () => calls.push(name) })
  const collection = (items, show = true) => ({ show, length: items.length, get: i => items[i] })
  selectLightTiles(collection([tile('visible'), tile('hidden', false),
    collection([tile('hidden ancestor')], false), collection([tile('nested')])]), {}, {})
  assert.deepEqual(calls, ['visible', 'nested'])
})

// 每条接收 draw 的每个阴影 uniform 都会调 getReceiverData；同一帧只应读一次相机、算一次级联矩阵。
test('receiver data is reused within a frame and refreshed on a new frame, shadow version or camera', () => {
  const Cesium = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')
  let matrices = 0, reads = 0
  const camera = view => ({ get inverseViewMatrix() { reads++; return view } })
  const pass = Object.assign(Object.create(DirectionalShadowPass.prototype), { C: Cesium, enabled: true, ready: true, version: 1,
    scene: { frameState: { frameNumber: 1 } }, regions: { splits: [0, 10, 20, 30] },
    levels: [{ target: { depth: 'depth', size: 1024 }, light: { texelWorld: 1, depthSpan: 2, receiverMatrix: () => { matrices++; return Cesium.Matrix4.IDENTITY } } }] })
  const still = camera(Cesium.Matrix4.IDENTITY)
  const first = pass.getReceiverData(still)
  for (let i = 0; i < 100; i++) assert.equal(pass.getReceiverData(still), first)
  assert.deepEqual([matrices, reads], [1, 1], 'one frame reads the camera and builds the cascades once')
  pass.scene.frameState.frameNumber = 2
  assert.equal(pass.getReceiverData(still), first)
  assert.deepEqual([matrices, reads], [1, 2], 'a new frame re-checks the camera but an unchanged view keeps the data')
  pass.version = 2
  assert.notEqual(pass.getReceiverData(still), first, 'a shadow re-render within the frame refreshes the data')
  assert.equal(matrices, 2)
  const moved = camera(Cesium.Matrix4.fromTranslation(new Cesium.Cartesian3(5, 0, 0)))
  pass.getReceiverData(moved)
  assert.equal(matrices, 3, 'another camera within the same frame is checked, not served stale data')
})
