export default class LightFrustum {
  constructor(C, scene) {
    this.C = C
    this.camera = new C.Camera(scene)
    this.camera.frustum = new C.OrthographicFrustum({ width: 1, aspectRatio: 1, near: 1, far: 1000 })
    this.viewProjection = new C.Matrix4()
    this.eyeToShadow = new C.Matrix4()
  }

  update(origin, toLight, extent, size) {
    const C = this.C
    const direction = C.Cartesian3.normalize(toLight, new C.Cartesian3())
    const radial = C.Cartesian3.normalize(origin, new C.Cartesian3())
    const fallback = Math.abs(direction.z) > 0.95 ? C.Cartesian3.UNIT_X : C.Cartesian3.UNIT_Z
    const reference = Math.abs(C.Cartesian3.dot(radial, direction)) > 0.95 ? fallback : radial
    const right = C.Cartesian3.normalize(C.Cartesian3.cross(direction, reference, new C.Cartesian3()), new C.Cartesian3())
    const up = C.Cartesian3.normalize(C.Cartesian3.cross(right, direction, new C.Cartesian3()), new C.Cartesian3())
    this.texelWorld = 2 * extent / size
    // The receiver region has a fixed campus anchor, not a camera-following
    // center. Snapping its Earth-scale projections onto rotating light axes
    // introduces up to one texel of artificial motion on every sun update.
    const center = C.Cartesian3.clone(origin)
    const position = C.Cartesian3.add(center, C.Cartesian3.multiplyByScalar(direction, extent * 2, new C.Cartesian3()), new C.Cartesian3())
    // Camera.setView adjusts orthographic zoom using scene depth picking. Calling
    // it inside rendering re-enters the main scene and clears its command/pass state.
    C.Cartesian3.clone(position, this.camera.position)
    C.Cartesian3.negate(direction, this.camera.direction)
    C.Cartesian3.clone(up, this.camera.up)
    C.Cartesian3.cross(this.camera.direction, this.camera.up, this.camera.right)
    Object.assign(this.camera.frustum, { width: extent * 2, aspectRatio: 1, near: 1, far: extent * 4 })
    this.depthSpan = extent * 4 - 1
    this.cullingVolume = this.camera.frustum.computeCullingVolume(this.camera.positionWC, this.camera.directionWC, this.camera.upWC)
    C.Matrix4.multiply(this.camera.frustum.projectionMatrix, this.camera.viewMatrix, this.viewProjection)
  }

  receiverMatrix(camera) {
    return this.C.Matrix4.multiply(this.viewProjection, camera.inverseViewMatrix, this.eyeToShadow)
  }
}
