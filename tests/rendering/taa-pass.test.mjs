import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import TaaJitter143 from '../../src/antialiasing/TaaJitter143.js'
import TaaPass143, { taaBlendWeights, taaVarianceGammas } from '../../src/antialiasing/TaaPass143.js'
import { taaResolveShader, taaDepthShader, taaDisplayShader, taaCommon } from '../../src/antialiasing/taaShaders143.js'

const C = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')

const resolution = { width: 1920, height: 1080 }

function frustumScene() {
  const frustum = new C.PerspectiveFrustum({ fov: Math.PI / 3, aspectRatio: 16 / 9, near: 1, far: 500000 })
  return { frustum, scene: { camera: { frustum }, drawingBufferWidth: resolution.width,
    drawingBufferHeight: resolution.height, isDestroyed: () => false,
    // The jitter needs the publication path to reach the drawing frustum; a scene without it
    // is covered by the taa-jitter tests.
    context: { uniformState: { updateFrustum() {} } } } }
}

function project(matrix, eye) {
  const clip = C.Matrix4.multiplyByVector(matrix, new C.Cartesian4(eye[0], eye[1], eye[2], 1), new C.Cartesian4())
  return [clip.x / clip.w, clip.y / clip.w]
}

// The jitter is the whole reason temporal anti-aliasing removes edges a single frame cannot
// resolve. If the offsets did not actually move the projection matrix, the pass would run,
// report healthy diagnostics and change nothing on screen, so this is asserted through the
// real Cesium frustum rather than through the helper's own arithmetic.
test('the jitter moves the real projection matrix by exactly the requested sub-pixel offset', () => {
  const { frustum, scene } = frustumScene()
  const base = C.Matrix4.clone(frustum.projectionMatrix, new C.Matrix4())
  const jitter = new TaaJitter143(C, scene, { samples: 8 })
  jitter.setEnabled(true)
  assert.equal(jitter.apply(), true)

  const sample = jitter.getDiagnostics().pixel
  const [baseX, baseY] = project(base, [0, 0, -100])
  const [jitteredX, jitteredY] = project(frustum.projectionMatrix, [0, 0, -100])
  assert.ok(Math.abs((jitteredX - baseX) - 2 * sample.x / resolution.width) < 1e-9, 'x shift is one pixel wide')
  assert.ok(Math.abs((jitteredY - baseY) - 2 * sample.y / resolution.height) < 1e-9, 'y shift is one pixel tall')
  assert.ok(Math.abs(sample.x) <= 0.5 && Math.abs(sample.y) <= 0.5)

  // Half a pixel of jitter must not travel further than the pixel it belongs to.
  const halfPixelX = 2 * 0.5 / resolution.width
  assert.ok(Math.abs(jitteredX - baseX) <= halfPixelX + 1e-12)
  jitter.destroy()
})

test('the jitter cycles through distinct offsets and releases the original values', () => {
  const { frustum, scene } = frustumScene()
  const base = C.Matrix4.clone(frustum.projectionMatrix, new C.Matrix4())
  const jitter = new TaaJitter143(C, scene, { samples: 8 })
  jitter.setEnabled(true)
  const seen = new Set()
  for (let frame = 0; frame < 8; frame++) {
    assert.equal(jitter.apply(), true)
    seen.add(`${frustum.xOffset},${frustum.yOffset}`)
  }
  // A stuck sequence would look like a working pass that never anti-aliases anything.
  assert.equal(seen.size, 8)
  assert.equal(jitter.getDiagnostics().frames, 8)

  jitter.setEnabled(false)
  assert.equal(frustum.xOffset, 0)
  assert.equal(frustum.yOffset, 0)
  assert.ok(C.Matrix4.equals(frustum.projectionMatrix, base), 'restored projection matches the original')
  assert.equal(jitter.getDiagnostics().holding, false)
  jitter.destroy()
})

test('the jitter refuses unusable cameras and never clobbers a foreign offset', () => {
  const { frustum, scene } = frustumScene()
  const jitter = new TaaJitter143(C, scene, {})
  jitter.setEnabled(true)
  assert.equal(jitter.apply(), true)

  // Another system owns the offset while we are not holding: our restore must not resurrect
  // the value we saw earlier, and the next apply must capture the new baseline.
  jitter.restore()
  frustum.xOffset = 0.25
  assert.equal(jitter.apply(), true)
  jitter.setEnabled(false)
  assert.equal(frustum.xOffset, 0.25, 'foreign offset survives our release')

  const orthographic = { camera: { frustum: new C.OrthographicFrustum() },
    drawingBufferWidth: 1920, drawingBufferHeight: 1080, isDestroyed: () => false,
    context: { uniformState: { updateFrustum() {} } } }
  const rejected = new TaaJitter143(C, orthographic, {})
  rejected.setEnabled(true)
  assert.equal(rejected.apply(), false)
  assert.equal(rejected.getDiagnostics().reason, 'Requires a perspective camera')

  const tiny = frustumScene()
  tiny.scene.drawingBufferWidth = 0
  const unusable = new TaaJitter143(C, tiny.scene, {})
  unusable.setEnabled(true)
  assert.equal(unusable.apply(), false)
  assert.match(unusable.getDiagnostics().reason, /drawing buffer/)
  jitter.destroy()
  rejected.destroy()
  unusable.destroy()
})

test('TAA shaders assemble as Cesium GLSL3 with a single output and no self-read', () => {
  for (const [name, shader] of Object.entries({ resolve: taaResolveShader, depth: taaDepthShader, display: taaDisplayShader })) {
    const combined = new C.ShaderSource({ sources: [shader] }).createCombinedFragmentShader({ webgl2: true })
    assert.match(combined, /^#version 300 es/, name)
    assert.equal((combined.match(/out vec4 out_FragColor;/g) || []).length, 1, name)
    for (const uniform of ['highp sampler2D colorTexture', ...(name === 'display' ? [] : ['highp sampler2D depthTexture']),
      'in vec2 v_textureCoordinates']) {
      assert.ok(combined.includes(uniform), `${name}: ${uniform}`)
    }
  }
  const resolve = new C.ShaderSource({ sources: [taaResolveShader] }).createCombinedFragmentShader({ webgl2: true })
  for (const uniform of ['highp sampler2D u_historyColor', 'highp sampler2D u_historyDepth',
    'mat4 u_currentInverseRasterProjection', 'mat4 u_previousInverseRasterProjection',
    'mat4 u_previousViewFromCurrentEye', 'mat4 u_currentViewFromPreviousEye', 'vec2 u_cameraNearFar',
    'float u_depthThreshold', 'float u_edgeDepthDiff', 'float u_maxVelocityLength']) {
    assert.ok(resolve.includes(`uniform ${uniform};`), uniform)
  }
  assert.match(taaDepthShader, /v_textureCoordinates \+ u_jitterUv/)
  assert.match(taaDepthShader, /closest = min\(closest, eye\)/)
  assert.match(resolve, /czm_windowToEyeCoordinates\(uv \* czm_viewport.zw \+ czm_viewport.xy, depth\)/)
  assert.match(resolve, /taaHistory\(historyUV, expectedPreviousEyeDepth, stableCoverage\)/)
  assert.match(resolve, /texture\(u_historyDepth, historyUV\)/)
  assert.match(resolve, /for \(int x = -1; x <= 2; \+\+x\)/)
  assert.match(resolve, /edge \|\| !disocclusion/)
  assert.match(resolve, /taaFlickerReduction\(currentColor, clippedHistoryColor, currentWeight\)/)
  assert.doesNotMatch(resolve, /u_staticFrames|u_taaBlend|u_taaVariance|reactivity|Catmull/)

  // One depth label covers a whole 4x4 reconstruction footprint, so a jitter phase can move
  // which surface is closest without any surface appearing. The label therefore stores the
  // footprint span, and the reveal test compares against its far end: comparing against the
  // near end turned a 256m/266m coverage swap into a 3.5% "reveal" every eighth frame.
  assert.match(taaDepthShader, /farthest = max\(farthest, eye\)/)
  assert.match(taaDepthShader, /vec4\(closest == 1e30 \? 0\.0 : closest, sky \? 0\.0 : farthest/)
  assert.match(resolve, /texture\(u_historyDepth, historyUV\)\.rg/)
  assert.match(resolve, /storedFarthestEyeDepth \+ max\(0\.1, 0\.02 \* expectedPreviousEyeDepth\)/)
  // A subpixel wire that misses the footprint must keep its colour as well as its age:
  // replacing the colour with sky left the variance box nothing but sky to clip to.
  assert.doesNotMatch(resolve, /heldHistory/)
})

// Cesium compiles these as GLSL ES 3.00, where `sample`, `filter`, `input`, `output` and
// their neighbours are reserved words even though GLSL ES 1.00 accepts them as ordinary
// identifiers. A shader can assemble perfectly and still fail to compile on the GPU, and a
// failed compile makes the pass bypass silently — so the reserved word check lives here
// while the browser regression compiles the real thing.
test('TAA shaders declare no identifier that GLSL ES 3.00 reserves', () => {
  const reserved = new Set(['sample', 'filter', 'input', 'output', 'active', 'resource',
    'superp', 'namespace', 'using', 'cast', 'packed', 'goto', 'inline', 'noinline', 'public',
    'static', 'extern', 'external', 'interface', 'long', 'short', 'double', 'half', 'fixed',
    'unsigned', 'sizeof', 'union', 'enum', 'typedef', 'template', 'this', 'asm', 'class',
    'volatile', 'coherent', 'final', 'attribute', 'varying', 'texture2D', 'texture3D', 'textureCube'])
  const declaration = /\b(?:float|int|uint|bool|void|vec[234]|ivec[234]|uvec[234]|bvec[234]|mat[234]|mat[234]x[234]|sampler2D|samplerCube)\s+([A-Za-z_]\w*)/g
  for (const [name, shader] of Object.entries({ resolve: taaResolveShader, depth: taaDepthShader, display: taaDisplayShader })) {
    const declared = [...shader.matchAll(declaration)].map(match => match[1])
    assert.ok(declared.length > 0, `${name}: no declarations found`)
    for (const identifier of declared) {
      assert.ok(!reserved.has(identifier), `${name}: '${identifier}' is reserved in GLSL ES 3.00`)
    }
  }
})

function passFixture() {
  const frustum = new C.PerspectiveFrustum({ fov: Math.PI / 3, aspectRatio: 16 / 9, near: 1, far: 500000 })
  const listeners = []
  const scene = {
    camera: { frustum },
    context: { webgl2: true, depthTexture: true, floatingPointTexture: true,
      halfFloatingPointTexture: true, colorBufferHalfFloat: true, colorBufferFloat: true,
      textureFloatLinear: true, textureHalfFloatLinear: true,
      defaultTexture: {}, _gl: { isContextLost: () => false },
      // The jitter needs somewhere to publish the sub-pixel request: without it the offsets
      // would move the camera frustum while the scene kept drawing with its own projection.
      uniformState: { updateFrustum() {} } },
    highDynamicRange: true,
    drawingBufferWidth: resolution.width, drawingBufferHeight: resolution.height,
    postProcessStages: { execute() {} },
    preRender: { addEventListener: fn => listeners.push(fn),
      removeEventListener: fn => { const index = listeners.indexOf(fn); if (index >= 0) listeners.splice(index, 1) } },
    postRender: new C.Event(),
    requestRender() {},
    frameState: { passes: { render: true, pick: false, depth: false }, useLogDepth: false, frameNumber: 1 },
    isDestroyed: () => false
  }
  return { scene, frustum, listeners }
}

const taaOptions = () => ({ antialiasing: 'taa', taaJitterSamples: 8, taaHistoryBlend: 0.1,
  taaMotionBlend: 0.5, taaDepthTolerance: 0.1 })

test('the temporal pass owns the jitter hook and releases the offset with its lifetime', () => {
  const f = passFixture()
  const pass = new TaaPass143(C, f.scene, taaOptions)
  assert.equal(pass.getDiagnostics().enabled, false)
  assert.equal(pass.getDiagnostics().reason, 'Disabled')

  pass.setEnabled(true)
  assert.equal(pass.getDiagnostics().enabled, true)
  assert.equal(f.listeners.length, 1, 'pre-render hook installed')
  assert.equal(pass.getDiagnostics().jitter.enabled, true)

  // Before the first successful resolve there is no history, so the frame must stay unjittered.
  f.listeners[0]()
  assert.equal(`${f.frustum.xOffset},${f.frustum.yOffset}`, '0,0')
  assert.equal(pass.getDiagnostics().jitter.holding, false)

  // A healthily resolving pass advances the sequence; a bypassing one returns the offset
  // instead of leaving the image permanently shifted. The first Halton sample puts x exactly
  // on the pixel centre, so the pair is inspected rather than either component alone.
  pass.healthy = true
  f.listeners[0]()
  assert.notEqual(`${f.frustum.xOffset},${f.frustum.yOffset}`, '0,0')
  pass.healthy = false
  f.listeners[0]()
  assert.equal(`${f.frustum.xOffset},${f.frustum.yOffset}`, '0,0')

  pass.setEnabled(false)
  assert.equal(f.listeners.length, 0)
  assert.equal(f.frustum.xOffset, 0)
  assert.equal(pass.getDiagnostics().enabled, false)
  pass.destroy()
})

test('the temporal pass refuses unsupported contexts and non-TAA modes without allocating', () => {
  const f = passFixture()
  const wrongMode = new TaaPass143(C, f.scene, () => ({ antialiasing: 'smaa' }))
  wrongMode.setEnabled(true)
  assert.equal(wrongMode.getDiagnostics().valid, false)
  assert.match(wrongMode.getDiagnostics().reason, /Not the active anti-aliasing mode/)
  wrongMode.destroy()

  f.scene.context.floatingPointTexture = false
  const unsupported = new TaaPass143(C, f.scene, taaOptions)
  assert.equal(unsupported.getDiagnostics().supported, false)
  unsupported.setEnabled(true)
  assert.match(unsupported.getDiagnostics().reason, /Missing floatingPointTexture/)
  assert.equal(f.listeners.length, 0, 'no hook installed when unsupported')
  unsupported.destroy()
})

test('the temporal pass reports its configuration and history state', () => {
  const f = passFixture()
  const pass = new TaaPass143(C, f.scene, taaOptions)
  pass.setEnabled(true)
  const diagnostics = pass.getDiagnostics()
  assert.deepEqual(Object.keys(diagnostics.stats).sort(), ['bypasses', 'frames', 'resets'])
  assert.equal(diagnostics.historyValid, false)
  assert.equal(diagnostics.activeFrame, 0)
  assert.match(diagnostics.scope, /before tonemapping/)
  pass.resetHistory()
  assert.equal(pass.getDiagnostics().stats.resets, 1)
  pass.destroy()
  assert.equal(pass.isDestroyed(), true)
})

test('r186 requires actual floating linear sampling and single-sample raster input', () => {
  const f = passFixture()
  f.scene.context.textureFloatLinear = false
  const unsupported = new TaaPass143(C, f.scene, taaOptions)
  assert.equal(unsupported.supported, false)
  assert.match(unsupported.getDiagnostics().reason, /Linear/)
  unsupported.destroy()
  f.scene.context.textureFloatLinear = true
  const pass = new TaaPass143(C, f.scene, taaOptions)
  pass.setEnabled(true)
  f.scene.msaaSamples = 4
  assert.match(pass.getDiagnostics().reason, /MSAA=1/)
  pass.destroy()
})

// PostProcessStage.execute assigns this._colorTexture.sampler = this._sampler, so a stage's
// sampleMode rewrites the sampler of the texture handed *into* it and never touches the
// stage's own output texture. The history colour is another stage's output, which is why the
// first implementation promised bilinear history sampling and delivered nearest (9728).
test('the resolve controls how its own history is filtered, not the stage sample mode', () => {
  const f = passFixture()
  const pass = new TaaPass143(C, f.scene, taaOptions)
  pass.setEnabled(true)

  // Stage sampling temporarily affects current input. History needs its own sampler;
  // the incoming HDR sampler is restored by the effect's execution boundary.
  for (const name of ['a', 'b']) {
    const stage = pass.frames.find(frame => frame.resolve.name.endsWith(name)).resolve
    assert.equal(stage.sampleMode, C.PostProcessStageSampleMode.LINEAR, name)
    assert.equal(stage.pixelDatatype, C.PixelDatatype.FLOAT, 'low-weight HDR accumulation requires float32 history')
  }
  assert.equal(pass.depth.pack.sampleMode, C.PostProcessStageSampleMode.NEAREST)
  // The depth history feeds a per-texel footprint span (closest, farthest) to the resolve.
  assert.equal(pass.depth.pack.pixelFormat, C.PixelFormat.RG)
  assert.equal(pass.depth.pack.pixelDatatype, C.PixelDatatype.FLOAT)
  assert.equal(pass.linearSampler.minificationFilter, C.TextureMinificationFilter.LINEAR)
  assert.equal(pass.linearSampler.magnificationFilter, C.TextureMagnificationFilter.LINEAR)
  assert.equal(pass.nearestSampler.minificationFilter, C.TextureMinificationFilter.NEAREST)

  // Whatever a later native stage leaves behind, the samplers are re-asserted before the
  // history is read: colour interpolates between texels, depth never does.
  const foreign = new C.Sampler({ minificationFilter: C.TextureMinificationFilter.NEAREST,
    magnificationFilter: C.TextureMagnificationFilter.NEAREST })
  pass.historyColor = { sampler: foreign }
  pass.historyDepth = { sampler: pass.linearSampler }
  pass._synchronizeHistorySamplers()
  assert.equal(pass.historyColor.sampler, pass.linearSampler)
  assert.equal(pass.historyDepth.sampler, pass.nearestSampler)

  pass.historyColor = undefined
  pass._synchronizeHistorySamplers()
  assert.equal(pass.getDiagnostics().samplers.historyColor, null)
  pass.setEnabled(false)
  pass.destroy()
})

test('RHI display copy restores scene alpha and targets the framebuffer resource', () => {
  const f = passFixture(), commands = []
  let textures = 0
  f.scene.context.createViewportQuadCommand = fragmentShader => {
    const command = { fragmentShader, execute: (context, state) => assert.equal(state.framebuffer, command.framebuffer) }
    commands.push(command); return command
  }
  const rhi = { createTexture: options => { textures++; return { texture: { ...options }, release() {} } },
    createFramebuffer: () => ({ framebuffer: {}, release() {} }) }
  const pass = new TaaPass143(C, f.scene, taaOptions, rhi)
  pass._ensureRhiHistory(64, 64, C.PixelDatatype.FLOAT)
  pass._ensureRhiHistory(64, 64, C.PixelDatatype.FLOAT)
  assert.equal(textures, 1, 'only one display texture; native stages already own the histories')
  const source = { width: 64, height: 64 }, alphaSource = {}
  pass.alphaSource = alphaSource
  pass._copyToRhi(f.scene.context, source, pass.rhiHistory[0].colorFramebuffer, pass.rhiCopyColor)
  assert.equal(commands[0].fragmentShader, taaDisplayShader)
  assert.equal(commands[0].uniformMap.colorTexture(), source)
  assert.equal(commands[0].uniformMap.u_alphaSource(), alphaSource)
  assert.equal(commands[0].uniformMap.u_reconstructColor(), false)
  pass.reconstructing = true
  assert.equal(commands[0].uniformMap.u_reconstructColor(), true, 'the same target also serves the current reconstruction')
  assert.equal(commands[0].framebuffer, pass.rhiHistory[0].colorFramebuffer.framebuffer)
  pass.destroy()
})

test('partial RHI display allocation releases every resource when any allocation fails', () => {
  for (let failAt = 1; failAt <= 2; failAt++) {
    const f = passFixture(), alive = new Set()
    let allocations = 0
    const allocate = field => {
      if (++allocations === failAt) throw new Error('Injected allocation failure')
      const resource = { [field]: {}, release() { alive.delete(resource) } }
      alive.add(resource); return resource
    }
    const rhi = { createTexture: () => allocate('texture'), createFramebuffer: () => allocate('framebuffer') }
    const pass = new TaaPass143(C, f.scene, taaOptions, rhi)
    assert.throws(() => pass._ensureRhiHistory(64, 64, C.PixelDatatype.FLOAT), /Injected allocation failure/)
    assert.equal(alive.size, 0, `allocation ${failAt} leaked prior resources`)
    pass.destroy()
  }
})

test('Graph binds actual native histories without allocating copies', () => {
  const f = passFixture(), pass = new TaaPass143(C, f.scene, taaOptions), bindings = new Map()
  const graph = { activeFrame: {}, importResource: name => name, bindExternal: (name, value) => bindings.set(name, value) }
  pass.declareGraph(graph)
  const colors = [{}, {}], depth = {}
  pass.frames = colors.map(outputTexture => ({ resolve: { outputTexture } }))
  pass.depth = { pack: { outputTexture: depth } }
  pass._bindGraphHistory()
  assert.equal(bindings.get('taa.history.colorA'), colors[0])
  assert.equal(bindings.get('taa.history.colorB'), colors[1])
  assert.equal(bindings.get('taa.history.depth'), depth)
  assert.equal(bindings.size, 3)
  pass.destroy()
})

// The weights used to be partly literals in the execute path: the motion threshold was a
// hard-coded 12 with no way to reach it from presets.js.
test('deprecated blend helpers preserve source compatibility for legacy callers', () => {
  assert.deepEqual(taaBlendWeights({}), [0.03, 0.5, 12, 0.1])
  assert.deepEqual(taaBlendWeights({ taaHistoryBlend: 0.25, taaMotionBlend: 0.7,
    taaVelocityThreshold: 20, taaDepthTolerance: 0.3 }), [0.25, 0.7, 20, 0.3])
  // Out-of-range values are clamped rather than shipping a blend that erases the history or
  // a tolerance wide enough to accept a silhouette as the same surface.
  assert.deepEqual(taaBlendWeights({ taaHistoryBlend: 0, taaMotionBlend: 2,
    taaVelocityThreshold: 0, taaDepthTolerance: 4 }), [0.02, 1, 1, 0.5])

  // Variance gammas: slot z is the still-image width, w the moving one. Both are clamped so a
  // caller cannot request a box so wide that ghosting returns or so narrow that history dies.
  assert.deepEqual(taaVarianceGammas({}), [0, 0, 1.5, 0.75])
  assert.deepEqual(taaVarianceGammas({ taaVarianceGammaStill: 3, taaVarianceGammaMoving: 0.4 }),
    [0, 0, 3, 0.4])
  assert.deepEqual(taaVarianceGammas({ taaVarianceGammaStill: 99, taaVarianceGammaMoving: 0 }),
    [0, 0, 4, 0.1])
  // The moving box must stay tighter than the still one, or motion would keep more history
  // than a settled camera and the ghosting would invert.
  assert.ok(taaVarianceGammas({})[3] < taaVarianceGammas({})[2])

  const f = passFixture()
  const pass = new TaaPass143(C, f.scene, () => ({ ...taaOptions(), taaHistoryBlend: 0.25 }))
  const diagnostics = pass.getDiagnostics()
  assert.equal(diagnostics.algorithm.name, 'Three.js r186 TRAA')
  assert.ok(diagnostics.legacyIgnored.includes('taaHistoryBlend'))
  assert.equal(diagnostics.algorithm.maxVelocityLength, 128)
  pass.destroy()
})

test('the resolve supplies real Cesium matrix/vector uniforms and official controls', () => {
  const f = passFixture(), pass = new TaaPass143(C, f.scene, taaOptions)
  pass.setEnabled(true)
  const uniforms = pass.frames[0].resolve.uniforms
  assert.ok(uniforms.u_cameraNearFar() instanceof C.Cartesian2)
  assert.ok(uniforms.u_currentProjection() instanceof C.Matrix4)
  assert.equal(uniforms.u_depthThreshold(), 0.0005)
  assert.equal(uniforms.u_taaBlend, undefined)
  pass.destroy()
})

// preRender runs before Cesium restores the colour frame state, so a picking pass still owns
// the frustum list here — and an empty-sky pick leaves it at zero. Reading it directly made a
// pick look like a scope change, closed the overlay, and restarted a history of 911 frames.
test('a picking frame cannot restart history through the preRender frustum count', () => {
  const f = passFixture(), pass = new TaaPass143(C, f.scene, taaOptions)
  f.scene.msaaSamples = 1
  pass.setEnabled(true); pass.healthy = true; pass.colorFrustums = 1
  pass._applyJitter()
  assert.equal(pass.overlay.active, true, 'a resolved colour frame defers overlay commands')

  pass.historyValid = true; pass.historyAge = 120
  f.scene._view = { frustumCommandsList: [] }
  f.scene.frameState.passes = { render: false, pick: true, depth: false }
  pass.motion.detach = () => {}
  pass._applyJitter()
  assert.equal(pass.motion.active, true, 'the impending colour frame must capture motion even after pick')
  f.scene.frameState.passes = { render: false, pick: false, depth: false }
  pass._applyJitter()
  assert.equal(pass.motion.active, true, 'pickPosition must not interrupt colour snapshots either')
  assert.equal(pass.historyValid, true, 'the picking frame is not a scope change')
  assert.equal(pass.historyAge, 120)

  pass.colorFrustums = 0
  pass._applyJitter()
  assert.equal(pass.overlay.active, false)
  pass.historyValid = true; pass.historyAge = 120; pass.colorFrustums = 1
  pass._applyJitter()
  assert.equal(pass.historyValid, false, 'leaving the colour scope still restarts history')
  assert.equal(pass.historyAge, 0)
  pass.destroy()
})

test('changing sample count restarts history, and unsupported depth falls back without stale history', () => {
  const f = passFixture(), settings = taaOptions()
  f.scene.postProcessStages.fxaa = { enabled: false }
  const pass = new TaaPass143(C, f.scene, () => settings)
  pass.setEnabled(true); pass.healthy = true; pass.historyValid = true
  settings.taaJitterSamples = 16; pass._applyJitter()
  assert.equal(pass.jitter.samples, 16); assert.equal(pass.historyValid, false)
  pass.historyValid = true; pass.historyAge = 50
  f.scene._view = { frustumCommandsList: [{}, {}] }
  const source = {}
  assert.equal(pass._execute(f.scene.context, source), source)
  assert.equal(pass.historyValid, false); assert.equal(pass.historyAge, 0)
  assert.equal(f.scene.postProcessStages.fxaa.enabled, false, 'native output must not change mid-frame')
  pass._applyJitter()
  assert.equal(f.scene.postProcessStages.fxaa.enabled, true)
  pass.setEnabled(false)
  assert.equal(f.scene.postProcessStages.fxaa.enabled, false)
  pass.destroy()
})
