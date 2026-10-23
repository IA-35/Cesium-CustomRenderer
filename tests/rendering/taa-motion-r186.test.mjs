import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import TaaMotion143, { motionTransform143 } from '../../src/antialiasing/TaaMotion143.js'
const C = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')
const translated = (x = 0, z = 0) => C.Matrix4.fromTranslation(new C.Cartesian3(x, 0, z), new C.Matrix4())

test('appearance snapshots detect highlight entry, blend changes and restoration without moving the model', () => {
  const motion = new TaaMotion143(C, { context: {}, frameState: {} })
  const owner = Object.create(C.Model.prototype)
  owner._color = C.Color.clone(C.Color.WHITE)
  owner._colorBlendMode = C.ColorBlendMode.HIGHLIGHT
  owner._colorBlendAmount = 0.5
  const command = { owner, modelMatrix: translated(), boundingVolume: new C.BoundingSphere() }
  assert.equal(motion.snapshot(command, 1).appearanceChanged, false)
  assert.equal(motion.snapshot(command, 2).appearanceChanged, false)
  owner._color.red = 0.5
  const changed = motion.snapshot(command, 3)
  assert.equal(changed.appearanceChanged, true)
  assert.equal(changed.moved, false)
  assert.equal(motion.snapshot(command, 4).appearanceChanged, false)
  owner._colorBlendMode = C.ColorBlendMode.MIX
  assert.equal(motion.snapshot(command, 5).appearanceChanged, true)
  owner._colorBlendAmount = 0.3
  assert.equal(motion.snapshot(command, 6).appearanceChanged, true)
  C.Color.clone(C.Color.WHITE, owner._color)
  owner._colorBlendMode = C.ColorBlendMode.HIGHLIGHT
  assert.equal(motion.snapshot(command, 7).appearanceChanged, true)
  assert.equal(motion.snapshot(command, 8).appearanceChanged, false)
})

test('color changes reject only the visible primitive history and stop drawing masks on the next frame', () => {
  const scene = { context: {}, frameState: { frameNumber: 1 }, drawingBufferWidth: 16, drawingBufferHeight: 16 }
  scene.context.uniformState = { pass: 9, updatePass(value) { this.pass = value } }
  const motion = new TaaMotion143(C, scene), matrix = translated()
  const owner = Object.create(C.Model.prototype)
  owner.type = 'GLTF'; owner._color = C.Color.clone(C.Color.WHITE)
  owner._colorBlendMode = C.ColorBlendMode.HIGHLIGHT; owner._colorBlendAmount = 0.5
  const state = { depthTest: { enabled: true }, depthMask: true }
  const source = {}, command = { owner, shaderProgram: source, renderState: state, modelMatrix: translated() }
  motion.detach = () => {}
  motion.programs.set(source, { sources: {}, program: {}, frame: 1 })
  motion.states.set(state, { value: {}, frame: 1 })
  motion.allocate = () => {}; motion.alias = () => ({}); motion.preserveTarget = fn => fn()
  motion.clear = { execute() {} }
  const masks = []
  motion.executor.execute = (_, __, ___, options) => masks.push(options.uniformMap.ccr_previousValid())
  const frame = () => {
    scene.frameState.frameNumber++
    motion.begin(true, matrix, matrix, matrix, matrix, true)
    motion.capture({ command, overrides: [], passState: {} })
    motion.finish()
  }
  frame(); frame(); masks.length = 0
  owner._color.red = 0.5
  frame()
  assert.deepEqual(masks, [false], 'color-only changes must reject old RGB rather than report valid zero velocity')
  assert.equal(motion.stats.appearanceChanges, 1)
  assert.equal(motion.coverageStable, true, 'unrelated static roads must retain their history')
  frame()
  assert.equal(motion.stats.draws, 0)
  assert.equal(motion.textureForResolve, undefined)
  assert.equal(masks.length, 1)
})

test('stepped rigid motion rejects the previous mesh silhouette rather than the surrounding rectangle', () => {
  const scene = { context: {}, frameState: { frameNumber: 1 }, drawingBufferWidth: 16, drawingBufferHeight: 16 }
  scene.context.uniformState = { pass: 9, updatePass(value) { this.pass = value } }
  const motion = new TaaMotion143(C, scene), matrix = translated()
  const owner = Object.create(C.Model.prototype)
  owner.type = 'GLTF'
  const state = { depthTest: { enabled: true }, depthMask: true }
  const source = {}, command = { owner, shaderProgram: source, renderState: state, modelMatrix: translated(),
    boundingVolume: new C.BoundingSphere(new C.Cartesian3(0, 0, -10), 2) }
  motion.detach = () => {}
  motion.programs.set(source, { sources: {}, program: {}, frame: 1 })
  motion.states.set(state, { value: {}, options: { depthTest: { enabled: true }, depthMask: false }, frame: 1 })
  motion.allocate = () => {}; motion.alias = () => ({}); motion.preserveTarget = fn => fn()
  motion.clear = { execute() {} }
  motion.rejectPreviousFootprint = () => assert.fail('a supported vehicle must not reset a bounding rectangle')
  const draws = []
  motion.executor.execute = (item, _, __, options) => draws.push({ item, x: options.modelMatrix?.[12],
    eyeX: options.uniformMap.ccr_currentModelView()[12], valid: options.uniformMap.ccr_previousValid(), state: options.renderState })
  const step = x => {
    scene.frameState.frameNumber++; command.modelMatrix[12] = x
    motion.begin(true, matrix, matrix, matrix, matrix, true)
    motion.capture({ command, overrides: [], passState: {} })
    motion.finish()
  }
  step(0); step(0); draws.length = 0
  step(1)
  assert.equal(draws.length, 2)
  assert.equal(draws[0].item, command)
  assert.equal(draws[0].x, 0)
  assert.equal(draws[0].eyeX, 0)
  assert.equal(draws[0].valid, false)
  assert.deepEqual(draws[0].state.colorMask, { red: false, green: false, blue: false, alpha: true })
  assert.equal(draws[0].state.depthTest.enabled, true, 'foreground geometry must still occlude the old vehicle')
  assert.equal(draws[1].eyeX, 1)
  assert.equal(draws[1].valid, true)
  const previousState = draws[0].state
  step(1); step(1); draws.length = 0
  step(2)
  assert.equal(draws[0].x, 1)
  assert.equal(draws[0].state, previousState, 'the 20 Hz update cadence must reuse its raster state')
  assert.equal(motion.coverageStable, true)
  for (const record of motion.states.values()) if (record.previousOptions) C.RenderState.removeFromCache(record.previousOptions)
})

test('previous-silhouette render state is released on eviction and teardown', () => {
  const released = [], api = { ...C, RenderState: { removeFromCache: options => released.push(options) } }
  const scene = { context: {}, frameState: { frameNumber: 122 }, drawingBufferWidth: 16, drawingBufferHeight: 16 }
  const motion = new TaaMotion143(api, scene), current = {}, previous = {}, matrix = translated()
  motion.detach = () => {}
  motion.states.set({}, { frame: 1, options: current, previousOptions: previous })
  motion.begin(true, matrix, matrix, matrix, matrix, true)
  assert.deepEqual(released, [current, previous])
  assert.equal(motion.states.size, 0)
  const active = {}, activePrevious = {}
  motion.states.set({}, { frame: 122, options: active, previousOptions: activePrevious })
  motion.destroy()
  assert.deepEqual(released, [current, previous, active, activePrevious])
})

test('motion draws share one target scope and retain the color framebuffer and viewport until resolve', () => {
  const scene = { context: { uniformState: { pass: 9, updatePass(value) { this.pass = value } } },
    frameState: { frameNumber: 1 }, drawingBufferWidth: 16, drawingBufferHeight: 16 }
  const motion = new TaaMotion143(C, scene), matrix = translated(), source = {}, state = { depthTest: { enabled: true }, depthMask: true }
  const target = {}, passState = { framebuffer: target, viewport: new C.BoundingRectangle(0, 0, 16, 16) }
  const commands = [0, 1].map(x => {
    const owner = Object.create(C.Model.prototype); owner.type = 'GLTF'
    return { owner, modelMatrix: translated(x), shaderProgram: source, renderState: state }
  })
  motion.detach = () => {}
  motion.programs.set(source, { sources: {}, program: {}, frame: 1 })
  motion.states.set(state, { value: {}, frame: 1 })
  motion.allocate = () => {}
  let scopes = 0, clears = 0, draws = 0
  motion.preserveTarget = fn => { scopes++; fn() }
  motion.clear = { execute() { clears++ } }
  motion.alias = native => { assert.equal(native, target); return target }
  motion.executor.execute = (_, __, pass, options) => {
    draws++
    assert.equal(pass.viewport.width, 16)
    assert.equal(options.framebuffer, target)
    assert.equal(scene.context.uniformState.pass, C.Pass.OPAQUE)
  }
  motion.begin(true, matrix, matrix, matrix, matrix, false)
  commands.forEach(command => motion.capture({ command, overrides: [], passState }))
  motion.finish()
  scene.frameState.frameNumber++
  motion.begin(true, matrix, matrix, matrix, matrix, true)
  for (const command of commands) {
    command.modelMatrix[12]++
    motion.capture({ command, overrides: [], passState })
  }
  assert.equal(draws, 0, 'capture must not interrupt each opaque draw with a framebuffer switch')
  passState.framebuffer = {}; passState.viewport.width = 8
  motion.finish(); motion.finish()
  assert.equal(draws, 2)
  assert.equal(scopes, 1)
  assert.equal(clears, 1)
  assert.equal(motion.pendingDraws.length, 0)
  assert.equal(scene.context.uniformState.pass, 9)
})

test('previous footprints reuse an alpha-only quad with a bounded scissor and release its shader', () => {
  const writes = []; let created = 0, destroyed = 0
  const scene = { frameState: {}, camera: { positionWC: C.Cartesian3.ZERO, viewMatrix: C.Matrix4.IDENTITY,
    frustum: new C.PerspectiveFrustum({ fov: 1, aspectRatio: 1, near: 1, far: 100 }) },
    context: { createViewportQuadCommand(shader, options) {
      created++
      return { renderState: options.renderState, shaderProgram: { destroy() { destroyed++ } },
        execute(context, pass) { writes.push({ rectangle: C.BoundingRectangle.clone(pass.scissorTest.rectangle), state: this.renderState }) } }
    } } }
  const motion = new TaaMotion143(C, scene)
  motion.texture = { width: 100, height: 100, destroy() {} }; motion.framebuffer = { destroy() {} }
  motion.rejectPreviousFootprint(new C.BoundingSphere(new C.Cartesian3(0, 0, -10), 1))
  motion.rejectPreviousFootprint(new C.BoundingSphere(new C.Cartesian3(-1, 0, -10), 1))
  assert.equal(created, 1)
  assert.deepEqual(writes[0].state.colorMask, { red: false, green: false, blue: false, alpha: true })
  assert.ok(writes.every(w => w.rectangle.width > 0 && w.rectangle.width < 50))
  assert.ok(writes[1].rectangle.x < writes[0].rectangle.x)
  assert.equal(motion.stats.previousFootprints, 2)
  const key = {}, sphere = new C.BoundingSphere(new C.Cartesian3(0, 0, -10), 1)
  motion.active = true; motion.historyValid = true; motion.colorFrame = 3
  motion.previousSubmitted.add(key); motion.records.set(key, { bounds: sphere, motionMasked: false })
  motion.preserveTarget = fn => fn(); motion.allocate = () => {}
  motion.finish(); motion.finish()
  assert.equal(writes.length, 3, 'a disappearance is masked once, without changing the whole-frame gate')
  assert.equal(motion.coverageStable, true)
  motion.colorFrame++; motion.historyValid = false; motion.pendingMasks.push(sphere); motion.finish()
  assert.equal(writes.length, 3, 'a fresh history needs no rejection allocation')
  assert.equal(motion.pendingMasks.length, 0)
  motion.destroy(); assert.equal(destroyed, 1)
})

test('supported movement is local while an unmarked stationary disappearance remains conservative', () => {
  const motion = new TaaMotion143(C, { context: {}, frameState: { frameNumber: 1 } })
  motion.detach = () => {}
  const matrix = translated(), a = { modelMatrix: translated() }, b = { modelMatrix: translated(10) }
  const frame = commands => {
    motion.begin(true, matrix, matrix, matrix, matrix, true)
    for (const command of commands) {
      const record = motion.snapshot(command, motion.colorFrame)
      record.motionMasked = record.moved
      motion.submitted.add(motion.primitiveKey(command))
    }
    motion.finish()
    return motion.coverageStable
  }
  frame([a,b]); frame([a,b]); b.modelMatrix[12]++
  assert.equal(frame([a,b]), true, 'a moving neighbour must not disable static road accumulation')
  assert.equal(frame([a]), true, 'a previously moving departure is covered by its signed history mask')
  frame([a,b]); frame([a,b])
  assert.equal(frame([a]), false, 'a stationary removal without bounds needs a conservative reveal frame')
  frame([a]); motion.unsupportedChanged = true
  assert.equal(motion.coverageStable, false)
})

test('stationary coverage ends on motion, replacement and disappearance, including unsupported commands', () => {
  const scene = { context: {}, frameState: { frameNumber: 1 }, drawingBufferWidth: 16, drawingBufferHeight: 16 }
  const motion = new TaaMotion143(C, scene), matrix = translated()
  motion.detach = () => {}
  const a = { modelMatrix: translated(5) }, b = { modelMatrix: translated(6) }
  const frame = commands => {
    scene.frameState.frameNumber++
    motion.begin(true, matrix, matrix, matrix, matrix, true)
    for (const command of commands) motion.capture({ command, overrides: [] })
    return motion.stationary
  }
  assert.equal(frame([a]), false)
  assert.equal(frame([a]), true)
  a.modelMatrix[12]++
  assert.equal(frame([a]), false)
  assert.equal(frame([a]), true)
  assert.equal(frame([b]), false, 'equal primitive counts do not hide replacement')
  assert.equal(frame([b]), true)
  assert.equal(frame([]), false, 'disappearance must restore strict history rejection')
  assert.equal(frame([]), true)
})

test('motion snapshots preserve prior primitive matrices across in-place updates and frame gaps', () => {
  const motion = new TaaMotion143(C, { context: {}, frameState: {} })
  const command = { modelMatrix: translated(6000000, -100) }
  assert.equal(motion.snapshot(command, 1).valid, false)
  command.modelMatrix[12] += 3
  const next = motion.snapshot(command, 2)
  assert.equal(next.valid, true)
  assert.equal(next.previous[12], 6000000)
  assert.equal(next.current[12], 6000003)
  command.modelMatrix[12] += 10
  assert.equal(motion.snapshot(command, 2), next, 'a repeated draw cannot rotate frame history')
  assert.equal(motion.snapshot(command, 4).valid, false, 'a reappearing surface needs local history rejection')
})

test('camera-relative rigid transforms retain small motion at ECEF scale and independent Z depth', () => {
  const transform = motionTransform143(C, translated(-6000000), translated(6000003, -90),
    translated(-6000000), translated(6000000, -100))
  const local = new C.Cartesian4(0, 0, 0, 1)
  const current = C.Matrix4.multiplyByVector(transform.currentModelView, local, new C.Cartesian4())
  const previous = C.Matrix4.multiplyByVector(transform.previousModelView, local, new C.Cartesian4())
  assert.equal(current.x, 3); assert.equal(previous.x, 0)
  assert.equal(-current.z, 90); assert.equal(-previous.z, 100)
})

test('shader-derived command replacement preserves stable runtime primitive history', () => {
  const motion = new TaaMotion143(C, { context: {}, frameState: {} })
  const primitive = {}, owner = { _sceneGraph: { _runtimeNodes: [{ runtimePrimitives: [primitive] }] } }
  const first = { owner, modelMatrix: translated(6), vertexArray: {}, count: 6, offset: 0 }
  primitive.drawCommand = { _command: first }
  motion.snapshot(first, 1)
  const replacement = { ...first, modelMatrix: translated(6) }
  primitive.drawCommand = { _command: replacement }
  const value = motion.snapshot(replacement, 2)
  assert.equal(value.valid, true, 'new HDR/shader wrapper is the same physical surface')
  assert.equal(value.moved, false)
})

test('primitive snapshots reuse a record and two independent matrices', () => {
  const motion = new TaaMotion143(C, { context: {}, frameState: {} }), command = { modelMatrix: translated(10) }
  const record = motion.snapshot(command, 1), matrices = new Set([record.current, record.previous])
  for (let frame = 2; frame < 20; frame++) {
    command.modelMatrix[12] = frame
    const value = motion.snapshot(command, frame)
    assert.equal(value, record)
    assert.equal(value.previous[12], frame === 2 ? 10 : frame - 1)
    assert.equal(value.current[12], frame)
    matrices.add(value.current); matrices.add(value.previous)
  }
  assert.equal(matrices.size, 2)
  assert.equal(motion.snapshot(command, 21).valid, false)
  assert.equal(record.previous[12], record.current[12], 'a frame gap seeds both matrices')
})

test('idle motion frames neither clear nor expose retained velocity data', () => {
  const scene = { context: {}, frameState: { frameNumber: 1 }, drawingBufferWidth: 16, drawingBufferHeight: 16 }
  const motion = new TaaMotion143(C, scene), matrix = translated()
  let clears = 0
  motion.detach = () => {}; motion.texture = { width: 16, height: 16 }
  motion.clear = { execute: () => clears++ }; motion.preserveTarget = fn => fn()
  motion.begin(true, matrix, matrix, matrix, matrix, true)
  assert.equal(clears, 0)
  assert.equal(motion.textureForResolve, undefined)
  motion.stats.draws = 1
  assert.equal(motion.textureForResolve, motion.texture, 'new surfaces also count as writes')
  scene.frameState.frameNumber++
  motion.begin(true, matrix, matrix, matrix, matrix, true)
  assert.equal(clears, 0)
  assert.equal(motion.textureForResolve, undefined)
})

// Cesium dispatches preRender before it restores the colour frame state, so the frame after a
// pick still reports the picking status: scene.pick leaves passes.pick, pickPosition leaves
// render=false with pick=false. Resetting on any of those threw away every snapshot, and the
// next colour frame reported all 51 still campus models as newly appeared surfaces, so the
// resolve rejected their history. Only the pass's own resetHistory() may drop snapshots.
test('a picking frame keeps motion snapshots and colour frames keep counting', () => {
  const scene = { context: {}, frameState: { frameNumber: 1, passes: { render: true, pick: false, depth: false } },
    drawingBufferWidth: 16, drawingBufferHeight: 16 }
  const motion = new TaaMotion143(C, scene), matrix = translated(), command = { modelMatrix: translated(5) }
  motion.detach = () => {}
  const begin = active => motion.begin(active, matrix, matrix, matrix, matrix, true)
  begin(true)
  const records = motion.records
  motion.snapshot(command, motion.colorFrame)

  for (const passes of [{ render: false, pick: true, depth: false }, { render: false, pick: false, depth: false },
    { render: false, pick: false, depth: true }]) {
    scene.frameState.passes = passes
    begin(false)
    assert.equal(motion.colorFrame, 1, 'a picking or depth frame is not a colour frame')
    assert.equal(motion.records, records, 'no non-colour frame may drop snapshots')
  }

  scene.frameState.passes = { render: true, pick: false, depth: false }
  begin(true)
  assert.equal(motion.colorFrame, 2)
  assert.equal(motion.snapshot(command, motion.colorFrame).valid, true,
    'the still surface still matches the last colour frame it was sampled in')

  motion.reset()
  assert.equal(motion.colorFrame, 0, 'an explicit reset restarts the colour sequence')
})
