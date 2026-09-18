import HdrEnvironmentPass143 from './HdrEnvironmentPass143.js'
import EnvironmentLighting143 from './EnvironmentLighting143.js'
import { resolveEnvironmentState } from './environmentState.js'
import { createEnvironmentStages } from './environmentStages.js'
import createNoiseAtlas from './noiseAtlas.js'
import UniformBuffer143,{uniformBuffersSupported} from '../buffers/UniformBuffer143.js'

export default class EnvironmentRenderer {
  constructor(C, viewer, getOptions, getShadow) {
    Object.assign(this, { C, viewer, scene: viewer.scene, getOptions, getShadow, enabled: false, destroyed: false })
    this.lighting = new EnvironmentLighting143(C, this.scene)
    this.epoch = C.JulianDate.fromIso8601('2026-01-01T00:00:00Z')
    this.fixedRotation = new C.Matrix3()
    this.sunInertial = new C.Cartesian3()
    this.sunWorld = new C.Cartesian3()
    this.sunLocal = new C.Cartesian3(0, 0, 1)
    this.eyeToLocal = new C.Matrix4()
    this.localToShadow = new C.Matrix4()
    this.sourceSize = new C.Cartesian2()
    this.eyeToShell = new C.Matrix3()
    this.shellUp = new C.Cartesian3()
    this.shellRadiusHeight = new C.Cartesian2()
    this.shellNoiseOrigin = new C.Cartesian3()
    this.sunDirectionShell = new C.Cartesian3()
    this.shellRotation = new C.Matrix3()
    this.state = resolveEnvironmentState(getOptions())
    this.withinRegion = true
    this.hdr = new HdrEnvironmentPass143(C, this.scene, () => {
      if (!this.noise) this.noise = createNoiseAtlas(C, this.scene.context)
      const uniforms = {
        originalHdr: () => this.hdr.inputColor,
        surfaceDepthTexture: () => this.surfaceDepth() || this.scene.context.defaultTexture,
        surfaceDepthAvailable: () => !!this.surfaceDepth(),
        eyeToLocal: () => C.Matrix4.multiply(this.inverseFrame, viewer.camera.inverseViewMatrix, this.eyeToLocal),
        sunDirectionLocal: () => this.sunLocal,
        sunRadiance: () => new C.Cartesian3(...this.state.sunRadiance),
        skyRadiance: () => new C.Cartesian3(...this.state.skyRadiance),
        fogParams: () => new C.Cartesian4(this.state.fogDensity, this.state.fogScaleHeight, this.state.fogNoise, 5),
        fogBaseHeight: () => this.state.fogBaseHeight,
        // B08：局部参考原点的椭球高度。着色器用 (局部 z - 本值) 得到椭球高度。
        //
        // 当前实现里 `setOrigin` 把原点强制放在椭球面（高度 0），因此本值通常为 0，
        // 此时局部 z 就是椭球高度。仍然显式传它的理由是：原点在相机远离时会被
        // **重建为相机位置**（见 update()），把这个契约写进接口后，
        // 即使将来改为保留原点真实高程，高度语义也不会静默改变。
        localGroundHeight: () => this.originHeight || 0,
        cloudParams: () => new C.Cartesian4(this.state.cloudCoverage, this.state.cloudBase, this.state.cloudTop, this.state.cloudExtinction),
        windOffset: () => new C.Cartesian2(...this.state.windOffset),
        cloudModel: () => this.state.cloudModel === 'stratus' ? 1 : 0,
        effectFlags: () => new C.Cartesian4(getOptions().fog && this.withinRegion ? 1 : 0, this.state.clouds ? 1 : 0,
          this.state.sunScattering ? 1 : 0, this.state.volumetricFog ? 1 : 0),
        noiseTexture: () => this.noise,
        shadowTexture: () => this.shadowReady() ? this.getShadow().target.depth : this.scene.context.defaultTexture,
        localToShadow: () => this.shadowReady()
          ? C.Matrix4.multiply(this.getShadow().light.viewProjection, this.frame, this.localToShadow) : C.Matrix4.IDENTITY,
        shadowInfo: () => {
          const shadow = this.getShadow()
          return this.shadowReady() ? new C.Cartesian4(1, 1 / shadow.target.size, 0.25 / shadow.light.depthSpan, 0) : C.Cartesian4.ZERO
        },
        sourceSize: () => { this.sourceSize.x = viewer.canvas.width; this.sourceSize.y = viewer.canvas.height; return this.sourceSize }
      }
      if (this.state.cloudGeometry === 'shell') {
        uniforms.shellEmptyScene = () => this.scene._view.frustumCommandsList.length === 0
        for (const name of ['eyeToShell', 'shellUp', 'shellRadiusHeight', 'shellNoiseOrigin', 'sunDirectionShell']) {
          uniforms[name] = () => { this.updateShellCamera(); return this[name] }
        }
      }
      if(this.useFrameUniforms()){
        this.frameUniforms=new UniformBuffer143(this.scene.context._gl,192);this.frameData=new Float32Array(48);this.frameInputs=uniforms
      }
      this.stages = createEnvironmentStages(C, uniforms, this.state.environmentQuality, this.state.cloudGeometry,!!this.frameUniforms)
      // B08：把介质遮挡 stage 交给 HDR pass，在它的执行上下文里产出数据。
      this.hdr._occlusionStage = this.stages.occlusionStage
      return this.stages.composite
    }, () => this.state.cloudGeometry === 'shell',context=>{
      if(!this.frameUniforms)return []
      const data=this.frameData,input=this.frameInputs,matrix=input.eyeToLocal(),inverse=context.uniformState.inverseProjection
      for(let i=0;i<16;i++){data[i]=matrix[i];data[16+i]=inverse[i]}
      for(const [offset,name]of [[32,'sunDirectionLocal'],[36,'sunRadiance'],[40,'skyRadiance'],[44,'sunDirectionShell']]){
        const v=input[name]?.()||C.Cartesian3.ZERO;data[offset]=v.x;data[offset+1]=v.y;data[offset+2]=v.z;data[offset+3]=0
      }
      this.frameUniforms.update(data)
      return [{name:'CCREnvironmentFrame',buffer:this.frameUniforms}]
    },()=>{this.frameUniforms?.destroy();this.frameUniforms=null;this.frameInputs=null;this.frameData=null})
    this.removeUpdate = this.scene.preUpdate.addEventListener(() => this.update())
  }

  mediumRequested() {
    const options=this.getOptions()
    return !!((options.lightShaftEnabled&&options.lightShaftStrength>0)||
      (options.sunFlareEnabled&&options.sunFlareStrength>0))
  }

  useFrameUniforms() {
    // One raymarch consumer gains no sharing from a UBO, but its binding queries
    // serialize behind the shadow pass. Share only with the medium consumer.
    return this.mediumRequested()&&uniformBuffersSupported(this.scene.context)
  }

  shadowReady() {
    const shadow = this.getShadow()
    return !!(shadow && shadow.enabled && shadow.ready && shadow.target && !shadow.target.depth.isDestroyed())
  }

  updateShellCamera() {
    const C = this.C, ellipsoid = (this.scene.globe && this.scene.globe.ellipsoid) || C.Ellipsoid.WGS84
    const radius = ellipsoid.maximumRadius, radii = ellipsoid.radii
    const scale = new C.Cartesian3(radius / radii.x, radius / radii.y, radius / radii.z)
    const position = C.Cartesian3.multiplyComponents(this.viewer.camera.positionWC, scale, this.shellUp)
    const length = C.Cartesian3.magnitude(position)
    this.shellNoiseOrigin.x = ((position.x % 64000) + 64000) % 64000
    this.shellNoiseOrigin.y = ((position.y % 64000) + 64000) % 64000
    this.shellNoiseOrigin.z = ((position.z % 64000) + 64000) % 64000
    C.Cartesian3.divideByScalar(position, length, this.shellUp)
    this.shellRadiusHeight.x = radius
    this.shellRadiusHeight.y = length - radius
    C.Matrix4.getMatrix3(this.viewer.camera.inverseViewMatrix, this.shellRotation)
    C.Matrix3.multiply(C.Matrix3.fromScale(scale, this.eyeToShell), this.shellRotation, this.eyeToShell)
    C.Cartesian3.multiplyComponents(this.sunWorld, scale, this.sunDirectionShell)
    C.Cartesian3.normalize(this.sunDirectionShell, this.sunDirectionShell)
  }

  surfaceDepth() {
    // Cesium 1.143 resets this copy each frame and fills it before clearing the
    // globe depth. Query at execution time; retaining a prior frame is unsafe.
    const { globe, context } = this.scene
    const texture = context.uniformState && context.uniformState.globeDepthTexture
    return globe && globe.show && texture && !texture.isDestroyed() ? texture : undefined
  }

  setOrigin(origin) {
    if (this.destroyed) return
    const C = this.C
    const coordinate = C.Cartographic.fromCartesian(origin)
    this.origin = C.Cartesian3.fromRadians(coordinate.longitude, coordinate.latitude, 0)
    this.frame = C.Transforms.eastNorthUpToFixedFrame(this.origin)
    this.inverseFrame = C.Matrix4.inverseTransformation(this.frame, new C.Matrix4())
    // B08：记录局部参考原点的椭球高度，供着色器把局部切平面高度换算成椭球高度。
    //
    // 关键：`this.origin` 被强制放在椭球面（高度 0），所以正常情况下它是 0；
    // 但 `update()` 在相机远离原点时会用**相机位置**重建原点，此时局部 z=0
    // 对应的椭球高度就是相机高度。若不把它传给着色器，同一个雾参数会随
    // 「原点恰好是哪一个」而给出不同的密度——这正是「同一高度语义不一致」的根因。
    this.originHeight = C.Cartographic.fromCartesian(this.origin).height
    this.update()
  }

  update() {
    if (!this.enabled || this.destroyed || this.viewer.isDestroyed()) return
    if (this.viewer.camera && (!this.frame || (this.getOptions().cloudGeometry === 'shell' &&
        this.C.Cartesian3.distance(this.viewer.camera.positionWC, this.origin) > 80000 &&
        Math.abs(this.C.Cartographic.fromCartesian(this.viewer.camera.positionWC).height) < 50000))) {
      this.setOrigin(this.viewer.camera.positionWC)
      return
    }
    const C = this.C, time = this.viewer.clock.currentTime
    let altitude = 1
    if (this.frame) {
      C.Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(time, this.sunInertial)
      const rotation = C.Transforms.computeIcrfToFixedMatrix(time, this.fixedRotation)
        || C.Transforms.computeTemeToPseudoFixedMatrix(time, this.fixedRotation)
      C.Matrix3.multiplyByVector(rotation, this.sunInertial, this.sunWorld)
      C.Cartesian3.normalize(this.sunWorld, this.sunWorld)
      C.Matrix4.multiplyByPointAsVector(this.inverseFrame, this.sunWorld, this.sunLocal)
      altitude = this.sunLocal.z
      const cameraPosition = this.viewer.camera && this.viewer.camera.positionWC
      this.withinRegion = !cameraPosition || C.Cartesian3.distance(cameraPosition, this.origin) <= 100000
      if (!this.withinRegion) altitude = C.Cartesian3.dot(C.Cartesian3.normalize(cameraPosition, new C.Cartesian3()), this.sunWorld)
    }
    const previousQuality = this.state.environmentQuality
    const previousGeometry = this.state.cloudGeometry
    this.state = resolveEnvironmentState(this.getOptions(), altitude, C.JulianDate.secondsDifference(time, this.epoch))
    this.lighting.apply({ ...this.state, skyIntensity: this.state.skyLightIntensity,
      sunColor: new C.Color(...this.state.sunColor, 1) })
    if (this.frame && (this.withinRegion || this.state.cloudGeometry === 'shell')) {
      if (previousQuality !== this.state.environmentQuality || previousGeometry !== this.state.cloudGeometry ||
          !!this.frameUniforms !== this.useFrameUniforms()) this.hdr.setEnabled(false)
      if (!this.hdr.error) this.hdr.setEnabled(true)
    } else if (this.hdr.enabled) {
      // ENU cloud layers are regional. Preserve native global atmosphere instead
      // of treating the far side of Earth's curvature as below the fog layer.
      this.hdr.setEnabled(false)
    }
    if (this.stages?.occlusionStage) {
      this.stages.occlusionStage.enabled=this.mediumRequested()
    }
    this.syncNativeFog(this.hdr.enabled && !this.hdr._scopeReason())
  }

  syncNativeFog(active) {
    const state = this.nativeFog
    if (!state || state.released) return
    if (state.object.renderable !== state.applied) { state.released = true; return }
    state.object.renderable = active ? false : state.before
    state.applied = state.object.renderable
  }

  setEnabled(enabled) {
    if (this.destroyed) return
    // A user off/on transition may retry once; updates and repeated enables
    // retain the failure latch instead of allocating again every frame.
    if (enabled === true && !this.enabled) {
      this.hdr.error = null
      const fog = this.scene.fog
      if (fog) this.nativeFog = { object: fog, before: fog.renderable, applied: fog.renderable }
    }
    this.enabled = enabled === true
    if (this.enabled) {
      this.lighting.setEnabled(true)
      this.update()
    } else {
      this.hdr.setEnabled(false)
      this.syncNativeFog(false)
      this.nativeFog = undefined
      this.lighting.setEnabled(false)
      if (this.noise && !this.noise.isDestroyed()) this.noise.destroy()
      this.noise = undefined
      this.stages = undefined
    }
  }

  getDiagnostics() {
    const texture = this.stages && !this.stages.raymarchStage.isDestroyed() && this.stages.raymarchStage.outputTexture
    return { enabled: this.enabled, lighting: this.lighting.getDiagnostics(), hdr: this.hdr.getDiagnostics(),
      preset: this.state.environmentPreset, quality: this.state.environmentQuality, sunAltitude: this.sunLocal.z,
      withinRegion: this.withinRegion, volumeRadius: 100000,
      cloudGeometry: this.state.cloudGeometry, cloudScope: this.state.cloudGeometry === 'shell' ? 'ellipsoid-normalized shell; single-frustum depth' : 'local ENU',
      cloudModel: this.state.cloudModel, cloudCoverage: this.state.cloudCoverage, fogDensity: this.state.fogDensity,
      windOffset: this.state.windOffset.slice(), effectSize: texture && !texture.isDestroyed() ? [texture.width, texture.height] : null,
      // B08：介质遮挡数据的可用性契约。B09 消费前必须查这个字段，
      // 而不是假定纹理一定存在（未启用环境/未创建 stage 时它不存在）。
      mediumOcclusion: this.getMediumOcclusionDiagnostics() }
  }

  /**
   * B08 介质遮挡/透射率数据（供 B09 光柱与太阳光斑消费）。
   *
   * 契约：`valid` 为真时才可读取 `texture`。数据为半分辨率 RGBA32F：
   *   r = 太阳方向介质透射率，g = 太阳可见性（阴影），b = 视线介质透射率。
   *
   * 该数据由高度雾解析积分产出，来源是像素级材质深度/Hi-Z（B02），
   * **不依赖 B06 的对象级可见性**（主计划明确要求）。
   */
  getMediumOcclusionDiagnostics() {
    if (!this.enabled || !this.hdr?.getDiagnostics().valid || this.hdr.occlusionFrame !== this.scene.frameState.frameNumber) {
      return {valid:false,texture:null,reason:'No medium output for the current frame'}
    }
    const stage = this.stages && this.stages.occlusionStage
    if (!stage || stage.isDestroyed()) {
      return { valid: false, texture: null, reason: this.enabled ? 'Occlusion stage not created' : 'Environment disabled',
        contract: 'RGBA32F half-res: r=sun medium transmittance, g=sun visibility, b=view medium transmittance', source: 'analytic height fog from B02 material depth' }
    }
    if (this.hdr && this.hdr.occlusionReason) {
      return { valid: false, texture: null, reason: this.hdr.occlusionReason,
        contract: 'RGBA32F half-res: r=sun medium transmittance, g=sun visibility, b=view medium transmittance', source: 'analytic height fog from B02 material depth' }
    }
    const texture = stage.ready && stage.outputTexture
    if (!texture || texture.isDestroyed()) {
      return { valid: false, texture: null, reason: 'Occlusion stage not ready',
        contract: 'RGBA32F half-res: r=sun medium transmittance, g=sun visibility, b=view medium transmittance', source: 'analytic height fog from B02 material depth' }
    }
    return { valid: true, texture, size: [texture.width, texture.height],
      contract: 'RGBA32F half-res: r=sun medium transmittance, g=sun visibility, b=view medium transmittance',
      source: 'analytic height fog from B02 material depth' }
  }

  destroy() {
    if (this.destroyed) return
    this.setEnabled(false)
    this.removeUpdate()
    this.hdr.destroy()
    this.lighting.destroy()
    this.destroyed = true
  }
}
