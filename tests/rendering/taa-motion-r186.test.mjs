import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import TaaMotion143, { motionTransform143 } from '../../src/antialiasing/TaaMotion143.js'
const C = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')
const translated = (x = 0, z = 0) => C.Matrix4.fromTranslation(new C.Cartesian3(x, 0, z), new C.Matrix4())

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
