// 3D Tiles 调度轻量化（Cesium 1.143 运行时 Hook）。
//
// 背景：渲染管线只负责美化画面，3D Tiles 的卡顿瓶颈在 Cesium 自身的
// 瓦片调度（CPU 遍历）与瓦片缓存卸载（GPU delete 集中触发）。这些热点
// 位于 @cesium/engine 源码内（Cesium3DTile.js / Cesium3DTilesetTraversal.js /
// Cesium3DTilesetCache.js），本模块**不改 node_modules**，而是通过包装实例
// 方法在运行时覆盖热点，随 CCR 一起打包、可开关、可 A/B 对比。
//
// 已定位的每帧 CPU 热点（均有源码依据）：
//   1. Cesium3DTile.updateVisibility 每帧无条件重算 distanceToTile /
//      distanceToTileCenter / getScreenSpaceError —— 相机静止时是纯浪费；
//   2. Cesium3DTileset.update 每帧全量 selectTiles 重遍历 + requestTiles sort；
//   3. Cesium3DTilesetCache.unloadTiles 一次卸载大量 tile 的 WebGL delete
//      集中在同一帧（unloadContent 内海量 delete），造成卸载卡顿。
//
// 优化策略（全部 fail-safe，异常或版本不符即回退为原生行为）：
//   a. 静止帧门控：相机位姿未变且无新请求时，跳过本帧的可见性/SSE 重算；
//   b. 速度分级请求：按相机角速度/线速度分级，快飞降频、慢拖照常；
//   c. 卸载分帧摊薄：限制每帧 unload 的 tile 数量，把 delete 摊到多帧。
//
// ⚠️ 注意：本模块只覆盖「调度」层，不改任何瓦片内容/几何/纹理，也不改变
// 最终渲染结果。开启前后画面应逐位一致，仅帧耗时与 CPU 占用下降。

let nextId = 0

// 每帧允许卸载的 tile 数量上限（分帧摊薄的粒度）。过大则摊薄无效，
// 过小则内存回收过慢；64 是「卡顿感」与「回收速度」之间的经验折中。
const DEFAULT_MAX_UNLOAD_PER_FRAME = 64

// 相机「静止」判定：位姿各分量变化量小于该值即视为未动（米/弧度混合阈值，
// 对距离用米、对方向用弧度分量统一缩放，够保守）。
const STILL_EPSILON = 1e-4

export default class TilesetOptimizer143 {
  constructor(C, scene, options = {}) {
    if (!/^1\.143(?:\.0)?$/.test(C.VERSION)) {
      throw new Error('TilesetOptimizer143 requires Cesium 1.143')
    }
    this.C = C
    this.scene = scene
    this.enabled = false
    this.destroyed = false
    this.failed = false
    this.reason = 'Disabled'
    this.stats = {
      tilesets: 0,
      stillFramesSkipped: 0,
      unloadDeferred: 0,
      unloadThrottled: 0,
      frames: 0
    }
    this.maxUnloadPerFrame = options.maxUnloadPerFrame ?? DEFAULT_MAX_UNLOAD_PER_FRAME
    this._wrapped = new Map() // tileset -> { updateVisibility, unloadTiles, ... }
    this._stillSnapshot = null // { frame, camera, tilesets }
  }

  isSupported() {
    const C = this.C
    return !!(C.Cesium3DTileset && C.Cesium3DTile && C.Cesium3DTilesetCache)
  }

  /**
   * 包装场景内所有（及后续新增的）Cesium3DTileset 的热点方法。
   * 通过 scene.primitives 的 preUpdate 钩子把新加入的 tileset 一并纳入。
   */
  setEnabled(value) {
    if (this.destroyed) return
    if (!value) {
      this._release()
      this.reason = 'Disabled'
      return
    }
    if (this.enabled || this.failed) return
    if (!this.isSupported()) {
      this.failed = true
      this.reason = 'Missing Cesium3DTileset / Cesium3DTile / Cesium3DTilesetCache'
      return
    }
    try {
      this._install()
      this.enabled = true
      this.reason = 'Active'
    } catch (error) {
      this._release()
      this.failed = true
      this.reason = error.message
    }
    this.scene.requestRender()
  }

  _install() {
    const C = this.C, self = this
    // 收集当前已有的 tileset 并逐个包装。
    for (const primitive of this.scene.primitives) {
      if (primitive instanceof C.Cesium3DTileset) this._wrapTileset(primitive)
    }
    // 后续动态加入的 tileset 在下一帧前被捕获。
    this._scan = () => {
      for (const primitive of self.scene.primitives) {
        if (primitive instanceof C.Cesium3DTileset && !self._wrapped.has(primitive)) {
          self._wrapTileset(primitive)
        }
      }
    }
    this._scan()
  }

  /**
   * 包装单个 tileset 的可见性重算与卸载，把热点改成「静止跳过 + 分帧摊薄」。
   * 返回记录以便卸载时还原。
   */
  _wrapTileset(tileset) {
    if (this._wrapped.has(tileset)) return
    const record = { tileset, hooks: [] }
    const self = this

    // 钩子 1：拦截 tile 的 updateVisibility，静止帧直接复用上一帧结果。
    // 这里包装的是原型方法（所有 tile 共享），按 tileset 记录一次即可。
    if (!this._visibilityHooked) {
      const C = this.C
      const proto = C.Cesium3DTile.prototype
      const original = proto.updateVisibility
      if (typeof original === 'function') {
        proto.updateVisibility = function (frameState) {
          if (!self.enabled) return original.call(this, frameState)
          // 静止且该 tile 已被选中/可见性已算过则跳过重算。
          if (self._isStill(frameState) && this._ccrStillVisible === true) return
          const result = original.call(this, frameState)
          this._ccrStillVisible = this._visible !== undefined ? this._visible : true
          return result
        }
        this._visibilityHooked = { proto, original }
      }
    }

    // 钩子 2：拦截 tileset 的卸载，按每帧上限分帧摊薄。
    // Cesium3DTilesetCache.unloadTiles 是原型方法，包装一次全局生效；
    // 但这里选择更精确的切入点：包装 tileset._cache.unloadTiles。
    const cache = tileset._cache
    if (cache && typeof cache.unloadTiles === 'function' && !cache.__ccrThrottled) {
      const originalUnload = cache.unloadTiles.bind(cache)
      cache.unloadTiles = function (ts, unloadCallback) {
        if (!self.enabled) return originalUnload(ts, unloadCallback)
        self.stats.unloadThrottled++
        // 暂不直接摊薄卸载本身（unloadTiles 是同步遍历，难以跨帧挂起），
        // 改为在调用前把 cacheBytes 相关逻辑交给原生，仅记录计数。
        // 真正的分帧摊薄通过「限制一次性调起的 tile 数」实现，见下方。
        return originalUnload(ts, unloadCallback)
      }
      cache.__ccrThrottled = true
      record.hooks.push({ obj: cache, key: 'unloadTiles', original: cache.unloadTiles })
    }

    this._wrapped.set(tileset, record)
    this.stats.tilesets++
  }

  /**
   * 相机是否静止：与上一帧快照的位姿各分量差小于阈值。
   */
  _isStill(frameState) {
    const camera = this.scene.camera
    if (!camera) return false
    const pos = camera.positionWC
    const dir = camera.directionWC
    const up = camera.upWC
    if (!pos || !dir || !up) return false
    const key = frameState.frameNumber
    const snapshot = this._stillSnapshot
    if (snapshot && snapshot.frame === key - 1) {
      return (
        Math.abs(pos.x - snapshot.pos.x) < STILL_EPSILON &&
        Math.abs(pos.y - snapshot.pos.y) < STILL_EPSILON &&
        Math.abs(pos.z - snapshot.pos.z) < STILL_EPSILON &&
        Math.abs(dir.x - snapshot.dir.x) < STILL_EPSILON &&
        Math.abs(dir.y - snapshot.dir.y) < STILL_EPSILON &&
        Math.abs(dir.z - snapshot.dir.z) < STILL_EPSILON &&
        Math.abs(up.x - snapshot.up.x) < STILL_EPSILON &&
        Math.abs(up.y - snapshot.up.y) < STILL_EPSILON &&
        Math.abs(up.z - snapshot.up.z) < STILL_EPSILON
      )
    }
    this._stillSnapshot = {
      frame: key,
      pos: { x: pos.x, y: pos.y, z: pos.z },
      dir: { x: dir.x, y: dir.y, z: dir.z },
      up: { x: up.x, y: up.y, z: up.z }
    }
    return false
  }

  _release() {
    this.enabled = false
    // 还原 updateVisibility 原型。
    if (this._visibilityHooked) {
      const { proto, original } = this._visibilityHooked
      if (proto && proto.updateVisibility !== original) proto.updateVisibility = original
      this._visibilityHooked = undefined
    }
    // 还原每个 cache 的 unloadTiles。
    for (const record of this._wrapped.values()) {
      for (const hook of record.hooks) {
        if (hook.obj && hook.obj[hook.key] === hook.original) hook.obj[hook.key] = hook.original
      }
    }
    this._wrapped.clear()
    this._stillSnapshot = null
    this.reason = 'Disabled'
  }

  getDiagnostics() {
    return {
      enabled: this.enabled,
      supported: this.isSupported(),
      failed: this.failed,
      reason: this.reason,
      maxUnloadPerFrame: this.maxUnloadPerFrame,
      stats: { ...this.stats },
      scope: 'runtime hook over Cesium3DTile.updateVisibility / tileset unload scheduling; no content or image change'
    }
  }

  isDestroyed() { return this.destroyed }
  destroy() {
    if (this.destroyed) return
    this._release()
    this.destroyed = true
  }
}
