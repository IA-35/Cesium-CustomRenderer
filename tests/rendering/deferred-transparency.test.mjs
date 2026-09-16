// B03 unit tests for TransparentForward143.
//
// The rendered-result proof lives in scripts/check-deferred-transparency.cjs (needs a GPU). What is
// testable here is the contract that made that proof possible, and specifically the four defects B03
// hit: each of them silently produced "patch compiled but never applied", so each gets a regression
// test rather than only a comment.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import TransparentForward143 from '../../src/pipeline/TransparentForward143.js'

function fakeCesium() {
  let nextProgramId = 100
  return {
    VERSION: '1.143.0',
    Pass: { TRANSLUCENT: 9, OPAQUE: 7 },
    Matrix4: { IDENTITY: { identity: true } },
    Cartesian4: class Cartesian4 { constructor(x, y, z, w) { Object.assign(this, { x, y, z, w }) } },
    PixelFormat: { RGBA: 6408 },
    PixelDatatype: { UNSIGNED_BYTE: 5121 },
    // `receiverSource` builds a real ShaderSource for the patched fragment stage, so the stub needs one.
    ShaderSource: class ShaderSource {
      constructor({ defines = [], sources = [] } = {}) {
        this.defines = [...defines]
        this.sources = [...sources]
      }
      clone() { return new ShaderSource({ defines: this.defines, sources: this.sources }) }
    },
    Texture: class Texture { constructor() { this.destroyed = false } isDestroyed() { return this.destroyed } destroy() { this.destroyed = true } },
    // Deterministic ids, and one object per source id: the real engine returns the same cached program
    // for the same input, and `programFor` memoises on that basis. A fake returning a fresh object each
    // call made the record/program identity checks meaningless.
    ShaderProgram: {
      _cache: new Map(),
      fromCache({ fragmentShaderSource }) {
        const key = JSON.stringify(fragmentShaderSource ? fragmentShaderSource.sources : [])
        if (!this._cache.has(key)) {
          this._cache.set(key, { id: nextProgramId++, isDestroyed: () => false, destroy() {}, _bind() {}, fragmentShaderSource })
        }
        return this._cache.get(key)
      },
    },
  }
}

function fakeScene({ failContext = false } = {}) {
  const scene = {
    frameState: { frameNumber: 1, passes: { render: true, pick: false, depth: false } },
    context: {
      drawingBufferWidth: 640, drawingBufferHeight: 420,
      _gl: { isContextLost: () => false, getParameter: () => null, useProgram() {} },
      isDestroyed: () => false,
    },
    _view: { frustumCommandsList: [{ indices: { 9: 0 }, commands: { 9: [] } }] },
    requestRender() { this.renders = (this.renders || 0) + 1 },
  }
  if (failContext) scene.context = undefined
  return scene
}

/** A translucent command whose shader exposes the PBR markers the adapter looks for. */
function translucentCommand(C, id = 22) {
  return {
    pass: C.Pass.TRANSLUCENT,
    shaderProgram: {
      id,
      vertexShaderSource: new C.ShaderSource({ sources: ['void main() {}'] }),
      fragmentShaderSource: new C.ShaderSource({
        defines: ['LIGHTING_PBR'],
        // The exact marker `receiverSource` keys on; without it the shader is out of scope by design.
        sources: ['void main() {}\nvec3 directColor = lightColorHdr * directLighting;'],
      }),
      _attributeLocations: {},
    },
    uniformMap: { model_existing: () => 1 },
    dirty: false,
  }
}

test('rejects a Cesium version it was not verified against', () => {
  const C = fakeCesium()
  C.VERSION = '1.144.0'
  assert.throws(() => new TransparentForward143({ Cesium: C, scene: fakeScene() }), /requires Cesium 1\.143/)
})

test('requires an explicit Cesium and scene', () => {
  assert.throws(() => new TransparentForward143({}), /requires \{ Cesium, scene \}/)
})

test('a retained patched command refreshes shadow bindings on later frames',()=>{
 const C=fakeCesium(),scene=fakeScene();let shadow=null
 const pass=new TransparentForward143({Cesium:C,scene,isDeferredActive:()=>true,getShadowVisibility:()=>shadow})
 pass.enabled=true;const command=translucentCommand(C);pass.applyTo(command)
 shadow={texture:{},matrix:{},params:new C.Cartesian4(1,0,100,1)}
 scene.frameState.frameNumber++;pass.applyTo(command)
 assert.equal(command.uniformMap.campus_shadowParams().w,1)
 assert.equal(pass.getDiagnostics().valid,true)
 shadow=null;assert.equal(command.uniformMap.campus_shadowParams().w,0)
})

test('inactive scope and pass changes restore previously patched commands',()=>{
 const C=fakeCesium(),scene=fakeScene();let active=true
 const pass=new TransparentForward143({Cesium:C,scene,isDeferredActive:()=>active});pass.enabled=true
 const command=translucentCommand(C),original=command.shaderProgram
 pass.applyTo(command);active=false;pass.applyTo(command)
 assert.equal(command.shaderProgram,original)
 active=true;pass.applyTo(command);command.pass=C.Pass.OPAQUE;pass.applyTo(command)
 assert.equal(command.shaderProgram,original)
})

test('direct destruction detaches bridge and registered callbacks',()=>{
 const pass=new TransparentForward143({Cesium:fakeCesium(),scene:fakeScene()});let released=0
 pass.bridge={destroy(){released++}};pass.offCommand=()=>released++;pass.offResolve=()=>released++
 pass.destroy();pass.destroy();assert.equal(released,3)
})

test('an empty subsequent frame clears patch counters and explains invalid output',()=>{
 const C=fakeCesium(),scene=fakeScene(),pass=new TransparentForward143({Cesium:C,scene,isDeferredActive:()=>true})
 pass.enabled=true;pass.applyTo(translucentCommand(C));scene.frameState.frameNumber++;pass.endFrame()
 assert.equal(pass.stats.patchedCommands,0);assert.equal(pass.getDiagnostics().valid,false)
 assert.equal(pass.getDiagnostics().reason,'No patchable translucent draws')
})

test('reports the ordering-safe scope reason instead of requiring a rendered frame', () => {
  // Regression for a real defect: `scopeReason` originally required the deferred pass to have already
  // rendered *this* frame. Translucent commands are derived before the opaque pass runs, so that
  // predicate rejected every automatic per-command call -- the patch compiled and worked by hand but
  // never ran in a real frame.
  const C = fakeCesium()
  const scene = fakeScene()
  let active = true
  const pass = new TransparentForward143({ Cesium: C, scene, isDeferredActive: () => active })
  pass.enabled = true
  pass.outputFrame = undefined
  assert.equal(pass.scopeReason(), null, 'a not-yet-rendered frame must not block patching')
  active = false
  assert.equal(pass.scopeReason(), 'Deferred opaque lighting is not active')
})

test('a command without the PBR lighting markers is left alone and counted as compatibility', () => {
  const C = fakeCesium()
  const scene = fakeScene()
  const pass = new TransparentForward143({ Cesium: C, scene, isDeferredActive: () => true })
  pass.enabled = true
  const command = translucentCommand(C)
  command.shaderProgram.fragmentShaderSource.sources = ['void main() {}']
  pass.applyTo(command)
  assert.equal(command.shaderProgram.id, 22, 'the native shader must be untouched')
  assert.equal(pass.stats.patchedCommands, 0)
  assert.equal(pass.stats.compatibilityCommands, 1)
})

test('binding always provides a setter for every uniform the patch declares', () => {
  // Regression: the shadow helpers compile into the patched shader unconditionally, so omitting these
  // when no shadow pass exists threw "e[c.name] is not a function" at draw time.
  const C = fakeCesium()
  const scene = fakeScene()
  const pass = new TransparentForward143({ Cesium: C, scene, isDeferredActive: () => true, getShadowVisibility: () => null })
  pass.enabled = true
  const command = translucentCommand(C)
  pass.applyTo(command)
  for (const name of ['campus_shadowDepth', 'campus_eyeToShadow', 'campus_shadowParams']) {
    assert.equal(typeof command.uniformMap[name], 'function', `${name} must always have a setter`)
  }
  // With no shadow pass the params must signal "no shadows" so the placeholder is never sampled.
  assert.equal(command.uniformMap.campus_shadowParams().w, 0)
  // Original uniforms must survive the merge.
  assert.equal(command.uniformMap.model_existing(), 1)
})

test('a shadow pass supplies real shadow inputs', () => {
  const C = fakeCesium()
  const scene = fakeScene()
  const texture = { shadow: true }
  const matrix = { shadowMatrix: true }
  const params = new C.Cartesian4(0.001, 2, 100, 1)
  const pass = new TransparentForward143({
    Cesium: C, scene, isDeferredActive: () => true,
    getShadowVisibility: () => ({ texture, matrix, params }),
  })
  pass.enabled = true
  const command = translucentCommand(C)
  pass.applyTo(command)
  assert.equal(command.uniformMap.campus_shadowDepth(), texture)
  assert.equal(command.uniformMap.campus_eyeToShadow(), matrix)
  assert.equal(command.uniformMap.campus_shadowParams(), params)
})

test('restoring returns the original shader and uniform map', () => {
  const C = fakeCesium()
  const scene = fakeScene()
  const pass = new TransparentForward143({ Cesium: C, scene, isDeferredActive: () => true })
  pass.enabled = true
  const command = translucentCommand(C)
  const originalShader = command.shaderProgram
  const originalUniforms = command.uniformMap
  pass.applyTo(command)
  assert.notEqual(command.shaderProgram, originalShader)
  const record = pass.commands.get(command)
  pass.restore(command, record)
  assert.equal(command.shaderProgram, originalShader)
  assert.equal(command.uniformMap, originalUniforms)
})

test('endFrame releases commands that are no longer in the translucent bin', () => {
  // Regression: without this a command whose material or pass changed would keep the patched shader,
  // which is the "residual from the previous frame" failure the acceptance gate checks.
  const C = fakeCesium()
  const scene = fakeScene()
  const pass = new TransparentForward143({ Cesium: C, scene, isDeferredActive: () => true })
  pass.enabled = true
  const command = translucentCommand(C)
  const originalShader = command.shaderProgram
  scene._view.frustumCommandsList[0].indices[9] = 1
  scene._view.frustumCommandsList[0].commands[9] = [command]
  pass.applyTo(command)
  assert.equal(pass.commands.size, 1)

  // Still translucent: keep it.
  pass.endFrame()
  assert.equal(pass.commands.size, 1)
  assert.equal(pass.stats.trackedCommands, 1)

  // Now the bin no longer contains it: release and restore.
  scene._view.frustumCommandsList[0].indices[9] = 0
  scene._view.frustumCommandsList[0].commands[9] = []
  pass.endFrame()
  assert.equal(pass.commands.size, 0)
  assert.equal(command.shaderProgram, originalShader, 'the native shader must be restored')
})

test('disabling releases every patch and frees resources', () => {
  const C = fakeCesium()
  const scene = fakeScene()
  const pass = new TransparentForward143({ Cesium: C, scene, isDeferredActive: () => true })
  pass.enabled = true
  const command = translucentCommand(C)
  const originalShader = command.shaderProgram
  pass.applyTo(command)
  assert.ok(pass.programs.size > 0)
  pass.release()
  assert.equal(pass.commands.size, 0)
  assert.equal(pass.programs.size, 0)
  assert.equal(command.shaderProgram, originalShader)
  assert.equal(pass._white, undefined)
})

test('diagnostics declare themselves partial rather than complete', () => {
  const C = fakeCesium()
  const scene = fakeScene()
  const pass = new TransparentForward143({ Cesium: C, scene, isDeferredActive: () => true })
  pass.enabled = true
  const diagnostics = pass.getDiagnostics()
  assert.equal(diagnostics.partial, true, 'this pass shares terms but is not an independent transparent lighting model')
  assert.match(diagnostics.contract, /direct term/)
  assert.match(diagnostics.coverage, /OIT/)
})

test('a destroyed instance refuses to enable and reports so', () => {
  const C = fakeCesium()
  const scene = fakeScene()
  const pass = new TransparentForward143({ Cesium: C, scene, isDeferredActive: () => true })
  pass.destroy()
  assert.equal(pass.destroyed, true)
  pass.setEnabled(true)
  assert.equal(pass.enabled, false, 'a destroyed pass must not re-enable')
  assert.equal(pass.scopeReason(), 'Destroyed')
})
