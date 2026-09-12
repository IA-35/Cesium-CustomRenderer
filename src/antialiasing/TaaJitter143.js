import { jitterSample, nearPlaneOffsets, DEFAULT_JITTER_SAMPLES } from './jitter143.js'
import FrustumJitterBridge143 from './FrustumJitterBridge143.js'

// Applies the per-frame sub-pixel offset that makes temporal anti-aliasing work.
//
// This goes through the documented PerspectiveFrustum offset pair rather than a patched
// projection matrix: Cesium shifts left/right/top/bottom by xOffset/yOffset, so the
// projection matrix, the inverse projection and every consumer of czm_projection follow
// without touching Cesium code. The values found before the first write are restored as
// soon as the offset is no longer ours, matching the restore discipline used for the rest
// of the pipeline.
//
// Writing the pair is only half of it. The scene draws with its own frustum, derived from
// the camera's by clone with `near` replaced by the drawing range, so the offset also has
// to be re-published on that frustum -- FrustumJitterBridge143 does that, and the jitter
// refuses to run at all when it cannot.
export default class TaaJitter143 {
  constructor(C, scene, options = {}) {
    if (!/^1\.143(?:\.0)?$/.test(C.VERSION)) throw new Error('TaaJitter143 requires Cesium 1.143')
    this.C = C
    this.scene = scene
    this.samples = Number.isInteger(options.samples) && options.samples > 0 ? options.samples : DEFAULT_JITTER_SAMPLES
    this.enabled = false
    this.holding = false
    this.owner = null
    this.index = 0
    this.applied = { xOffset: 0, yOffset: 0 }
    this.pixel = { x: 0, y: 0 }
    this.frames = 0
    this.bridge = null
    this.reason = 'Disabled'
  }

  _sceneGone() {
    return !!(this.scene && this.scene.isDestroyed && this.scene.isDestroyed())
  }

  _frustum() {
    if (this._sceneGone()) return null
    const frustum = this.scene.camera && this.scene.camera.frustum
    return frustum instanceof this.C.PerspectiveFrustum ? frustum : null
  }

  setEnabled(value) {
    if (this.enabled === !!value) return
    if (!value) {
      this.enabled = false
      this.restore()
      if (this.bridge) this.bridge.detach()
      this.reason = 'Disabled'
      return
    }
    if (!this.bridge) {
      this.bridge = new FrustumJitterBridge143(this.C, this.scene, { request: () => this.getRequest() })
    }
    // An offset written on the camera frustum while the scene kept drawing with its own
    // projection would move every consumer of camera.frustum without moving the image, so
    // not running is the safe outcome when the publication path is unavailable.
    if (!this.bridge.attach()) {
      this.enabled = false
      this.reason = this.bridge.getDiagnostics().reason
      return
    }
    this.enabled = true
    this.reason = null
  }

  // Restarts the sequence so a fresh history starts from the same sample as the first frame.
  reset() {
    this.index = 0
  }

  // The sub-pixel request as published. The bridge re-expresses it on whatever frustum the
  // scene is about to draw with, so it reads the request rather than the camera's metres.
  getRequest() {
    if (!this.enabled || !this.holding || !this.owner) return null
    return { frustum: this.owner.frustum, pixel: { ...this.pixel },
      baseX: this.owner.xOffset, baseY: this.owner.yOffset,
      xOffset: this.applied.xOffset, yOffset: this.applied.yOffset }
  }

  // Writes the next offset into the active frustum. Returns false and explains why when
  // the frustum or the drawing buffer cannot carry a pixel-accurate offset.
  apply() {
    if (!this.enabled) return false
    const frustum = this._frustum()
    if (!frustum) {
      this.reason = 'Requires a perspective camera'
      return false
    }
    if (this.owner && this.owner.frustum !== frustum) this._release()
    if (this.bridge.source !== frustum) {
      this.bridge.detach()
      if (!this.bridge.attach()) { this.reason = this.bridge.reason; return false }
    }
    const resolution = { width: this.scene.drawingBufferWidth, height: this.scene.drawingBufferHeight }
    const pixel = jitterSample(this.index, this.samples)
    const offsets = nearPlaneOffsets(
      { fovy: frustum.fovy, aspectRatio: frustum.aspectRatio, near: frustum.near }, pixel, resolution)
    if (!offsets) {
      // Leaving the previous frame's offset in place would be a permanently shifted image
      // with no resolve to explain it, so a frame we cannot compute is a frame we release.
      this.restore()
      this.reason = 'Requires a usable frustum and drawing buffer'
      return false
    }
    if (!this.holding) {
      // Capture the caller's values only once we are about to overwrite them, so a later
      // restore never resurrects a stale offset another system installed in the meantime.
      this.owner = { frustum, xOffset: frustum.xOffset, yOffset: frustum.yOffset }
      this.holding = true
    }
    offsets.xOffset += this.owner.xOffset
    offsets.yOffset += this.owner.yOffset
    frustum.xOffset = offsets.xOffset
    frustum.yOffset = offsets.yOffset
    this.applied = offsets
    this.pixel = pixel
    this.index++
    this.frames++
    this.reason = null
    return true
  }

  restore() {
    const owner = this.owner
    if (!this.holding || !owner) return false
    this.holding = false
    const frustum = owner.frustum
    if (this._sceneGone()) return false
    // Only undo our own write; leave anything that changed since then alone.
    if (frustum.xOffset === this.applied.xOffset) frustum.xOffset = owner.xOffset
    if (frustum.yOffset === this.applied.yOffset) frustum.yOffset = owner.yOffset
    return true
  }

  _release() {
    this.restore()
    this.owner = null
  }

  getDiagnostics() {
    return { enabled: this.enabled, samples: this.samples, index: this.index, holding: this.holding,
      pixel: { ...this.pixel }, applied: { ...this.applied }, frames: this.frames, reason: this.reason,
      bridge: this.bridge ? this.bridge.getDiagnostics() : null }
  }

  destroy() {
    this.enabled = false
    this._release()
    if (this.bridge) {
      this.bridge.detach()
      this.bridge = null
    }
    this.reason = 'Disabled'
  }
}
