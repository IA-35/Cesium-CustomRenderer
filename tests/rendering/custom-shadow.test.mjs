import test from 'node:test'
import assert from 'node:assert/strict'
import { receiverSource, casterSources, pcf } from '../../src/shadows/shaderAdapter143.js'
import ShadowCache from '../../src/shadows/ShadowCache.js'
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
  const signature = () => cache.signature(matrix, 2048, [command])
  cache.commit(signature())
  assert.equal(cache.matches(signature()), true)
  alpha = 0.2
  assert.equal(cache.matches(signature()), false)
  cache.commit(signature())
  command.modelMatrix[12] = 2
  assert.equal(cache.matches(signature()), false)
  cache.commit(signature())
  command.vertexArray = {}
  assert.equal(cache.matches(signature()), false)
  cache.commit(signature())
  command.shaderProgram.id = 2
  assert.equal(cache.matches(signature()), false)
  cache.commit(signature())
  assert.equal(cache.matches(cache.signature(matrix, 2048, [])), false)
  assert.equal(cache.matches(cache.signature(matrix, 4096, [command])), false)
  cache.invalidate()
  assert.equal(cache.matches(signature()), false)
})

test('uninitialized and deforming shaders cannot reuse static cached depth', () => {
  const cache = new ShadowCache()
  const command = { shaderProgram: { vertexShaderSource: { defines: ['HAS_SKINNING'] }, _manualUniforms: [] } }
  assert.equal(cache.signature([], 2048, [command]), null)
  command.shaderProgram._manualUniforms = undefined
  assert.equal(cache.signature([], 2048, [command]), null)
})

test('reordering identical depth casters is cacheable but changing their render pass is not', () => {
  const cache = new ShadowCache()
  const command = () => ({ vertexArray: {}, shaderProgram: { id: 1, vertexShaderSource: { defines: [] }, _manualUniforms: [] },
    renderState: { id: 1 }, pass: 5, count: 3, uniformMap: {} })
  const a = command(), b = command()
  cache.commit(cache.signature([], 1024, [a,b]))
  assert.equal(cache.matches(cache.signature([], 1024, [b,a])), true)
  b.pass = 7
  assert.equal(cache.matches(cache.signature([], 1024, [b,a])), false)
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
