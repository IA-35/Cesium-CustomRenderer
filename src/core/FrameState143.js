// CCR core frame contract. Cesium remains the scene/data producer; CCR consumes this immutable snapshot.
import { frustumBinsOf, usesOit } from '../scene/cesiumPrivate143.js'
export function createFrameState143(scene, { generation = 0 } = {}) {
  const frame = scene?.frameState || {}
  const context = scene?.context
  const passes = frame.passes || {}
  const frusta = frustumBinsOf(scene)
  return Object.freeze({
    frameNumber: Number.isFinite(frame.frameNumber) ? frame.frameNumber : 0,
    generation,
    drawingBuffer: Object.freeze({ width: context?.drawingBufferWidth || 0, height: context?.drawingBufferHeight || 0 }),
    mode: scene?.mode,
    scene3D: scene?.constructor?.SceneMode?.SCENE3D,
    passes: Object.freeze({ render: passes.render === true, pick: passes.pick === true, depth: passes.depth === true, pickVoxel: passes.pickVoxel === true }),
    useOIT: usesOit(scene),
    frustumCount: Array.isArray(frusta) ? frusta.length : 0,
    camera: scene?.camera || null,
    context,
  })
}

export function isColorFrame143(frameState) {
  return !!frameState && frameState.passes.render && !frameState.passes.pick && !frameState.passes.depth
}
