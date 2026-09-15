import HdrEnvironmentPass143 from './HdrEnvironmentPass143.js'
import EnvironmentLighting143 from './EnvironmentLighting143.js'
import { resolveEnvironmentState } from './environmentState.js'
import { createEnvironmentStages } from './environmentStages.js'
import createNoiseAtlas from './noiseAtlas.js'

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
      this.stages = createEnvironmentStages(C, uniforms, this.state.environmentQuality, this.state.cloudGeometry)
      return this.stages.composite
    }, () => this.state.cloudGeometry === 'shell')
    this.removeUpdate = this.scene.preUpdate.addEventListener(() => this.update())
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
      if (previousQuality !== this.state.environmentQuality || previousGeometry !== this.state.cloudGeometry) this.hdr.setEnabled(false)
      if (!this.hdr.error) this.hdr.setEnabled(true)
    } else if (this.hdr.enabled) {
      // ENU cloud layers are regional. Preserve native global atmosphere instead
      // of treating the far side of Earth's curvature as below the fog layer.
      this.hdr.setEnabled(false)
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
      windOffset: this.state.windOffset.slice(), effectSize: texture && !texture.isDestroyed() ? [texture.width, texture.height] : null }
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
