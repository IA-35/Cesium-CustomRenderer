// 每次 scene.updateAndExecuteCommands 调用一份的目标快照。
//
// Cesium 在每次 updateAndExecuteCommands 开头（updateAndClearFramebuffers）更新场景 framebuffer、
// 设置 globeDepth.picking（会切换到独立的拾取目标），拾取前还会替换 scene._view；
// 渲染与 5 条拾取/深度路径共用同一个帧号。所以目标身份只在「一次调用」内稳定，
// 快照按调用（epoch）失效，而不是按帧号。_currentFramebuffer 逐 pass 变化，不在快照里。
//
// 快照在 epoch 内第一次查询时才构建，此时一定已经过了 updateAndClearFramebuffers。
// 最多给 5 个 framebuffer 实例打标签；未打标签的就是 'other'，不需要慢路径。
import { sceneColorFramebufferOf, globeColorFramebufferOf, selectedIdFramebufferOf, oitTranslucentFramebufferOf, oitAlphaFramebufferOf } from '../scene/cesiumPrivate143.js'
export const TARGET_KINDS = Object.freeze(['default', 'other', 'sceneColor', 'globeColor', 'selectedId', 'oitTranslucent', 'oitAlpha'])
export const FRAME_BITS = Object.freeze({ render: 1, pick: 2, depth: 4, pickVoxel: 8 })

const leases = new WeakMap()

class SceneTargets143 {
  constructor(scene) {
    this.scene = scene
    this.epoch = 0
    this.builtEpoch = -1
    this.tags = new Map()
    this.bits = 0
    const targets = this
    this.native = scene.updateAndExecuteCommands
    this.wrapper = function(...args) {
      targets.epoch++
      return targets.native.apply(this, args)
    }
    scene.updateAndExecuteCommands = this.wrapper
  }

  build() {
    this.builtEpoch = this.epoch
    const tags = this.tags, scene = this.scene, passes = scene.frameState?.passes
    tags.clear()
    const tag = (framebuffer, kind) => { if (framebuffer && !tags.has(framebuffer)) tags.set(framebuffer, kind) }
    tag(sceneColorFramebufferOf(scene), 'sceneColor')
    tag(globeColorFramebufferOf(scene), 'globeColor')
    tag(selectedIdFramebufferOf(scene), 'selectedId')
    tag(oitTranslucentFramebufferOf(scene), 'oitTranslucent')
    tag(oitAlphaFramebufferOf(scene), 'oitAlpha')
    this.bits = (passes?.render ? FRAME_BITS.render : 0) | (passes?.pick ? FRAME_BITS.pick : 0) |
      (passes?.depth ? FRAME_BITS.depth : 0) | (passes?.pickVoxel ? FRAME_BITS.pickVoxel : 0)
  }

  kindOf(framebuffer) {
    if (this.builtEpoch !== this.epoch) this.build()
    if (!framebuffer) return 'default'
    return this.tags.get(framebuffer) ?? 'other'
  }

  get frameBits() {
    if (this.builtEpoch !== this.epoch) this.build()
    return this.bits
  }

  destroy() {
    // 只有自己仍是最外层时才恢复，外面又包了一层就保持原样。
    if (this.scene.updateAndExecuteCommands === this.wrapper) this.scene.updateAndExecuteCommands = this.native
    this.tags.clear()
  }
}

export function acquireSceneTargets143(scene) {
  if (!scene || typeof scene.updateAndExecuteCommands !== 'function') throw new Error('SceneTargets143 requires a Cesium scene')
  let lease = leases.get(scene)
  if (!lease) { lease = { targets: new SceneTargets143(scene), count: 0 }; leases.set(scene, lease) }
  lease.count++
  let released = false
  return {
    targets: lease.targets,
    release() {
      if (released) return
      released = true
      if (--lease.count) return
      lease.targets.destroy()
      leases.delete(scene)
    }
  }
}
