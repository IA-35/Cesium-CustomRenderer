import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import MaterialChannels143, { invalidMaterialSources, transparencySources } from '../../src/channels/MaterialChannels143.js'
const C = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')

function fixture(limit = 6, failReflection = false, failOpaqueColor = false, failAlbedo = false) {
  const resources = [], compiled = []
  let albedoFailurePending = failAlbedo
  class Resource {
    constructor(options) { Object.assign(this, options); this.dead = false; resources.push(this) }
    destroy() { this.dead = true }
    isDestroyed() { return this.dead }
  }
  const context = { webgl2: true, depthTexture: true, floatingPointTexture: true, halfFloatingPointTexture: true,
    colorBufferFloat: true, colorBufferHalfFloat: true, drawBuffers: true,
    _gl: { getParameter: () => limit, bindFramebuffer() {}, isContextLost: () => false, FRAMEBUFFER_COMPLETE: 1 },
    uniformState: { viewport: new C.BoundingRectangle(0, 0, 16, 16), pass: C.Pass.COMPUTE,
      updatePass() {}, updateCamera() {}, updateFrustum() {} } }
  const scene = { context, mode: C.SceneMode.SCENE3D, camera: { frustum: new C.PerspectiveFrustum() },
    frameState: { frameNumber: 1, passes: { render: true }, commandList: [] },
    _view: { frustumCommandsList: [{ near: 1, far: 100, indices: {}, commands: {} }] },
    primitives: new C.PrimitiveCollection(), preUpdate: new C.Event(), opaqueFrustumNearOffset: .9999,
    drawingBufferWidth: 16, drawingBufferHeight: 16, requestRender() {}, isDestroyed: () => false }
  const engine = { ...C, Texture: Resource,
    Framebuffer: class extends Resource { get status() {
      if (albedoFailurePending && [5, 7, 8].includes(this.colorTextures.length)) { albedoFailurePending = false; return 0 }
      return (failReflection && this.colorTextures.length === 6) || (failOpaqueColor && this.colorTextures.length === 7) ? 0 : 1
    } },
    ClearCommand: class { execute() {} },
    ShaderProgram: { fromCache(options) { const result = new Resource(options); compiled.push(result); return result } },
    DrawCommand: { shallowClone: command => ({ ...command, execute() {} }) } }
  return { pass: new MaterialChannels143(engine, scene), scene, resources, compiled }
}

test('optional reflection layout survives toggles without changing enabled owner, hooks or Hi-Z request', () => {
  const f = fixture(), p = f.pass
  p.setEnabled(true); p._render()
  const proxy = p.proxy, base = p.target
  assert.equal(p.getTextures().reflectionSpecular, undefined)
  assert.equal(p.getDiagnostics().materialLayoutVersion, 2)
  p.depthPyramidEnabled = true
  let invalidations = 0
  p.depthPyramid = { invalidate() { invalidations++ }, release() {}, destroy() {}, update() {} }
  p.setReflectionEnabled(true)
  assert.equal(p.enabled, true)
  assert.equal(p.reflectionEnabled, true)
  assert.equal(p.proxy, proxy)
  assert.equal(base.framebuffer, undefined)
  assert.equal(p.target, undefined)
  assert.equal(p.getTextures(), null)
  assert.equal(p.depthPyramidEnabled, true)
  assert.ok(invalidations > 0)
  assert.equal(f.scene.preUpdate.numberOfListeners, 1)
  p._render()
  assert.ok(p.getTextures().reflectionSpecular)
  assert.ok(p.getTextures().reflectionResponse)
  assert.equal(p.getReflectionDiagnostics().valid, true)
  assert.equal(p.getReflectionDiagnostics().reflectionContractVersion, 1)
  assert.equal(p.target.bytes, 37 * 16 * 16)
  f.scene.drawingBufferWidth = 8
  p._render()
  assert.equal(p.target.bytes, 37 * 8 * 16)
  p.setReflectionEnabled(false); p._render()
  assert.equal(p.target.bytes, 21 * 8 * 16)
  assert.equal(p.getTextures().reflectionSpecular, undefined)
  assert.equal(p.getReflectionDiagnostics().requested, false)
  p.destroy(); f.scene.primitives.destroy()
})

test('insufficient MRT slots preserve valid base channels and report the unsupported reflection request', () => {
  const { pass: p, scene } = fixture(4)
  p.setReflectionEnabled(true); p.setEnabled(true); p._render()
  assert.equal(p.getDiagnostics().valid, true)
  assert.equal(p.reflectionEnabled, false)
  assert.equal(p.getReflectionDiagnostics().requested, true)
  assert.equal(p.getReflectionDiagnostics().supported, false)
  assert.match(p.getReflectionDiagnostics().reason, />= 6/)
  assert.equal(p.target.bytes, 21 * 16 * 16)
  p.destroy(); scene.primitives.destroy()
})

test('six-attachment completeness failure falls back to base without disabling the producer', () => {
  const { pass: p, scene, resources } = fixture(6, true)
  p.setReflectionEnabled(true); p.setEnabled(true); p._render()
  assert.equal(p.enabled, true)
  assert.equal(p.getDiagnostics().valid, true)
  assert.equal(p.getReflectionDiagnostics().valid, false)
  assert.match(p.getReflectionDiagnostics().error, /incomplete/)
  assert.equal(p.target.bytes, 21 * 16 * 16)
  assert.ok(resources.slice(0, 8).every(r => r.dead))
  p.destroy(); scene.primitives.destroy()
})

test('layout changes cannot reuse shader programs across four, six and seven outputs', () => {
  const { pass: p, scene, compiled } = fixture(7)
  const options = {}, state = C.RenderState.fromCache(options)
  const command = { pass: C.Pass.OPAQUE, renderState: state, shaderProgram: { id: 9,
    vertexShaderSource: new C.ShaderSource({ sources: [C._shadersModelVS] }),
    fragmentShaderSource: new C.ShaderSource({ defines: ['LIGHTING_PBR', 'HAS_NORMALS'], sources: [C._shadersMaterialStageFS, C._shadersModelFS] }) } }
  p.setEnabled(true); p._render(); p._draw(command)
  assert.doesNotMatch(compiled[0].fragmentShaderSource.sources.join('\n'), /location = 4/)
  p.setReflectionEnabled(true); p._render(); p._draw(command)
  assert.equal(compiled[0].dead, true)
  assert.match(compiled[1].fragmentShaderSource.sources.join('\n'), /location = 4/)
  p.setOpaqueColorEnabled(true); p._render(); p._draw(command)
  assert.equal(compiled[1].dead, true)
  assert.match(compiled[2].fragmentShaderSource.sources.join('\n'), /location = 6/)
  p.destroy(); scene.primitives.destroy(); C.RenderState.removeFromCache(options)
})

test('unknown opaque surfaces clear optional reflection outputs; transparent coverage never writes them', () => {
  const program = { vertexShaderSource: new C.ShaderSource({ sources: ['void main(){gl_Position=vec4(0.0);}'] }),
    fragmentShaderSource: new C.ShaderSource({ sources: ['void main(){out_FragColor=vec4(1.0);}'] }) }
  const source = invalidMaterialSources(C, program, true).fragmentShaderSource.sources.join('\n')
  assert.match(source, /layout\(location = 4\) out vec4 campus_reflectionSpecularOutput;/)
  assert.match(source, /campus_reflectionSpecularOutput = vec4\(0\.0\);/)
  assert.match(source, /campus_reflectionResponse = vec4\(0\.0\);/)
  assert.doesNotMatch(invalidMaterialSources(C, program).fragmentShaderSource.sources.join('\n'), /reflection/)
  assert.doesNotMatch(transparencySources(C, program).fragmentShaderSource.sources.join('\n'), /reflection/)
})

test('opaque color request waits for reflection and switches layouts without changing other requests', () => {
  const { pass: p, scene } = fixture(7)
  p.setOpaqueColorEnabled(true); p.setEnabled(true); p._render()
  const baseKeys = Object.keys(p.getTextures())
  assert.equal(p.opaqueColorEnabled, false)
  assert.equal(p.getOpaqueColorDiagnostics().requested, true)
  assert.match(p.getOpaqueColorDiagnostics().reason, /reflection/i)
  assert.equal(p.target.bytes, 21 * 16 * 16)
  p.setReflectionEnabled(true); p._render()
  assert.equal(p.opaqueColorEnabled, true)
  assert.ok(p.getTextures().opaqueColor)
  assert.equal(p.getOpaqueColorDiagnostics().valid, true)
  assert.equal(p.getDiagnostics().opaqueColorContractVersion, 1)
  assert.equal(p.target.bytes, 45 * 16 * 16)
  const proxy = p.proxy, target = p.target
  p.depthPyramidEnabled = true
  p.depthPyramid = { invalidate() {}, release() {}, destroy() {}, update() {} }
  p.setOpaqueColorEnabled(false)
  assert.equal(target.framebuffer, undefined)
  assert.equal(p.getTextures(), null)
  assert.equal(p.proxy, proxy)
  assert.equal(p.reflectionRequested, true)
  assert.equal(p.depthPyramidEnabled, true)
  p._render()
  assert.deepEqual(Object.keys(p.getTextures()), [...baseKeys, 'reflectionSpecular', 'reflectionResponse'])
  assert.equal(p.target.bytes, 37 * 16 * 16)
  p.setOpaqueColorEnabled(true); p.setReflectionEnabled(false); p._render()
  assert.deepEqual(Object.keys(p.getTextures()), baseKeys)
  assert.equal(p.getOpaqueColorDiagnostics().requested, true)
  p.destroy(); scene.primitives.destroy()
})

test('missing seventh slot or failed seven-attachment framebuffer preserves six-attachment reflections', () => {
  for (const [limit, fails] of [[6, false], [7, true]]) {
    const { pass: p, scene } = fixture(limit, false, fails)
    p.setReflectionEnabled(true); p.setOpaqueColorEnabled(true); p.setEnabled(true); p._render()
    assert.equal(p.getDiagnostics().valid, true)
    assert.equal(p.getReflectionDiagnostics().valid, true)
    assert.equal(p.getOpaqueColorDiagnostics().valid, false)
    assert.equal(p.getOpaqueColorDiagnostics().requested, true)
    assert.equal('opaqueColor' in p.getTextures(), false)
    assert.equal(p.target.bytes, 37 * 16 * 16)
    if (fails) assert.match(p.getOpaqueColorDiagnostics().error, /incomplete/)
    else assert.match(p.getOpaqueColorDiagnostics().reason, />= 7/)
    p.destroy(); scene.primitives.destroy()
  }
})

test('unknown opaque invalidation clears native color but transparency has no seventh output', () => {
  const program = { vertexShaderSource: new C.ShaderSource({ sources: ['void main(){gl_Position=vec4(0.0);}'] }),
    fragmentShaderSource: new C.ShaderSource({ sources: ['void main(){out_FragColor=vec4(1.0);}'] }) }
  const source = invalidMaterialSources(C, program, true, true).fragmentShaderSource.sources.join('\n')
  assert.match(source, /layout\(location = 6\) out vec4 campus_opaqueColor;/)
  assert.match(source, /campus_opaqueColor = vec4\(0\.0\);/)
  assert.match(source, /campus_materialDepth = -1\.0;/)
  assert.doesNotMatch(transparencySources(C, program).fragmentShaderSource.sources.join('\n'), /campus_opaqueColor/)
})

test('failures in both optional layouts stop at a valid four-attachment base', () => {
  const { pass: p, scene } = fixture(7, true, true)
  p.setReflectionEnabled(true); p.setOpaqueColorEnabled(true); p.setEnabled(true); p._render()
  assert.equal(p.getDiagnostics().valid, true)
  assert.equal(p.target.bytes, 21 * 16 * 16)
  assert.equal(p.opaqueColorEnabled, false)
  assert.equal(p.reflectionEnabled, false)
  assert.match(p.getOpaqueColorDiagnostics().error, /incomplete/)
  assert.match(p.getReflectionDiagnostics().error, /incomplete/)
  assert.equal(p.opaqueColorRequested, true)
  assert.equal(p.reflectionRequested, true)
  p.destroy(); scene.primitives.destroy()
})

test('albedo request switches independently across 5, 7 and 8 attachment layouts', () => {
  const { pass: p, scene } = fixture(8)
  p.setEnabled(true); p._render()
  const proxy = p.proxy, baseKeys = Object.keys(p.getTextures())
  p.setAlbedoEnabled(true); p._render()
  assert.equal(p.target.framebuffer.colorTextures.length, 5)
  assert.equal(p.target.framebuffer.colorTextures[4], p.target.albedoOcclusion)
  assert.equal(p.target.bytes, 29 * 16 * 16)
  p.setReflectionEnabled(true); p._render()
  assert.equal(p.target.framebuffer.colorTextures.length, 7)
  assert.equal(p.target.framebuffer.colorTextures[6], p.target.albedoOcclusion)
  p.setOpaqueColorEnabled(true); p._render()
  assert.equal(p.target.framebuffer.colorTextures.length, 8)
  assert.equal(p.target.framebuffer.colorTextures[7], p.target.albedoOcclusion)
  assert.equal(p.proxy, proxy)
  assert.deepEqual(Object.keys(p.getTextures()), [...baseKeys, 'reflectionSpecular', 'reflectionResponse', 'opaqueColor', 'albedoOcclusion'])
  assert.equal(p.getAlbedoDiagnostics().valid, true)
  assert.equal(p.getAlbedoDiagnostics().albedoContractVersion, 1)
  p.setAlbedoEnabled(false); p._render()
  assert.equal(p.target.framebuffer.colorTextures.length, 7)
  assert.equal('albedoOcclusion' in p.getTextures(), false)
  assert.equal(p.reflectionRequested, true)
  assert.equal(p.opaqueColorRequested, true)
  p.destroy(); scene.primitives.destroy()
})

test('insufficient albedo slots and allocation failures retain the existing 4, 6 or 7 layout', () => {
  for (const [limit, reflection, opaqueColor, expected] of [[4, false, false, 4], [6, true, false, 6], [7, true, true, 7]]) {
    for (const failAlbedo of [false, true]) {
      const actualLimit = failAlbedo ? expected + 1 : limit
      const { pass: p, scene } = fixture(actualLimit, false, false, failAlbedo)
      p.setReflectionEnabled(reflection)
      p.setOpaqueColorEnabled(opaqueColor)
      p.setAlbedoEnabled(true)
      p.setEnabled(true); p._render()
      assert.equal(p.getDiagnostics().valid, true)
      assert.equal(p.target.framebuffer.colorTextures.length, expected)
      assert.equal(p.getAlbedoDiagnostics().requested, true)
      assert.equal(p.getAlbedoDiagnostics().valid, false)
      assert.equal(p.getReflectionDiagnostics().valid, reflection)
      assert.equal(p.getOpaqueColorDiagnostics().valid, opaqueColor)
      if (failAlbedo) assert.match(p.getAlbedoDiagnostics().error, /incomplete/)
      else assert.match(p.getAlbedoDiagnostics().reason, new RegExp(`>= ${expected + 1}`))
      p.setAlbedoEnabled(false); p.setAlbedoEnabled(true); p._render()
      assert.equal(p.getAlbedoDiagnostics().valid, failAlbedo)
      p.destroy(); scene.primitives.destroy()
    }
  }
})

test('all material program cache keys distinguish albedo from legacy layouts', () => {
  const { pass: p, scene, compiled } = fixture(8)
  const options = {}, state = C.RenderState.fromCache(options)
  const command = { pass: C.Pass.OPAQUE, renderState: state, shaderProgram: { id: 17,
    vertexShaderSource: new C.ShaderSource({ sources: [C._shadersModelVS] }),
    fragmentShaderSource: new C.ShaderSource({ defines: ['LIGHTING_PBR', 'USE_METALLIC_ROUGHNESS', 'HAS_NORMALS'], sources: [C._shadersMaterialStageFS, C._shadersModelFS] }) } }
  p.setEnabled(true); p._render(); p._draw(command)
  p.setAlbedoEnabled(true); p._render(); p._draw(command)
  p.setReflectionEnabled(true); p._render(); p._draw(command)
  p.setOpaqueColorEnabled(true); p._render(); p._draw(command)
  assert.equal(compiled.length, 4)
  assert.equal(new Set(compiled.map(program => program.fragmentShaderSource.sources.join('\n').match(/location = [4-7]/g)?.join(',') || 'base')).size, 4)
  assert.ok(compiled.slice(0, -1).every(program => program.dead))
  p.destroy(); scene.primitives.destroy(); C.RenderState.removeFromCache(options)
})
