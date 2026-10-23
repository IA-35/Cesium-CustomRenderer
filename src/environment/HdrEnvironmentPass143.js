import { frustumBinsOf, globeTranslucent } from '../scene/cesiumPrivate143.js'
import { registerHdrEffect } from './HdrCoordinator143.js'
import {withUniformBlocks} from '../buffers/UniformBuffer143.js'
import CloudTemporal143, { CLOUD_TEMPORAL_SHADERS } from './CloudTemporal143.js'
import { ATMOSPHERE_LUT_SHADERS } from './AtmosphereLut143.js'

// Cesium 1.143 adapter: execute independent float stages before native tone mapping.
export default class HdrEnvironmentPass143 {
  constructor(C, scene, createComposite, allowEmptyFrustum = () => false, prepareFrame=()=>[], releaseFrame=()=>{}) {
    if (!/^1\.143(?:\.0)?$/.test(C.VERSION)) throw new Error('HdrEnvironmentPass143 requires Cesium 1.143')
    this.C = C
    this.scene = scene
    this.createComposite = createComposite
    this.allowEmptyFrustum = allowEmptyFrustum
    this.prepareFrame=prepareFrame;this.releaseFrame=releaseFrame
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
    // B08：介质遮挡数据的独立 collection。它复用同一批 uniforms，
    // 但**不参与颜色合成**——其输出是供 B09 读取的中间数据。
    this.occlusionCollection = undefined
    // 着色器后台预热（RHI 提供，可为空）。预热完成前环境走原生天空，避免首帧同步编译卡住数秒。
    this.shaderWarmup = null
    this.warmKeys = []
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
    if (globeTranslucent(this.scene)) return 'translucent globe depth'
    const frustum = this.scene.camera && this.scene.camera.frustum
    if ((this.C.OrthographicFrustum && frustum instanceof this.C.OrthographicFrustum) ||
        (this.C.OrthographicOffCenterFrustum && frustum instanceof this.C.OrthographicOffCenterFrustum)) return 'requires perspective camera'
    const frustums = frustumBinsOf(this.scene)
    if (!frustums || (frustums.length !== 1 && !(frustums.length === 0 && this.allowEmptyFrustum()))) return 'requires single frustum depth'
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
      if(this.environmentGraph) {
        this._ensureCloudCollection()
        this._ensureOcclusionCollection()
        this.environmentGraph.installCollection(this.collection,[
          {key:'atmosphere.raymarch',stage:this.composite.get(0)},
          {key:'atmosphere.transmission',stage:this.composite.get(1)},
          {key:'environment.composite',stage:this.composite.get(2)}])
      }
      this.warmKeys = this._warmShaders()
      this._detachHdr = registerHdrEffect(this.scene, 20,
        (context, color, depth, id) => this._execute(context, color, depth, id))
      this.enabled = true
      this.reason = 'not ready'
    } catch (error) {
      this._fail(error)
    }
    this._requestRender()
  }

  // 门控之后才会执行的所有程序：环境 stage 树，以及直接画全屏四边形的云时域与大气 LUT。
  _warmShaders() {
    const warmup = this.shaderWarmup, context = this.scene.context
    if (!warmup) return []
    const stages = warmup.warmPostProcessStages([this.composite, this._cloudComposite, this._occlusionStage].filter(Boolean),
      { useLogDepth: !!this.scene.frameState?.useLogDepth, context })
    const quads = warmup.warmViewportShaders([...CLOUD_TEMPORAL_SHADERS, ...(this.prepareAtmosphere ? ATMOSPHERE_LUT_SHADERS : [])], { context })
    return [...stages, ...quads]
  }

  _execute(context, color, depth, id) {
    this._valid = false
    this.occlusionFrame = undefined
    const reason = this._scopeReason()
    if (reason) {
      this.cloudTemporal?.reset('HDR bypass')
      this.reason = reason
      this.stats.bypasses++
      return color
    }
    if (this.warmKeys.length) {
      if (!this.shaderWarmup.isReady(this.warmKeys)) {
        this.reason = 'shaders warming'
        this.stats.bypasses++
        this._requestRender()
        return color
      }
      this.warmKeys = []
    }
    // PostProcessStage.execute can change automatic viewport uniforms at half resolution.
    // Snapshot values: Cesium's viewport getter returns a mutable internal Rectangle.
    const uniformState = context.uniformState
    const viewport = { x: uniformState.viewport.x, y: uniformState.viewport.y,
      width: uniformState.viewport.width, height: uniformState.viewport.height }
    let output = color
    try {
      this.inputColor = color
      this.environmentGraph?.beginFrame({color,depth})
      this.prepareAtmosphere?.(context)
      if (this.allowEmptyFrustum() && frustumBinsOf(this.scene).length === 0) {
        // A sky-only frame has no native geometry pass to update the projection.
        // Its shaders explicitly ignore both depth textures for this frame.
        uniformState.updateFrustum(this.scene.camera.frustum)
      }
      const collection = this.collection
      if (!this._executeClouds(context,color,depth,id)) {
        this.reason='cloud stages not ready';this.stats.bypasses++
        return color
      }
      collection.update(context, this.scene.frameState.useLogDepth, false)
      collection.clear(context)
      if (collection.ready && this.composite.ready) {
        const bindings=this.prepareFrame(context),programs=[]
        const collect=stage=>{if(typeof stage.length==='number')for(let i=0;i<stage.length;i++)collect(stage.get(i));else if(stage._command)programs.push(stage._command.shaderProgram)}
        if(bindings.length){collect(this.composite);withUniformBlocks(context._gl,programs,bindings,()=>collection.execute(context,color,depth,id))}
        else collection.execute(context, color, depth, id)
        // B08：在同一次 HDR 执行里产出介质遮挡数据。
        // 必须在这里而不是另起一次 registerHdrEffect：该 stage 依赖本 pass 的
        // 相机/深度 uniform 状态与半分辨率 viewport，脱离这个上下文读取
        // sceneDistance 会拿到错误的深度。
        this._executeOcclusion(context, color, depth, id)
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
      this.environmentGraph?.endFrame()
      uniformState.viewport = viewport
    }
    if (!this._valid) this.stats.bypasses++
    return output
  }

  _executeClouds(context,color,depth,id) {
    if(!this._cloudComposite) return true
    if(this.cloudsActive && !this.cloudsActive()) {
      if(!this._cloudsInactive) this.cloudTemporal?.reset('clouds disabled')
      this._cloudsInactive=true;this.cloudOutput=undefined;this.cloudJitterActive=false
      return true
    }
    this._cloudsInactive=false
    this._ensureCloudCollection()
    const collection = this.cloudCollection
    collection.update(context,this.scene.frameState.useLogDepth,false)
    collection.clear(context)
    this.cloudOutput = undefined
    const frame = this.cloudFrame?.()
    const width = Math.ceil(context.drawingBufferWidth*this._cloudColorStage.textureScale)
    const height = Math.ceil(context.drawingBufferHeight*this._cloudColorStage.textureScale)
    this.cloudJitterActive = frame ? this.cloudTemporal.prepare(frame,width,height) : false
    if(collection.ready && this._cloudComposite.ready) {
      collection.execute(context,color,depth,id)
      const cloudColor = this._cloudColorStage.outputTexture, cloudDepth = this._cloudDepthStage.outputTexture
      const resolve=()=>frame ? this.cloudTemporal.execute(context,cloudColor,cloudDepth,frame) : cloudColor
      this.cloudOutput = this.environmentGraph?this.environmentGraph.run('cloud.temporal',resolve):resolve()
      return !!this.cloudOutput
    }
    this.cloudTemporal.reset('cloud stages not ready')
    return false
  }

  _ensureCloudCollection() {
    if(!this.cloudCollection && this._cloudComposite) {
      this.cloudCollection = new this.C.PostProcessStageCollection()
      this.cloudCollection.fxaa.enabled = false
      this.cloudCollection.ambientOcclusion.enabled = false
      this.cloudCollection.bloom.enabled = false
      this.cloudCollection.add(this._cloudComposite)
      this.cloudTemporal = new CloudTemporal143(this.C,this.scene)
      this.environmentGraph?.installCollection(this.cloudCollection,[
        {key:'cloud.march',stage:this._cloudColorStage},{key:'cloud.depth',stage:this._cloudDepthStage}])
    }
  }

  _ensureOcclusionCollection() {
    if(!this.occlusionCollection && this._occlusionStage) {
      const collection=this.occlusionCollection=new this.C.PostProcessStageCollection()
      collection.fxaa.enabled=false;collection.ambientOcclusion.enabled=false;collection.bloom.enabled=false
      collection.add(this._occlusionStage)
      this.environmentGraph?.installCollection(collection,[{key:'environment.medium',stage:this._occlusionStage}])
    }
  }

  /**
   * B08：执行介质遮挡/透射率 stage。
   *
   * 独立 collection 的理由：这个 stage 的**输出是数据而不是颜色**。
   * 若把它并入 composite，遮挡率会被当作场景颜色画到屏幕上。
   *
   * 失败不影响主呈像：捕获错误并记录，主链照常输出（遮挡数据是可选消费者输入）。
   */
  _executeOcclusion(context, color, depth, id) {
    this.occlusionFrame = undefined
    const stage = this._occlusionStage
    if (!stage) return
    if (!stage.enabled) { this.occlusionReason = 'No medium consumer requested'; return }
    try {
      this._ensureOcclusionCollection()
      const collection = this.occlusionCollection
      collection.update(context, this.scene.frameState.useLogDepth, false)
      collection.clear(context)
      if (!collection.ready || !stage.ready) { this.occlusionReason = 'occlusion stage not ready'; return }
      const bindings = this.prepareFrame(context), programs = []
      if (stage._command) programs.push(stage._command.shaderProgram)
      if (bindings.length) withUniformBlocks(context._gl, programs, bindings, () => collection.execute(context, color, depth, id))
      else collection.execute(context, color, depth, id)
      this.occlusionReason = null
      this.occlusionFrame = this.scene.frameState.frameNumber
    } catch (error) {
      // 遮挡数据失败不应拖垮环境呈像；记录下来供诊断。
      this.occlusionReason = error instanceof Error ? error.message : String(error)
    }
  }

  _fail(error) {    this.error = error instanceof Error ? error.message : String(error)
    this.stats.failures++
    this._release()
    this.reason = 'environment failure'
  }

  _release() {
    this.enabled = false
    this._valid = false
    this.warmKeys = []
    const detachHdr = this._detachHdr
    this._detachHdr = undefined
    if (detachHdr) detachHdr()
    this.environmentGraph?.destroy();this.environmentGraph=undefined;this.prepareAtmosphere=undefined
    this.cloudTemporal?.destroy()
    this.cloudTemporal = undefined
    if(this.cloudCollection && !this.cloudCollection.isDestroyed()) this.cloudCollection.destroy()
    // A failed creation can leave the independent composite outside a collection.
    else if(this._cloudComposite && !this._cloudComposite.isDestroyed()) this._cloudComposite.destroy()
    this.cloudCollection = undefined
    this._cloudComposite = this._cloudColorStage = this._cloudDepthStage = undefined
    this.cloudOutput = undefined; this.cloudJitterActive = false
    // B08：先释放独立的遮挡 collection，再释放主 collection。
    const occlusionCollection = this.occlusionCollection
    this.occlusionCollection = undefined
    this._occlusionStage = undefined
    this.occlusionReason = undefined
    this.occlusionFrame = undefined
    if (occlusionCollection && !occlusionCollection.isDestroyed()) {
      try {
        occlusionCollection.destroy()
      } catch (error) {
        this.error = this.error || (error instanceof Error ? error.message : String(error))
      }
    }
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
    this.releaseFrame()
  }

  getDiagnostics() {
    const unsupported = this._unsupportedReason()
    const scopeReason = this.enabled ? this._scopeReason() : null
    const frustums = !this._sceneDestroyed() && frustumBinsOf(this.scene)
    return {
      enabled: this.enabled,
      supported: !unsupported,
      valid: !this._destroyed && this.enabled && this._valid && !scopeReason,
      reason: this._destroyed ? 'destroyed' : unsupported || scopeReason || this.reason,
      error: this.error,
      frustumCount: frustums ? frustums.length : 0,
      stats: { ...this.stats },
      cloudTemporal: this.cloudTemporal?.getDiagnostics() || {valid:false,reason:'cloud stages inactive'}
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
