import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import MaterialChannels143, { replayMaterialFrusta, invalidMaterialSources, transparencySources } from '../../src/channels/MaterialChannels143.js'
const C = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')

function fixture() {
  const calls = []
  const frustum = new C.PerspectiveFrustum({ near: 1, far: 10000 })
  const makeBin = (near, far, items) => ({ near, far,
    commands: { [C.Pass.OPAQUE]: [...items, { name: 'stale-slot' }] }, indices: { [C.Pass.OPAQUE]: items.length } })
  const repeated = { name: 'overlapping' }
  const camera = { frustum }
  const state = { viewport: new C.BoundingRectangle(0, 0, 800, 600), pass: C.Pass.COMPUTE,
    updateCamera(c) { calls.push(['camera', c === camera]) },
    updateFrustum(f) { calls.push(['frustum', f.near, f.far]) },
    updatePass(p) { this.pass = p; calls.push(['pass', p]) } }
  const scene = { camera, context: { uniformState: state }, opaqueFrustumNearOffset: .9999,
    _view: { frustumCommandsList: [makeBin(1, 100, [repeated, { name: 'near' }]), makeBin(100, 10000, [repeated, { name: 'far' }])] },
    _environmentState: {} }
  const target = { passState: { viewport: new C.BoundingRectangle(0, 0, 800, 600) },
    clearAll: { execute() { calls.push(['clear-all']) } }, clearDepth: { execute() { calls.push(['clear-depth']) } } }
  return { calls, scene, target, state, camera }
}

test('material replay preserves far-to-near bins, repeated commands, active indices and restores uniforms', () => {
  const f = fixture()
  replayMaterialFrusta(C, f.scene, f.target, command => f.calls.push(['draw', command.name]))
  assert.deepEqual(f.calls.filter(c => c[0] === 'draw').map(c => c[1]), ['overlapping', 'far', 'overlapping', 'near'])
  assert.equal(f.calls.filter(c => c[0] === 'clear-all').length, 1)
  assert.equal(f.calls.filter(c => c[0] === 'clear-depth').length, 2)
  assert.deepEqual(f.calls.filter(c => c[0] === 'frustum').slice(0, 4), [['frustum', 99.99, 10000], ['frustum', 100, 10000], ['frustum', 1, 100], ['frustum', 1, 100]])
  assert.equal(f.state.pass, C.Pass.COMPUTE)
  assert.equal(f.camera.frustum.near, 1)
  assert.equal(f.camera.frustum.far, 10000)
})

test('draw failure restores camera, full frustum, pass and viewport', () => {
  const f = fixture()
  assert.throws(() => replayMaterialFrusta(C, f.scene, f.target, () => { throw new Error('compile failed') }), /compile failed/)
  assert.deepEqual(f.calls.slice(-3), [['camera', true], ['frustum', 1, 10000], ['pass', C.Pass.COMPUTE]])
  assert.deepEqual(f.state.viewport, new C.BoundingRectangle(0, 0, 800, 600))
})

test('transparent coverage follows opaque in each frustum without overwriting material data', () => {
  const f = fixture()
  for (const [i, bin] of f.scene._view.frustumCommandsList.entries()) {
    bin.commands[C.Pass.TRANSLUCENT] = [{ name: `transparent-${i}` }]
    bin.indices[C.Pass.TRANSLUCENT] = 1
  }
  replayMaterialFrusta(C, f.scene, f.target, (command, transparent) => f.calls.push(['draw', command.name, !!transparent]))
  assert.deepEqual(f.calls.filter(c => c[0] === 'draw').map(c => c.slice(1)), [
    ['overlapping', false], ['far', false], ['transparent-1', true], ['overlapping', false], ['near', false], ['transparent-0', true]
  ])
})

test('transparent coverage retains original alpha discard and log depth, writes only its own output', () => {
  const vertex = new C.ShaderSource({ sources: ['void main(){gl_Position=vec4(1.0);}'] })
  const fragment = new C.ShaderSource({ defines: ['LOG_DEPTH'], sources: ['void main(){if(gl_FragCoord.x<1.0)discard;out_FragColor=vec4(0.5);czm_writeLogDepth();}'] })
  const sources = transparencySources(C, { vertexShaderSource: vertex, fragmentShaderSource: fragment })
  assert.equal(sources.vertexShaderSource, vertex)
  const text = sources.fragmentShaderSource.sources.join('\n')
  assert.match(text, /discard/)
  assert.match(text, /campus_transparency_main\(\);/)
  assert.match(text, /out_FragColor = vec4\(1\.0\)/)
  assert.doesNotMatch(text, /layout\(location/)
  assert.deepEqual(fragment.defines, ['LOG_DEPTH'])
})

test('native-depth-dependent transparency fails closed rather than reading stale main depth', () => {
  for (const stage of ['vertexShaderSource', 'fragmentShaderSource']) {
    const program = { vertexShaderSource: new C.ShaderSource({ sources: ['void main(){gl_Position=vec4(0.0);}'] }),
      fragmentShaderSource: new C.ShaderSource({ sources: ['void main(){out_FragColor=vec4(1.0);}'] }) }
    program[stage].sources.unshift('uniform sampler2D czm_globeDepthTexture;')
    assert.throws(() => transparencySources(C, program), /native depth/i)
    assert.throws(() => invalidMaterialSources(C, program), /native depth/i)
  }
})

test('unknown opaque shader invalidates all material attachments after original discard/depth code', () => {
  const vertex = new C.ShaderSource({ sources: ['void main(){gl_Position=vec4(1.0);}'] })
  const source = new C.ShaderSource({ defines: ['LOG_DEPTH'], sources: ['void main(){ if(gl_FragCoord.x<1.0)discard;out_FragColor=vec4(1.0);czm_writeLogDepth();}'] })
  const result = invalidMaterialSources(C, { vertexShaderSource: vertex, fragmentShaderSource: source })
  assert.equal(result.vertexShaderSource, vertex)
  const text = result.fragmentShaderSource.sources.join('\n')
  assert.match(text, /campus_invalid_main/)
  assert.match(text, /discard/)
  assert.match(text, /czm_writeLogDepth/)
  assert.match(text, /campus_materialEmissiveFlags = vec4\(0\.0\)/)
  assert.match(text, /campus_materialDepth = -1\.0/)
  assert.deepEqual(source.defines, ['LOG_DEPTH'])
})

test('unknown opaque shader clears dynamic albedo output while transparency writes no albedo attachment', () => {
  const program = { vertexShaderSource: new C.ShaderSource({ sources: ['void main(){gl_Position=vec4(0.0);}'] }),
    fragmentShaderSource: new C.ShaderSource({ sources: ['void main(){out_FragColor=vec4(1.0);}'] }) }
  for (const [reflection, opaqueColor, location] of [[false, false, 4], [true, false, 6], [true, true, 7]]) {
    const source = invalidMaterialSources(C, program, reflection, opaqueColor, true).fragmentShaderSource.sources.join('\n')
    assert.match(source, new RegExp(`layout\\(location = ${location}\\) out vec4 campus_albedoOcclusion;`))
    assert.match(source, /campus_albedoOcclusion = vec4\(0\.0\);/)
    assert.match(source, /campus_materialDepth = -1\.0;/)
  }
  assert.doesNotMatch(transparencySources(C, program).fragmentShaderSource.sources.join('\n'), /campus_albedoOcclusion/)
})

test('failed material allocation removes hooks/resources and only retries after an explicit off-on transition', () => {
  let attempts = 0
  const context = { webgl2: true, depthTexture: true, floatingPointTexture: true, halfFloatingPointTexture: true,
    colorBufferFloat: true, colorBufferHalfFloat: true, drawBuffers: true,
    _gl: { getParameter: () => 4, bindFramebuffer() {}, isContextLost: () => false } }
  const scene = { context, mode: C.SceneMode.SCENE3D, camera: { frustum: new C.PerspectiveFrustum() },
    frameState: { frameNumber: 1, passes: { render: true }, commandList: [] },
    _view: { frustumCommandsList: [{ indices: {}, commands: {} }] },
    primitives: new C.PrimitiveCollection(), preUpdate: new C.Event(),
    drawingBufferWidth: 16, drawingBufferHeight: 16, requestRender() {}, isDestroyed: () => false }
  const engine = { ...C, Texture: class { constructor() { attempts++; throw new Error('out of memory') } } }
  const pass = new MaterialChannels143(engine, scene)
  assert.equal(scene.primitives.length, 0)
  pass.setEnabled(true)
  pass._update(scene.frameState)
  assert.equal(scene.frameState.commandList.length, 1)
  scene.frameState.commandList[0].execute()
  assert.equal(attempts, 1)
  assert.equal(pass.getDiagnostics().error, 'out of memory')
  assert.equal(pass.getTextures(), null)
  assert.equal(scene.primitives.length, 0)
  assert.equal(scene.preUpdate.numberOfListeners, 0)
  pass.setEnabled(true)
  assert.equal(scene.primitives.length, 0)
  pass.setEnabled(false); pass.setEnabled(true); pass._render()
  assert.equal(attempts, 2)
  pass.destroy(); pass.destroy()
  scene.primitives.destroy()
})
