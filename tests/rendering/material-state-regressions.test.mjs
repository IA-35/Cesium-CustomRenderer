import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import MaterialChannels143 from '../../src/channels/MaterialChannels143.js'

const C = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')

function fixture(renderState) {
  const pass = Object.create(MaterialChannels143.prototype)
  pass.C = { ...C, DrawCommand: { shallowClone: command => ({ ...command, execute() {} }) } }
  pass.scene = {
    context: { uniformState: { updatePass() {} }, _gl: { isContextLost: () => false } },
    mode: C.SceneMode.SCENE3D, camera: { frustum: new C.PerspectiveFrustum() },
    frameState: { frameNumber: 1, passes: { render: true } },
    _environmentState: {}, drawingBufferWidth: 16, drawingBufferHeight: 16,
    isDestroyed: () => false, requestRender() {}
  }
  const program = () => ({ isDestroyed: () => false, destroy() {} })
  pass.programs = new Map([[1, { material: false, program: program() }], [2, { material: true, program: program() }]])
  pass.states = new Map()
  pass.stats = { draws: 0, invalidators: 0 }
  pass.support = { supported: true }
  pass.enabled = true
  pass.target = { framebuffer: {}, passState: {}, width: 16, height: 16,
    normalRoughMetal: {}, emissiveFlags: {}, eyeDepth: {}, destroy() {} }
  pass.outputFrame = 1
  return { pass, unknown: { shaderProgram: { id: 1 }, renderState }, model: { shaderProgram: { id: 2 }, renderState } }
}

function cacheReferences() {
  return Object.fromEntries(Object.entries(C.RenderState.getCache()).map(([key, value]) => [key, value.referenceCount]))
}

test('depth-only model rejection remains active after an unknown command caches the same render state', () => {
  const options = { colorMask: { red: false, green: false, blue: false, alpha: false } }
  const renderState = C.RenderState.fromCache(options)
  const { pass, unknown, model } = fixture(renderState)
  try {
    assert.throws(() => pass._draw(model), /Depth-only model replay not supported/)
    pass._draw(unknown)
    assert.throws(() => pass._draw(model), /Depth-only model replay not supported/)
  } finally {
    pass.destroy()
    C.RenderState.removeFromCache(options)
  }
})

for (const cleanup of ['prune', 'disable']) {
  test(`${cleanup} releases the actual Cesium render-state cache reference without removing the caller's state`, () => {
    const options = { depthTest: { enabled: true }, polygonOffset: { enabled: true, factor: 2.25, units: 3.75 } }
    const renderState = C.RenderState.fromCache(options)
    const before = cacheReferences()
    const { pass, model } = fixture(renderState)
    try {
      pass._draw(model)
      assert.notDeepEqual(cacheReferences(), before, 'draw must acquire a material render-state reference')
      if (cleanup === 'prune') {
        pass.scene.frameState.frameNumber = 200
        pass._prune()
      } else pass.setEnabled(false)
      assert.equal(pass.states.size, 0)
      assert.deepEqual(cacheReferences(), before)
      assert.equal(C.RenderState.getCache()[JSON.stringify(options)].state, renderState)
    } finally {
      pass.destroy()
      C.RenderState.removeFromCache(options)
    }
  })
}

test('stereo WebVR fails closed instead of exposing a center-camera texture as valid', () => {
  const { pass } = fixture(undefined)
  try {
    assert.ok(pass.getTextures(), 'ordinary perspective render is supported')
    pass.scene._environmentState.useWebVR = true
    assert.match(pass._scopeReason() || '', /WebVR|stereo/i)
    assert.equal(pass.getTextures(), null)
  } finally { pass.destroy() }
})

test('transparent silhouette must fail closed rather than silently omit its visible coverage', () => {
  const options = {}, renderState = C.RenderState.fromCache(options)
  const { pass, unknown } = fixture(renderState)
  unknown.uniformMap = { model_silhouettePass: () => true }
  try { assert.throws(() => pass._draw(unknown, true), /silhouette|edge/i) }
  finally { pass.destroy(); C.RenderState.removeFromCache(options) }
})

test('unsupported transparent scope hides partial data and resumes after the command disappears', () => {
  const { pass, unknown } = fixture(undefined)
  pass.stats.frames = 0
  const state = pass.scene.context.uniformState
  Object.assign(state, { viewport: new C.BoundingRectangle(0, 0, 16, 16), pass: C.Pass.COMPUTE,
    updateCamera() {}, updateFrustum() {} })
  pass.scene.opaqueFrustumNearOffset = .9999
  const bin = { near: 1, far: 100, commands: { [C.Pass.TRANSLUCENT]: [unknown] }, indices: { [C.Pass.TRANSLUCENT]: 1 } }
  pass.scene._view = { frustumCommandsList: [bin] }
  Object.assign(pass.target, { clearAll: { execute() {} }, clearDepth: { execute() {} },
    passState: { viewport: new C.BoundingRectangle(0, 0, 16, 16) } })
  unknown.uniformMap = { model_silhouettePass: () => true }
  try {
    pass._render()
    assert.equal(pass.enabled, true)
    assert.notEqual(pass.failed, true)
    assert.equal(pass.getTextures(), null)
    assert.match(pass.reason, /silhouette/i)
    bin.indices[C.Pass.TRANSLUCENT] = 0
    pass._render()
    assert.equal(pass.outputFrame, 1)
    assert.ok(pass.getTextures())
  } finally { pass.destroy() }
})

test('recognized custom model native-depth dependencies reject before compiling a replay shader', () => {
  const options = {}, renderState = C.RenderState.fromCache(options)
  const { pass } = fixture(renderState)
  const source = { id: 9, vertexShaderSource: new C.ShaderSource({ sources: [C._shadersModelVS] }),
    fragmentShaderSource: new C.ShaderSource({ defines: ['HAS_NORMALS', 'LIGHTING_PBR', 'USE_METALLIC_ROUGHNESS'],
      sources: ['uniform sampler2D czm_globeDepthTexture;', C._shadersMaterialStageFS, C._shadersModelFS] }) }
  try { assert.throws(() => pass._draw({ shaderProgram: source, renderState }), /native depth/i) }
  finally { pass.destroy(); C.RenderState.removeFromCache(options) }
})
