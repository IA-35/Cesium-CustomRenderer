import { registerHdrEffect } from './HdrCoordinator143.js'

// Cesium 1.143 adapter: execute independent float stages before native tone mapping.
export default class HdrEnvironmentPass143 {
  constructor(C, scene, createComposite) {
    if (!/^1\.143(?:\.0)?$/.test(C.VERSION)) throw new Error('HdrEnvironmentPass143 requires Cesium 1.143')
    this.C = C
    this.scene = scene
    this.createComposite = createComposite
    this.collection = undefined
    this.composite = undefined
    this.inputColor = undefined
    this.stats = { executions: 0, bypasses: 0, failures: 0 }
    this.error = null
    this.enabled = false
    this.reason = 'disabled'
    this._destroyed = false
    this._valid = false
    this._detachHdr = undefined
  }

  _sceneDestroyed() {
    return !!(this.scene.isDestroyed && this.scene.isDestroyed())
  }

  _unsupportedReason() {
    if (this._sceneDestroyed()) return 'scene destroyed'
    const context = this.scene.context
    for (const capability of ['depthTexture', 'floatingPointTexture', 'colorBufferFloat']) {
      if (!context || !context[capability]) return `missing ${capability}`
    }
    return null
  }

  _scopeReason() {
    if (this._sceneDestroyed()) return 'scene destroyed'
    if (!this.scene.highDynamicRange) return 'HDR disabled'
    if (this.scene.mode !== this.C.SceneMode.SCENE3D) return 'requires 3D scene'
    if (this.scene.cameraUnderground) return 'underground camera'
    if (this.scene._globeTranslucencyState && this.scene._globeTranslucencyState.translucent) return 'translucent globe depth'
    const frustum = this.scene.camera && this.scene.camera.frustum
    if ((this.C.OrthographicFrustum && frustum instanceof this.C.OrthographicFrustum) ||
        (this.C.OrthographicOffCenterFrustum && frustum instanceof this.C.OrthographicOffCenterFrustum)) return 'requires perspective camera'
    const frustums = this.scene._view && this.scene._view.frustumCommandsList
    if (!frustums || frustums.length !== 1) return 'requires single frustum depth'
    return null
  }

  _requestRender() {
    if (!this._sceneDestroyed() && this.scene.requestRender) this.scene.requestRender()
  }

  setEnabled(value) {
    if (this._destroyed) return
    if (!value) {
      this._release()
      this.reason = 'disabled'
      this._requestRender()
      return
    }
    if (this.enabled) return
    const unsupported = this._unsupportedReason()
    if (unsupported) {
      this.reason = unsupported
      return
    }
    this.error = null
    try {
      this.collection = new this.C.PostProcessStageCollection()
      this.collection.fxaa.enabled = false
      this.collection.ambientOcclusion.enabled = false
      this.collection.bloom.enabled = false
      this.composite = this.createComposite()
      this.collection.add(this.composite)
      this._detachHdr = registerHdrEffect(this.scene, 20,
        (context, color, depth, id) => this._execute(context, color, depth, id))
      this.enabled = true
      this.reason = 'not ready'
    } catch (error) {
      this._fail(error)
    }
    this._requestRender()
  }

  _execute(context, color, depth, id) {
    this._valid = false
    const reason = this._scopeReason()
    if (reason) {
      this.reason = reason
      this.stats.bypasses++
      return color
    }
    // PostProcessStage.execute can change automatic viewport uniforms at half resolution.
    // Snapshot values: Cesium's viewport getter returns a mutable internal Rectangle.
    const uniformState = context.uniformState
    const viewport = { x: uniformState.viewport.x, y: uniformState.viewport.y,
      width: uniformState.viewport.width, height: uniformState.viewport.height }
    let output = color
    try {
      this.inputColor = color
      const collection = this.collection
      collection.update(context, this.scene.frameState.useLogDepth, false)
      collection.clear(context)
      if (collection.ready && this.composite.ready) {
        collection.execute(context, color, depth, id)
        if (collection.outputTexture) {
          output = collection.outputTexture
          this._valid = true
          this.reason = null
          this.stats.executions++
        } else {
          this.reason = 'output not ready'
        }
      } else {
        this.reason = 'not ready'
      }
    } catch (error) {
      this._fail(error)
    } finally {
      uniformState.viewport = viewport
    }
    if (!this._valid) this.stats.bypasses++
    return output
  }

  _fail(error) {
    this.error = error instanceof Error ? error.message : String(error)
    this.stats.failures++
    this._release()
    this.reason = 'environment failure'
  }

  _release() {
    this.enabled = false
    this._valid = false
    const detachHdr = this._detachHdr
    this._detachHdr = undefined
    if (detachHdr) detachHdr()
    const collection = this.collection
    this.collection = undefined
    this.composite = undefined
    this.inputColor = undefined
    if (collection && !collection.isDestroyed()) {
      try {
        collection.destroy()
      } catch (error) {
        // Teardown must remain safe if the viewer has already destroyed its GL context.
        this.error = this.error || (error instanceof Error ? error.message : String(error))
      }
    }
  }

  getDiagnostics() {
    const unsupported = this._unsupportedReason()
    const scopeReason = this.enabled ? this._scopeReason() : null
    const frustums = !this._sceneDestroyed() && this.scene._view && this.scene._view.frustumCommandsList
    return {
      enabled: this.enabled,
      supported: !unsupported,
      valid: !this._destroyed && this.enabled && this._valid && !scopeReason,
      reason: this._destroyed ? 'destroyed' : unsupported || scopeReason || this.reason,
      error: this.error,
      frustumCount: frustums ? frustums.length : 0,
      stats: { ...this.stats }
    }
  }

  isDestroyed() { return this._destroyed }

  destroy() {
    if (this._destroyed) return
    this._release()
    this._destroyed = true
    this.reason = 'destroyed'
  }
}
