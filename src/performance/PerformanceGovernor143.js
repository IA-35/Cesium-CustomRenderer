// Runtime frame-budget governor for the 1.143 visual pipeline.
//
// The governor trades resolution first (cheapest visual loss in a fill-bound 3D
// scene) and only then caps the shadow map. It never raises quality above the
// configuration the user chose: the baseline is snapshotted on enable and every
// reduction is expressed relative to it, so disabling the governor restores the
// original options exactly.
//
// Measurements are only meaningful while the viewer renders continuously. With
// Cesium's on-demand rendering the gap between postRender events is idle time, not
// frame cost, so the governor reports `on-demand rendering` and stays idle instead
// of degrading on bogus samples.

const REDUCTION_PLAN = Object.freeze([
  Object.freeze({ label: 'baseline', scaleFactor: 1, shadowCap: null }),
  Object.freeze({ label: 'resolution -10%', scaleFactor: 0.9, shadowCap: null }),
  Object.freeze({ label: 'resolution -20%', scaleFactor: 0.8, shadowCap: null }),
  Object.freeze({ label: 'resolution -30%', scaleFactor: 0.7, shadowCap: null }),
  Object.freeze({ label: 'resolution -40%, shadow <= 2048', scaleFactor: 0.6, shadowCap: 2048 }),
  Object.freeze({ label: 'resolution -40%, shadow <= 1024', scaleFactor: 0.6, shadowCap: 1024 })
])

const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

// Nearest-rank quantile over an already unordered copy; deterministic for tests.
export function quantile(values, fraction) {
  if (!values.length) return 0
  const sorted = values.slice().sort((a, b) => a - b)
  const index = clamp(Math.ceil(fraction * sorted.length) - 1, 0, sorted.length - 1)
  return sorted[index]
}

export default class PerformanceGovernor143 {
  constructor(pipeline, options = {}) {
    if (!pipeline || typeof pipeline.setOptions !== 'function') throw new Error('PerformanceGovernor143 requires a visual pipeline')
    const input = options || {}
    this.pipeline = pipeline
    this.scene = pipeline.viewer && pipeline.viewer.scene
    this.targetFrameMs = Number.isFinite(input.targetFrameMs) && input.targetFrameMs > 0 ? input.targetFrameMs
      : 1000 / (Number.isFinite(input.targetFps) && input.targetFps > 0 ? input.targetFps : 30)
    this.sampleWindow = Math.max(8, input.sampleWindow || 60)
    this.evaluateEvery = Math.max(4, input.evaluateEvery || 30)
    this.settleFrames = Math.max(0, input.settleFrames === undefined ? 30 : input.settleFrames)
    this.minScale = clamp(Number.isFinite(input.minScale) ? input.minScale : 0.6, 0.5, 1)
    this.degradeThreshold = Number.isFinite(input.degradeThreshold) ? input.degradeThreshold : 1.15
    this.recoverThreshold = Number.isFinite(input.recoverThreshold) ? input.recoverThreshold : 0.8
    this.recoverStreakRequired = Math.max(1, input.recoverStreakRequired || 3)
    this.now = typeof input.now === 'function' ? input.now
      : () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
    this.enabled = false
    this.destroyed = false
    this.baseline = null
    this.step = 0
    this.window = []
    this.recoverStreak = 0
    this.framesSinceChange = 0
    this.evaluations = 0
    this.changes = 0
    this.lastP95 = 0
    this.reason = 'disabled'
    this.pendingStep = null
    this.removers = []
  }

  _continuous() {
    if (this.destroyed || !this.scene) return false
    if (this.scene.requestRenderMode === true) return false
    return true
  }

  _blocked() {
    const pipeline = this.pipeline
    if (!pipeline.enabled) return 'Pipeline disabled'
    if (pipeline.suspensions && pipeline.suspensions.size) return 'Suspended'
    return null
  }

  setEnabled(value) {
    if (this.destroyed) return
    if (!value) {
      this._release()
      return
    }
    if (this.enabled) return
    const options = this.pipeline.getOptions()
    this.baseline = { resolutionScale: options.resolutionScale, shadowSize: options.shadowSize,
      shadowMode: options.shadowMode, hasShadow: typeof options.shadowSize === 'number' }
    this.step = 0
    this.window = []
    this.recoverStreak = 0
    this.framesSinceChange = 0
    this.evaluations = 0
    this.changes = 0
    this.lastP95 = 0
    this.pendingStep = null
    this._previous = undefined
    this.enabled = true
    this.reason = 'sampling'
    if (!this._attach()) {
      this.enabled = false
      this.baseline = null
      this.reason = 'scene events unavailable'
    }
  }

  _attach() {
    const scene = this.scene
    if (!scene || !scene.postRender || !scene.preUpdate) return false
    const sample = () => this._onPostRender()
    const apply = () => this._onPreUpdate()
    scene.postRender.addEventListener(sample)
    scene.preUpdate.addEventListener(apply)
    this.removers = [
      () => scene.postRender.removeEventListener(sample),
      () => scene.preUpdate.removeEventListener(apply)
    ]
    return true
  }

  _detach() {
    this.removers.forEach(remove => remove())
    this.removers = []
  }

  // Teardown hook for owners that destroy the viewer themselves: stop listening and
  // drop state without writing to a scene that is about to disappear.
  detach() {
    this.enabled = false
    this.reason = 'detached'
    this._detach()
    this.baseline = null
    this.window = []
    this.pendingStep = null
  }

  _release() {
    if (!this.enabled) return
    this.enabled = false
    this.reason = 'disabled'
    this._detach()
    this._restoreBaseline()
    this.window = []
    this.pendingStep = null
  }

  _restoreBaseline() {
    const baseline = this.baseline
    this.baseline = null
    this.step = 0
    if (!baseline) return
    const current = this.pipeline.getOptions()
    const options = {}
    if (current.resolutionScale !== baseline.resolutionScale) options.resolutionScale = baseline.resolutionScale
    if (baseline.hasShadow && current.shadowSize !== baseline.shadowSize) options.shadowSize = baseline.shadowSize
    if (Object.keys(options).length) this.pipeline.setOptions(options)
  }

  _onPostRender() {
    if (!this.enabled || this.destroyed) return
    const blocked = this._blocked()
    const continuous = this._continuous()
    if (blocked || !continuous) {
      this.reason = blocked || 'on-demand rendering'
      this.window = []
      this.recoverStreak = 0
      // Drop the time base: the gap across a pause is not a frame interval.
      this._previous = undefined
      return
    }
    const now = this.now()
    if (this._previous !== undefined) {
      const interval = now - this._previous
      // Ignore non-positive or implausible gaps (tab switch, breakpoint, resize stall).
      if (interval > 0 && interval < 5000) {
        this.window.push(interval)
        if (this.window.length > this.sampleWindow) this.window.shift()
      }
    }
    this._previous = now
    this.framesSinceChange++
    if (this.window.length < this.sampleWindow) {
      this.reason = 'warming up'
      return
    }
    if (this.framesSinceChange < this.settleFrames) {
      this.reason = 'settling after adjustment'
      return
    }
    if (this.evaluations++ % this.evaluateEvery !== 0) return
    this._evaluate()
  }

  _evaluate() {
    const p95 = quantile(this.window, 0.95)
    this.lastP95 = p95
    if (p95 > this.targetFrameMs * this.degradeThreshold) {
      this.recoverStreak = 0
      const next = Math.min(this.step + 1, REDUCTION_PLAN.length - 1)
      if (next === this.step) { this.reason = 'at the maximum reduction'; return }
      this.reason = `over budget: P95 ${p95.toFixed(1)}ms`
      this.pendingStep = next
      return
    }
    if (p95 < this.targetFrameMs * this.recoverThreshold) {
      this.reason = `headroom: P95 ${p95.toFixed(1)}ms`
      if (this.step === 0) { this.recoverStreak = 0; return }
      if (++this.recoverStreak >= this.recoverStreakRequired) {
        this.recoverStreak = 0
        this.pendingStep = this.step - 1
      }
      return
    }
    this.recoverStreak = 0
    this.reason = `within budget: P95 ${p95.toFixed(1)}ms`
  }

  _onPreUpdate() {
    if (!this.enabled || this.pendingStep === null) return
    const step = this.pendingStep
    this.pendingStep = null
    if (step === this.step) return
    const plan = REDUCTION_PLAN[step]
    const baseline = this.baseline
    const baselineScale = baseline ? baseline.resolutionScale : 1
    const targetScale = clamp(baselineScale * plan.scaleFactor, this.minScale, baselineScale)
    // Shadow occupancy is a function of the step, not sticky: recovering past a cap
    // must hand the baseline size back, not keep the reduced one.
    const shadowEligible = !!baseline && baseline.hasShadow && baseline.shadowMode === 'custom'
    const shadowTarget = shadowEligible
      ? (plan.shadowCap ? Math.min(baseline.shadowSize, plan.shadowCap) : baseline.shadowSize) : null
    const current = this.pipeline.getOptions()
    const options = {}
    if (current.resolutionScale !== targetScale) options.resolutionScale = targetScale
    if (shadowTarget !== null && current.shadowSize !== shadowTarget) options.shadowSize = shadowTarget
    if (!Object.keys(options).length) {
      this.step = step
      this.framesSinceChange = 0
      this.reason = `at ${plan.label}`
      return
    }
    try {
      this.pipeline.setOptions(options)
    } catch (error) {
      this.reason = `adjustment failed: ${error instanceof Error ? error.message : String(error)}`
      return
    }
    this.step = step
    this.changes++
    this.framesSinceChange = 0
    this.window = []
    // The resize/reconfigure frame itself is a hitch, not the new steady state.
    this._previous = undefined
    this.reason = `applied ${plan.label}`
  }

  getDiagnostics() {
    const plan = REDUCTION_PLAN[this.step]
    return {
      enabled: this.enabled,
      reason: this.reason,
      targetFrameMs: this.targetFrameMs,
      targetFps: 1000 / this.targetFrameMs,
      step: this.step,
      maxStep: REDUCTION_PLAN.length - 1,
      label: plan.label,
      p95: this.lastP95,
      samples: this.window.length,
      sampleWindow: this.sampleWindow,
      evaluations: this.evaluations,
      changes: this.changes,
      minScale: this.minScale,
      baseline: this.baseline ? { ...this.baseline } : null,
      pendingStep: this.pendingStep
    }
  }

  isDestroyed() { return this.destroyed }

  destroy() {
    if (this.destroyed) return
    this._release()
    this.destroyed = true
    this.reason = 'destroyed'
  }
}
