// 让场景中独立的 Model 共用一个 DynamicEnvironmentMapManager。
//
// Cesium 1.143 默认给每个 Model 建一个管理器。时钟每走 maximumSecondsDifference 秒，
// 或大气参数变化时，N 个管理器同时重建：立方体图渲染、卷积、一次同步 readPixels 求 SH，
// 并且每个管理器在一轮重建中三次置位 shouldRegenerateShaders，所属 Model 随之
// resetDrawCommands（全部绘制命令、阴影派生、TAA 运动记录跟着失效）。
//
// 管理器只渲染大气和地面色，不含场景几何；校园尺度内各建筑位置差异可以忽略，
// 共用一份结果在视觉上等价。共享管理器由本对象持有并驱动更新，Model 只读取其结果：
// Cesium 的 updateEnvironmentMap 只在 manager.owner === model 时更新，因此不会重复驱动。
// 立方体图对象在多轮重建之间保持同一引用，SH 数组也原地更新，所以只有立方体图
// 第一次出现时才需要重建 Model 的着色器。
const alive = object => object && !(typeof object.isDestroyed === 'function' && object.isDestroyed())
const OPTION_KEYS = ['maximumPositionEpsilon', 'gamma', 'brightness', 'saturation', 'groundAlbedo']

function snapshot(C, manager) {
  const options = { mipmapLevels: manager.maximumMipmapLevel, groundColor: C.Color.clone(manager.groundColor) }
  for (const key of OPTION_KEYS) options[key] = manager[key]
  return options
}

export default class SharedEnvironmentMap143 {
  constructor(C, scene) {
    this.C = C
    this.scene = scene
    this.manager = null
    this.template = null
    this.models = new Map() // model -> 被替换下来的自有管理器，归还时原样装回
    this.center = null
    this.readyCount = -1
    this.hadCubeMap = false
    this.destroyed = false
    this.proxy = { update: frameState => this.update(frameState), isDestroyed: () => this.destroyed, destroy() {} }
  }

  get size() { return this.models.size }

  // 只接管与共享模板参数一致的管理器；用户单独调过地面色、伽马等的 Model 保留自有管理器。
  // 散射强度与更新间隔由 EnvironmentLighting 统一写在共享管理器上，不参与比较。
  compatible(manager) {
    if (!this.template) return true
    const options = snapshot(this.C, manager)
    return options.mipmapLevels === this.template.mipmapLevels && this.C.Color.equals(options.groundColor, this.template.groundColor) &&
      OPTION_KEYS.every(key => options[key] === this.template[key])
  }

  adopt(model) {
    if (this.destroyed) return false
    if (this.models.has(model)) return model._environmentMapManager === this.manager
    const own = model._environmentMapManager
    if (!alive(own) || own.owner !== model || own.enabled === false || !this.compatible(own)) return false
    if (!this.manager) this.create(own)
    this.models.set(model, own)
    model._environmentMapManager = this.manager
    if (model._ready) model.resetDrawCommands()
    this.readyCount = -1
    return true
  }

  create(own) {
    const C = this.C
    this.template = snapshot(C, own)
    const manager = new C.DynamicEnvironmentMapManager({ ...this.template, groundColor: C.Color.clone(this.template.groundColor) })
    // 占住 owner，防止别处再通过 Model 的 setter 认领它。
    if (typeof C.DynamicEnvironmentMapManager.setOwner === 'function') C.DynamicEnvironmentMapManager.setOwner(manager, this, 'manager')
    else { manager._owner = this; this.manager = manager }
    this.hadCubeMap = false
    this.scene.primitives?.add?.(this.proxy)
  }

  release(model) {
    const own = this.models.get(model)
    if (!own) return
    this.models.delete(model)
    this.readyCount = -1
    if (!alive(model)) { if (alive(own)) own.destroy(); return }
    if (model._environmentMapManager !== this.manager) return
    model._environmentMapManager = own
    if (model._ready) model.resetDrawCommands()
  }

  // 只保留仍在场景里的 Model；其余归还自有管理器。一个都不剩时连共享管理器一起释放。
  retain(models) {
    for (const model of [...this.models.keys()]) if (!models.has(model)) this.release(model)
    if (!this.models.size) this.releaseAll()
  }

  releaseAll() {
    for (const model of [...this.models.keys()]) this.release(model)
    if (this.manager) {
      const primitives = this.scene.primitives
      if (alive(this.scene) && primitives?.contains?.(this.proxy)) primitives.remove(this.proxy)
      if (alive(this.manager)) this.manager.destroy()
    }
    this.manager = null; this.template = null; this.center = null; this.readyCount = -1
  }

  computeCenter() {
    const C = this.C, spheres = []
    for (const model of this.models.keys()) if (model._ready && model._boundingSphere) spheres.push(model._boundingSphere)
    return spheres.length ? C.Cartesian3.clone(C.BoundingSphere.fromBoundingSpheres(spheres).center) : null
  }

  update(frameState) {
    const manager = this.manager, passes = frameState.passes
    if (this.destroyed || !alive(manager) || passes?.pick || passes?.pickVoxel) return
    let ready = 0
    for (const [model, own] of this.models) {
      // Model.destroy 不会销毁非自有管理器，被替换下来的那个由这里回收。
      if (!alive(model)) { if (alive(own)) own.destroy(); this.models.delete(model); continue }
      if (model._ready) ready++
    }
    if (ready !== this.readyCount) { this.readyCount = ready; this.center = this.computeCenter() }
    // 模型全部销毁后不再驱动；代理和管理器在下一次 retain 时移除（这里正处于集合遍历中）。
    if (!this.models.size || !this.center) return
    // 与 Model 一致：每帧回填位置。EnvironmentLighting 用 position = undefined 请求重建。
    manager.position = this.center
    manager.update(frameState)
    const hasCubeMap = !!manager.radianceCubeMap
    if (hasCubeMap === this.hadCubeMap) return
    this.hadCubeMap = hasCubeMap
    for (const model of this.models.keys()) if (model._ready) model.resetDrawCommands()
  }

  destroy() {
    if (this.destroyed) return
    this.releaseAll()
    this.destroyed = true
  }
}
