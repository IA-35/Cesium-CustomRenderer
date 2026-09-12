import { edgesShader, weightsShader, blendShader } from './smaaShaders.js'
import { smaaLookupUrl } from './smaaLookupUrls.js'

let nextId = 0

// Version-specific instance adapter. The native collection keeps ownership of HDR,
// tonemapping and business stages; this collection only sees their final LDR output.
export default class SmaaPass143 {
  constructor(C, scene) {
    if (!/^1\.143(?:\.0)?$/.test(C.VERSION)) throw new Error('SmaaPass143 requires Cesium 1.143')
    this.C = C
    this.scene = scene
    this.enabled = false
    this.ready = false
    this.error = null
    this.collection = undefined
    this.composite = undefined
    this.stages = undefined
    this.areaTexture = undefined
    this.searchTexture = undefined
    this.readyPromise = Promise.resolve(false)
    this._destroyed = false
    this._generation = 0
    this._token = undefined
    this._fxaa = undefined
    this._outputFrame = undefined
    this._valid = false
    this._sourceSize = new C.Cartesian2(1, 1)
    this._linearSampler = new C.Sampler({ minificationFilter: C.TextureMinificationFilter.LINEAR,
      magnificationFilter: C.TextureMagnificationFilter.LINEAR })
  }

  _sceneDestroyed() { return !!(this.scene.isDestroyed && this.scene.isDestroyed()) }

  _supported() { return !this._sceneDestroyed() && !!(this.scene.context && this.scene.context.webgl2) }

  _requestRender() {
    if (!this._sceneDestroyed() && this.scene.requestRender) this.scene.requestRender()
  }

  // Relinquish ownership if another controller changes FXAA while this pass is active.
  _setFxaa(value) {
    const state = this._fxaa
    if (!state || !state.owned) return false
    if (state.stage.enabled !== state.last) {
      state.owned = false
      return false
    }
    state.stage.enabled = value
    state.last = value
    return true
  }

  setEnabled(value) {
    if (this._destroyed) return
    if (!value) {
      this._release()
      this._requestRender()
      return
    }
    if (this.enabled) return
    this.enabled = true
    this.error = null
    const native = this.scene.postProcessStages
    this._fxaa = { stage: native.fxaa, original: native.fxaa.enabled, last: native.fxaa.enabled, owned: true }
    this._setFxaa(true)
    if (!this._supported()) {
      this.error = 'SMAA requires WebGL 2'
      this._requestRender()
      return
    }
    const generation = ++this._generation
    try {
      this._createStages()
      this._installHooks(native)
      this.readyPromise = this._loadLookups(generation)
    } catch (error) {
      this._fail(error)
    }
    this._requestRender()
  }

  _createStages() {
    const C = this.C
    const prefix = `smaa143_${++nextId}`
    const resolution = () => this._sourceSize
    const createStage = (name, fragmentShader, uniforms = {}) => new C.PostProcessStage({
      name: `${prefix}_${name}`, fragmentShader, uniforms: { resolution, ...uniforms },
      textureScale: 1, pixelFormat: C.PixelFormat.RGBA, pixelDatatype: C.PixelDatatype.UNSIGNED_BYTE,
      sampleMode: C.PostProcessStageSampleMode.LINEAR,
      clearColor: C.Color.TRANSPARENT
    })
    const edges = createStage('edges', edgesShader)
    const weights = createStage('weights', weightsShader, {
      tDiffuse: edges.name, tArea: () => this.areaTexture, tSearch: () => this.searchTexture
    })
    const blend = createStage('blend', blendShader, { tDiffuse: weights.name })
    this.stages = { edges, weights, blend }
    this.composite = new C.PostProcessStageComposite({ name: prefix, stages: [edges, weights, blend],
      inputPreviousStageTexture: false })
    this.collection = new C.PostProcessStageCollection()
    this.collection.fxaa.enabled = false
    this.collection.bloom.enabled = false
    this.collection.ambientOcclusion.enabled = false
    this.collection.add(this.composite)
  }

  async _loadLookups(generation) {
    const C = this.C
    try {
      const [area, search] = await Promise.all(['AreaTex.png', 'SearchTex.png'].map(name =>
        C.Resource.fetchImage({ url: smaaLookupUrl(C, name), preferImageBitmap: false })))
      if (generation !== this._generation || !this.enabled || this._destroyed || this._sceneDestroyed()) return false
      if (area.width !== 160 || area.height !== 560 || search.width !== 66 || search.height !== 33) {
        throw new Error('Unexpected SMAA 2.8 lookup dimensions (expected Area 160x560, Search 66x33)')
      }
      const makeTexture = (image, sampler) => new C.Texture({ context: this.scene.context, source: image,
        pixelFormat: C.PixelFormat.RGBA, pixelDatatype: C.PixelDatatype.UNSIGNED_BYTE, flipY: false, sampler })
      this.areaTexture = makeTexture(area, this._linearSampler)
      this.searchTexture = makeTexture(search, new C.Sampler({ minificationFilter: C.TextureMinificationFilter.NEAREST,
        magnificationFilter: C.TextureMagnificationFilter.NEAREST }))
      this.ready = true
      this._setFxaa(false)
      this._requestRender()
      return true
    } catch (error) {
      if (generation === this._generation && this.enabled && !this._destroyed) this._fail(error)
      return false
    }
  }

  _installHooks(native) {
    const pass = this
    const token = { active: true, native, previousExecute: native.execute, previousCopy: native.copy }
    token.execute = function(context, color, depth, id) {
      if (token.active) pass._valid = false
      // Native failures must propagate, and must never be mislabeled as SMAA failures.
      const result = token.previousExecute.apply(this, arguments)
      if (token.active) pass._execute(context, native.outputTexture || color, depth, id)
      return result
    }
    token.copy = function(context, framebuffer) {
      const result = token.previousCopy.apply(this, arguments)
      if (token.active && pass._valid && pass._outputFrame === pass.scene.frameState.frameNumber) {
        try {
          pass._withViewport(context, () => pass.collection.copy(context, framebuffer))
        } catch (error) {
          pass._fail(error)
        }
      }
      return result
    }
    this._token = token
    native.execute = token.execute
    native.copy = token.copy
  }

  _withViewport(context, callback) {
    const state = context.uniformState
    const viewport = { x: state.viewport.x, y: state.viewport.y, width: state.viewport.width, height: state.viewport.height }
    try { return callback() } finally { state.viewport = viewport }
  }

  _execute(context, color, depth, id) {
    if (!this.ready || !this.collection || this._sceneDestroyed()) return
    const ownership = this._setFxaa(false)
    if (!ownership || this.scene.postProcessStages.fxaa.enabled) return
    try {
      this._withViewport(context, () => {
        this._sourceSize.x = 1 / color.width
        this._sourceSize.y = 1 / color.height
        const collection = this.collection
        collection.update(context, this.scene.frameState.useLogDepth, false)
        collection.clear(context)
        if (!collection.ready || !this.composite.ready) return
        // Named samplers are not the stage's colorTexture. Explicitly retain the
        // bilinear filtering required by SMAA's pseudo-gather and area searches.
        for (const stage of [this.stages.edges, this.stages.weights]) {
          if (stage.outputTexture) stage.outputTexture.sampler = this._linearSampler
        }
        collection.execute(context, color, depth, id)
        if (collection.outputTexture) {
          this._valid = true
          this._outputFrame = this.scene.frameState.frameNumber
        }
      })
    } catch (error) {
      this._fail(error)
    }
  }

  _fail(error) {
    this.error = error instanceof Error ? error.message : String(error)
    ++this._generation
    this._releaseResources()
    this._setFxaa(true)
    this._requestRender()
  }

  _releaseResources() {
    this.ready = false
    this._valid = false
    this._outputFrame = undefined
    for (const resource of [this.collection, this.areaTexture, this.searchTexture]) {
      if (resource && !resource.isDestroyed()) {
        try { resource.destroy() } catch (error) {
          this.error = this.error || (error instanceof Error ? error.message : String(error))
        }
      }
    }
    this.collection = undefined
    this.composite = undefined
    this.stages = undefined
    this.areaTexture = undefined
    this.searchTexture = undefined
  }

  _release() {
    this.enabled = false
    ++this._generation
    const token = this._token
    this._token = undefined
    if (token) {
      token.active = false
      if (token.native.execute === token.execute) token.native.execute = token.previousExecute
      if (token.native.copy === token.copy) token.native.copy = token.previousCopy
    }
    const fxaa = this._fxaa
    if (fxaa) this._setFxaa(fxaa.original)
    this._fxaa = undefined
    this._releaseResources()
  }

  getDiagnostics() {
    const output = this.collection && this.collection.outputTexture
    const valid = this.enabled && this.ready && this._valid && this._outputFrame === this.scene.frameState.frameNumber
    return {
      supported: this._supported(), enabled: this.enabled, ready: this.ready,
      effective: this.enabled && valid && !this.scene.postProcessStages.fxaa.enabled ? 'smaa'
        : this.enabled && this.scene.postProcessStages.fxaa.enabled ? 'fxaa' : 'off',
      error: this.error,
      lookupDimensions: { area: this.areaTexture ? { width: 160, height: 560 } : null,
        search: this.searchTexture ? { width: 66, height: 33 } : null },
      outputDimensions: output ? { width: output.width, height: output.height } : null,
      resourceCounts: { collections: this.collection ? 1 : 0, stages: this.stages ? 3 : 0,
        lookupTextures: Number(!!this.areaTexture) + Number(!!this.searchTexture) }
    }
  }

  isDestroyed() { return this._destroyed }

  destroy() {
    if (this._destroyed) return
    this._release()
    this._destroyed = true
  }
}
