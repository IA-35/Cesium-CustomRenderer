// B09：镜头效果与色调映射的管线管理器。
//
// 职责：创建/销毁 stage、把解析后的设置映射到 uniform、暴露诊断。
// 不负责：曲线数学（`toneMapping143.js`）、效果着色器（`lensEffects143.js`）。
//
// ⚠️ 文件名必须与 `lensEffects143.js` 在**大小写上明显不同**：
// Windows 文件系统大小写不敏感，`LensEffects143.js` 与 `lensEffects143.js`
// 会被视为同一个文件。本项目实测过该事故——管理器写进 `LensEffects143.js`
// 时直接覆盖了着色器模块，导致 `EXCLUSIVE_BLUR_EFFECTS` 导出消失。
// 因此这里用 `LensEffectPipeline143.js`。
//
// 为什么需要管理器而不是直接往 collection 里加 stage：
//   1. 效果必须**默认关闭且不引入任何开销**——关闭时不创建 stage，
//      而不是留一个空转的 pass；
//   2. 原生 tonemap 的所有权必须显式记录（自建曲线要关闭它，销毁时要还原），
//      否则第三方代码与 CCR 会互相覆盖；
//   3. 互斥规则要在 API 层固化并如实报告（见 `resolveLensEffects`）。
import { registerHdrEffect } from '../environment/HdrCoordinator143.js'
import {
  resolveToneMapping, canEnableCurve, toneMappingDiagnostics, unrealFilmicShader
} from '../stages/toneMapping143.js'
import {
  resolveLensEffects, EXCLUSIVE_BLUR_EFFECTS,
  tiltShiftShader, blurShader, depthOfFieldShader, chromaticAberrationShader,
  lightShaftShader, sunFlareShader
} from '../stages/lensEffects143.js'

let nextId = 0

export default class LensEffectPipeline143 {
  constructor(C, scene, getOptions, getOcclusion = () => null, getMaterials = () => null) {
    if (!/^1\.143(?:\.0)?$/.test(C.VERSION)) throw new Error('LensEffectPipeline143 requires Cesium 1.143')
    Object.assign(this, { C, scene, getOptions, getOcclusion, getMaterials, enabled: false, destroyed: false, failed: false })
    this.error = null
    this.reason = 'Disabled'
    this.stages = {}
    this.detach = undefined
    this.ownedTonemapper = undefined
    this.missing = ['webgl2', 'floatingPointTexture', 'colorBufferFloat']
      .filter(name => !scene.context || !scene.context[name])
    this.supported = this.missing.length === 0
    this.stats = { frames: 0, stageExecutions: 0, bypasses: 0 }
    this.outputFrame = undefined
  }

  _sceneDestroyed() { return !!(this.scene.isDestroyed && this.scene.isDestroyed()) }

  scopeReason() {
    if (this.destroyed || this._sceneDestroyed()) return 'Destroyed'
    if (!this.supported) return `Missing ${this.missing.join(', ')}`
    if (!this.enabled) return this.failed ? 'Lens effects failed; disable before retrying' : 'Disabled'
    if (this.scene.context._gl.isContextLost()) return 'Context lost'
    if (!this.scene.frameState.passes.render) return 'Not a color frame'
    return null
  }

  setEnabled(value) {
    if (this.destroyed || this._sceneDestroyed()) return
    if (!value) {
      this._release()
      this.failed = false
      this.reason = 'Disabled'
      this.scene.requestRender()
      return
    }
    if (this.enabled || this.failed) return
    try {
      this.error = null
      this._createStages()
      this.enabled = true
      if (!this.reason || this.reason === 'Disabled') this.reason = 'Not rendered'
    } catch (error) {
      this._fail(error)
    }
    this.scene.requestRender()
  }

  /**
   * 创建 stage 并注册到 HDR 链。
   *
   * 优先级 30：晚于环境 pass（20）与 bloom（22），因此 B08 的介质遮挡数据
   * 与云/雾结果都已就绪——光柱/光斑必须读到**同帧**数据。
   */
  _createStages() {
    const C = this.C, scene = this.scene, o = this.getOptions()
    const name = `lens_effects_${++nextId}`
    const sourceSize = new C.Cartesian2()
    const sizeOf = () => {
      sourceSize.x = scene.drawingBufferWidth || 1
      sourceSize.y = scene.drawingBufferHeight || 1
      return sourceSize
    }
    /** 只在开启时创建 stage，避免关闭状态下的空转 pass。 */
    const create = (key, shader, uniforms) => {
      const stage = new C.PostProcessStage({
        name: `${name}_${key}`, fragmentShader: shader,
        uniforms: { colorTexture: () => this._inputColor || scene.context.defaultTexture, ...uniforms },
        pixelFormat: C.PixelFormat.RGBA, pixelDatatype: C.PixelDatatype.FLOAT,
        sampleMode: C.PostProcessStageSampleMode.NEAREST
      })
      this.stages[key] = stage
      return stage
    }

    // --- 色调映射 ---------------------------------------------------------
    const tone = resolveToneMapping(o.toneMappingCurve)
    if (tone && tone.applyStage) {
      // 「只映射一次」的强制：自建曲线必须关闭原生 tonemap。
      // 拿不到可写句柄就拒绝启用该曲线（计划硬条款），而不是映射两次。
      const collection = scene.postProcessStages
      const canDisableNative = !!(collection && typeof collection === 'object' &&
        (collection._tonemapping || 'tonemapper' in collection))
      const permission = canEnableCurve(o.toneMappingCurve, { canDisableNative })
      if (!permission.enabled) throw new Error(permission.reason)
      if (!collection._tonemapping) throw new Error('Native tonemapping stage is not available to disable')
      // ⚠️ 只在创建时置一次 `enabled = false` **不够**。
      // Cesium 1.143 的 `PostProcessStageCollection.update` 每帧都会执行
      // `tonemapping.enabled = useHdr`（PostProcessStageCollection.js:611），
      // 下一帧就把我们的关闭覆盖回去。实测：连续 10 帧原生 `enabled` 全为 true，
      // 同时自定义 `tone` stage 也在执行 —— 即**映射两次**（重复曝光与显示编码），
      // 而诊断仍错误地报告 `exactlyOnce: true`。
      //
      // 正确做法：包裹 `collection.update`，在每次原生 update 之后重新关闭原生
      // tonemapping，从而在整个生命周期内持续持有「唯一映射权」。
      // 用包装而不是改 Cesium 内部字段，卸载时还原为原函数。
      this.ownedTonemapper = {
        collection,
        beforeEnabled: collection._tonemapping.enabled,
        beforeUpdate: collection.update
      }
      const owner = this
      collection.update = function (...args) {
        const result = owner.ownedTonemapper?.beforeUpdate.apply(this, args)
        // 原生 update 刚把 enabled 设成 useHdr，这里立即夺回。
        if (owner.ownedTonemapper && this._tonemapping) this._tonemapping.enabled = false
        return result
      }
      collection._tonemapping.enabled = false
      create('tone', unrealFilmicShader, {
        sourceSize: sizeOf,
        exposure: () => scene.postProcessStages.exposure ?? 1,
        toneActive: () => this._toneActive()
      })
    } else if (tone && tone.native && C.Tonemapper && tone.enumName) {
      // 原生曲线：替换枚举即可，曝光与 gamma 仍由 Cesium 负责。
      const collection = scene.postProcessStages
      const wanted = C.Tonemapper[tone.enumName]
      if (collection && wanted && collection.tonemapper !== wanted) {
        this.ownedTonemapper = { collection, before: collection.tonemapper }
        collection.tonemapper = wanted
      }
    }

    // --- 互斥的模糊类效果：最多一个 --------------------------------------
    const lens = resolveLensEffects(o)
    if (lens.effective.tiltShift) {
      create('tiltShift', tiltShiftShader, {
        sourceSize: sizeOf,
        tiltParams: () => new C.Cartesian4(o.tiltShiftFocus, o.tiltShiftWidth, o.tiltShiftRadius, o.tiltShiftStrength)
      })
    } else if (lens.effective.blur) {
      create('blur', blurShader, {
        sourceSize: sizeOf,
        blurParams: () => new C.Cartesian4(o.blurRadius, o.blurStrength, 0, 0)
      })
    } else if (lens.effective.depthOfField) {
      create('depthOfField', depthOfFieldShader, {
        sourceSize: sizeOf,
        depthTexture: () => this._depthTexture() || scene.context.defaultTexture,
        dofParams: () => new C.Cartesian4(o.depthOfFieldFocus, o.depthOfFieldRange, o.depthOfFieldRadius, o.depthOfFieldStrength)
      })
    }

    if (o.chromaticAberrationEnabled === true && o.chromaticAberrationStrength > 0) {
      create('chromaticAberration', chromaticAberrationShader, {
        sourceSize: sizeOf,
        aberration: () => this.getOptions().chromaticAberrationStrength
      })
    }

    // --- 光柱 / 光斑：消费 B08 介质遮挡数据 ------------------------------
    const wantShaft = o.lightShaftEnabled === true && o.lightShaftStrength > 0
    const wantFlare = o.sunFlareEnabled === true && o.sunFlareStrength > 0
    if (wantShaft || wantFlare) {
      const occlusionUniforms = {
        occlusionTexture: () => {
          const data = this.getOcclusion()
          return data && data.valid && data.texture && !data.texture.isDestroyed()
            ? data.texture : scene.context.defaultTexture
        },
        shaftAvailable: () => (this.getOcclusion()?.valid ? 1 : 0),
        sunScreen: () => this._sunScreen()
      }
      if (wantShaft) {
        create('lightShaft', lightShaftShader, {
          ...occlusionUniforms,
          shaftParams: () => new C.Cartesian4(o.lightShaftStrength, o.lightShaftSamples, 1, 1)
        })
      }
      if (wantFlare) {
        create('sunFlare', sunFlareShader, {
          ...occlusionUniforms,
          flareParams: () => new C.Cartesian4(o.sunFlareStrength, 0.06, this.getOcclusion()?.valid ? 1 : 0, 0),
          sunColor: () => this._sunColor()
        })
      }
    }

    this.order = Object.keys(this.stages)
    if (!this.order.length) { this.reason = 'No lens effects requested'; return }
    // 每个 stage 依次串联：上一个的输出作为下一个的输入。
    this.detach = registerHdrEffect(scene, 30, (...args) => this._execute(...args))
    this.reason = 'Not rendered'
  }

  _depthTexture() {
    const materials = this.getMaterials()
    return materials && materials.getTextures ? materials.getTextures()?.eyeDepth : undefined
  }

  _toneActive() {
    return !this.scopeReason() && resolveToneMapping(this.getOptions().toneMappingCurve)?.applyStage === true
  }

  /**
   * 太阳屏幕位置（归一化 uv）；不可得或不在视锥内时返回屏幕外，使光柱/光斑自动退出。
   *
   * ⚠️ 实现要点（均为实测踩坑后确定）：
   *
   * 1. 太阳世界位置**不能**从 `scene.sun.positionWC` 取。Cesium 1.143 的 `Sun`
   *    是屏幕空间绘制的虚拟天体，**没有 `positionWC` 属性**；它自己就用
   *    `context.uniformState.sunPositionWC`（`Source/Scene/Sun.js:249`）。
   *    此前读取 `scene.sun.positionWC` 恒为 undefined，`_sunScreen()` 永远走
   *    屏幕外退出 —— 生产管线里光柱与光斑**从未生效**，而诊断仍报 valid。
   *    把该现象归因为「夹具关闭了太阳」是错误归因。
   *
   * 2. 不能对太阳方向做椭球求交再投影：`sunPositionWC` 是一个**极远的世界点**
   *    （实测模长约 1.55e11，即 Cesium 把太阳放在极远处而非椭球面上），
   *    求交得到椭球面上的点可能在相机背后，`worldToWindowCoordinates` 会给出
   *    巨大或错误坐标（实测 y = -349）。
   *
   * 正确做法：按**无穷远光源**处理——取方向后以 w=0 送入 view-projection。
   * 用 `sunPositionWC` 的**方向**（归一化）作为齐次 w=0 向量，这样得到的屏幕位置
   * 与距离无关，且位于相机后方时 z ≥ 0 可被正确剔除。
   * 判定「太阳是否在相机前方」用相机视线方向与太阳方向的点积，
   * 不依赖投影矩阵在远平面处的数值行为。
   */
  _sunScreen() {
    const C = this.C, scene = this.scene
    if (!this.sunScreen) this.sunScreen = new C.Cartesian2(-1, -1)
    const outside = () => { this.sunScreen.x = -1; this.sunScreen.y = -1; return this.sunScreen }
    try {
      const uniformState = scene.context && scene.context.uniformState
      const sunPositionWC = uniformState && uniformState.sunPositionWC
      if (!sunPositionWC) return outside()
      const camera = scene.camera
      if (!camera) return outside()
      // sunPositionWC 是极远点（模长 ~1.5e11），取方向即可（无穷远光源语义）。
      const direction = C.Cartesian3.normalize(sunPositionWC, new C.Cartesian3())
      const cameraDirection = camera.directionWC || camera.direction
      if (!cameraDirection) return outside()
      // 太阳在相机后方则不可见：用视线方向点积判定，比投影数值更稳健。
      if (C.Cartesian3.dot(direction, cameraDirection) <= 0.0) return outside()
      // w = 0 的齐次投影：方向 → NDC，与距离无关。
      const view = camera.viewMatrix
      const projection = camera.frustum.projectionMatrix
      if (!view || !projection) return outside()
      const viewDir = C.Matrix4.multiplyByPointAsVector(view, direction, new C.Cartesian3())
      const clip = C.Matrix4.multiplyByVector(projection,
        new C.Cartesian4(viewDir.x, viewDir.y, viewDir.z, 0), new C.Cartesian4())
      if (!(clip.w > 0)) return outside()
      const ndcX = clip.x / clip.w
      const ndcY = clip.y / clip.w
      if (!Number.isFinite(ndcX) || !Number.isFinite(ndcY)) return outside()
      // NDC -> uv（y 翻转，与纹理坐标系一致）。
      const u = ndcX * 0.5 + 0.5
      const v = 0.5 - ndcY * 0.5
      // 超出画面即视为不可见：不 clamp，让 shader 的屏外判定退出。
      if (u < 0 || u > 1 || v < 0 || v > 1) return outside()
      this.sunScreen.x = u
      this.sunScreen.y = v
    } catch { return outside() }
    return this.sunScreen
  }

  _sunColor() {
    const C = this.C, scene = this.scene
    if (!this.sunColorValue) this.sunColorValue = new C.Cartesian4(1, 0.96, 0.88, 1)
    const light = scene.light
    const color = light && light.color
    if (color) {
      this.sunColorValue.x = color.red
      this.sunColorValue.y = color.green
      this.sunColorValue.z = color.blue
    }
    const intensity = light && Number.isFinite(light.intensity) ? light.intensity : 1
    this.sunColorValue.w = Math.max(0, Math.min(4, intensity))
    return this.sunColorValue
  }

  _execute(context, color, depth, id) {
    this.outputFrame = undefined
    const reason = this.scopeReason()
    if (reason) { this.reason = reason; this.stats.bypasses++; return color }
    try {
      let current = color
      let ran = 0
      for (const key of this.order) {
        const stage = this.stages[key]
        if (!stage || stage.isDestroyed()) continue
        // 输入链：第一个用传入颜色，其后用上一个 stage 的输出。
        this._inputColor = current
        const collection = this._collectionFor(key, stage)
        collection.update(context, this.scene.frameState.useLogDepth, false)
        collection.clear(context)
        if (!collection.ready || !stage.ready) continue
        collection.execute(context, current, depth, id)
        if (stage.outputTexture && !stage.outputTexture.isDestroyed()) { current = stage.outputTexture; ran++ }
      }
      if (!ran) { this.reason = 'No stage ready'; this.stats.bypasses++; return color }
      this.outputFrame = this.scene.frameState.frameNumber
      this.reason = null
      this.stats.frames++
      this.stats.stageExecutions += ran
      return current
    } catch (error) {
      this._fail(error)
      return color
    }
  }

  /** 每个 stage 一个独立 collection，以便逐个串联并读取各自 outputTexture。 */
  _collectionFor(key, stage) {
    if (!this.collections) this.collections = new Map()
    let collection = this.collections.get(key)
    if (!collection) {
      collection = new this.C.PostProcessStageCollection()
      collection.fxaa.enabled = false
      collection.ambientOcclusion.enabled = false
      collection.bloom.enabled = false
      collection.add(stage)
      this.collections.set(key, collection)
    }
    return collection
  }

  getDiagnostics() {
    const o = this.getOptions()
    const lens = resolveLensEffects(o)
    return {
      enabled: this.enabled, supported: this.supported, missing: this.missing.slice(),
      valid: !this.scopeReason() && this.outputFrame === this.scene.frameState.frameNumber,
      reason: this.scopeReason() || this.reason, error: this.error, failed: this.failed,
      activeStages: this.order ? this.order.slice() : [],
      toneMapping: toneMappingDiagnostics(o.toneMappingCurve),
      // 互斥必须如实报告：requested 与 effective 都要给，被压制的带原因。
      lens: { requested: lens.requested, active: lens.active, effective: lens.effective,
        suppressed: lens.suppressed, exclusive: [...EXCLUSIVE_BLUR_EFFECTS] },
      stats: { ...this.stats },
      allocationScope: 'owned post-process stage textures for enabled effects only'
    }
  }

  _fail(error) {
    this.error = error instanceof Error ? error.message : String(error)
    this._release()
    this.failed = true
    this.reason = 'Lens effects failed; disable before retrying'
  }

  _release() {
    this.enabled = false
    this.outputFrame = undefined
    if (this.detach) this.detach()
    this.detach = undefined
    // 还原原生 tonemap 的所有权（无论是被禁用、换了曲线，还是包裹了 update）。
    if (this.ownedTonemapper) {
      const { collection, before, beforeEnabled, beforeUpdate } = this.ownedTonemapper
      try {
        if (collection && !(collection.isDestroyed && collection.isDestroyed())) {
          // 先解除 update 包裹，避免还原后仍被每帧改写。
          if (beforeUpdate && collection.update !== beforeUpdate) collection.update = beforeUpdate
          if (before !== undefined) collection.tonemapper = before
          if (collection._tonemapping && beforeEnabled !== undefined) collection._tonemapping.enabled = beforeEnabled
        }
      } catch { /* 还原失败不应阻断销毁流程 */ }
      this.ownedTonemapper = undefined
    }
    if (this.collections) {
      for (const collection of this.collections.values()) {
        if (collection && !collection.isDestroyed()) {
          try { collection.destroy() } catch { /* 可能已随上下文销毁 */ }
        }
      }
      this.collections.clear()
    }
    this.collections = undefined
    this.stages = {}
    this.order = undefined
    this._inputColor = undefined
    this.reason = 'Disabled'
  }

  isDestroyed() { return this.destroyed }
  destroy() {
    if (this.destroyed) return
    this._release()
    this.destroyed = true
  }
}
