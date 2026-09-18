import { nearPlaneOffsets } from './jitter143.js'

// Cesium 1.143 instance adapter: only the active main camera and its clones may
// carry the sample. Never modify the static engine or unrelated render cameras.
export default class FrustumJitterBridge143 {
  constructor(C, scene, options = {}) {
    if (!/^1\.143(?:\.0)?$/.test(C.VERSION)) throw new Error('FrustumJitterBridge143 requires Cesium 1.143')
    Object.assign(this, { C, scene, request: options.request || (() => null), attached: false, reason: 'Detached', drawn: null })
    this.stats = { published: 0, renormalized: 0, copied: 0, skipped: 0 }
    this.touched = new Map()
  }
  _sceneGone() { return !!(this.scene.isDestroyed && this.scene.isDestroyed()) }
  _wrap(owner, key, make) {
    const hadOwn = Object.prototype.hasOwnProperty.call(owner, key), original = owner[key]
    const wrapper = make(original)
    owner[key] = wrapper
    return { owner, key, original, wrapper, hadOwn }
  }
  attach() {
    if (this.attached) return true
    const state = this.scene.context && this.scene.context.uniformState
    const frustum = this.scene.camera && this.scene.camera.frustum
    if (this._sceneGone() || !state || typeof state.updateFrustum !== 'function' || !frustum || typeof frustum.clone !== 'function') {
      this.reason = 'Requires context.uniformState.updateFrustum and a clonable camera frustum'; return false
    }
    const bridge = this, token = { active: true }
    this.source = frustum
    this.token = token
    this.restores = [this._wrap(state, 'updateFrustum', original => function(value) {
      if (token.active) bridge._publish(value)
      return original.call(this, value)
    }), this._wrap(frustum, 'clone', original => function(result) {
      const cloned = original.call(this, result)
      if (token.active && cloned && cloned !== this) {
        let entry = bridge.touched.get(cloned)
        if (!entry) {
          entry = { xOffset: cloned.xOffset, yOffset: cloned.yOffset }
          bridge.touched.set(cloned, entry)
        }
        entry.frame = bridge.scene.frameState?.frameNumber || 0
        // Preserve the original offset until publication: copying the source's
        // metre value here is wrong when Scene later changes the clone's near.
        bridge.stats.copied++
      }
      return cloned
    })]
    this.attached = true; this.reason = null
    return true
  }
  _restore(frustum, entry) {
    for (const key of ['xOffset', 'yOffset']) if (frustum[key] === entry['applied_' + key]) frustum[key] = entry[key]
  }
  _publish(frustum) {
    const request = this.request(), entry = this.touched.get(frustum)
    if (!request) {
      this.drawn = null
      for (const [value, record] of this.touched) this._restore(value, record)
      return
    }
    if (!entry || frustum === request.frustum || !(frustum instanceof this.C.PerspectiveFrustum)) return
    const resolution = { width: this.scene.drawingBufferWidth, height: this.scene.drawingBufferHeight }
    const view = this.scene._view, id = view?.sceneFramebuffer?.idFramebuffer
    const stableId = !!id && view.passState?.framebuffer === id
    const offsets = nearPlaneOffsets(frustum, stableId ? {x: 0, y: 0} : request.pixel, resolution)
    if (!offsets) { this.stats.skipped++; return }
    const baseX = request.baseX || 0, baseY = request.baseY || 0
    offsets.xOffset += baseX * frustum.near / request.frustum.near
    offsets.yOffset += baseY * frustum.near / request.frustum.near
    for (const key of ['xOffset', 'yOffset']) { frustum[key] = offsets[key]; entry['applied_' + key] = offsets[key] }
    entry.frame = this.scene.frameState?.frameNumber || 0
    this.lastDrawingFrustum = frustum
    this.stats.published++; this.stats.renormalized++
    const matrix = frustum.projectionMatrix
    this.drawn = { near: frustum.near, ...offsets, pixelX: -matrix[8] * resolution.width / 2, pixelY: -matrix[9] * resolution.height / 2 }
    if (this.touched.size > 64) for (const [value, record] of this.touched) {
      if (entry.frame - record.frame > 1) { this._restore(value, record); this.touched.delete(value) }
    }
  }
  restoreColorProjection() {
    if (this.lastDrawingFrustum && this.request()) this.scene.context.uniformState.updateFrustum(this.lastDrawingFrustum)
  }
  detach() {
    if (this.token) this.token.active = false
    for (const entry of this.restores || []) if (entry.owner[entry.key] === entry.wrapper) {
      if (entry.hadOwn) entry.owner[entry.key] = entry.original
      else delete entry.owner[entry.key]
    }
    if (!this._sceneGone()) for (const [frustum, entry] of this.touched) this._restore(frustum, entry)
    this.touched.clear(); this.restores = undefined; this.source = undefined; this.lastDrawingFrustum = undefined; this.attached = false; this.drawn = null; this.reason = 'Detached'
  }
  getDiagnostics() {
    return { attached: this.attached, reason: this.reason, stats: { ...this.stats }, drawn: this.drawn && { ...this.drawn }, touched: this.touched.size }
  }
}
