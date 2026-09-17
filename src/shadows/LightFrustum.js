export default class LightFrustum {
  constructor(C, scene) {
    this.C = C
    this.camera = new C.Camera(scene)
    this.camera.frustum = new C.OrthographicFrustum({ width: 1, aspectRatio: 1, near: 1, far: 1000 })
    this.viewProjection = new C.Matrix4()
    this.eyeToShadow = new C.Matrix4()
  }

  update(origin, toLight, extent, size, stabilize = false, depthBounds = null) {
    const C = this.C
    const direction = C.Cartesian3.normalize(toLight, new C.Cartesian3())
    const radial = C.Cartesian3.normalize(origin, new C.Cartesian3())
    const fallback = Math.abs(direction.z) > 0.95 ? C.Cartesian3.UNIT_X : C.Cartesian3.UNIT_Z
    // Stable axes must not inherit the first (possibly coarse-LOD) receiver
    // centre. The sun alone establishes their initial orientation.
    const reference = stabilize || Math.abs(C.Cartesian3.dot(radial, direction)) > 0.95 ? fallback : radial
    let right = C.Cartesian3.normalize(C.Cartesian3.cross(direction, reference, new C.Cartesian3()), new C.Cartesian3())
    if(stabilize&&this.previousRight&&C.Cartesian3.equals(direction,this.previousDirection))right=C.Cartesian3.clone(this.previousRight)
    else if(stabilize&&this.previousRight){
      const projected=C.Cartesian3.subtract(this.previousRight,C.Cartesian3.multiplyByScalar(direction,C.Cartesian3.dot(this.previousRight,direction),new C.Cartesian3()),new C.Cartesian3())
      if(C.Cartesian3.magnitudeSquared(projected)>.01)right=C.Cartesian3.normalize(projected,projected)
    }
    if(stabilize)this.previousRight=C.Cartesian3.clone(right,this.previousRight)
    if(stabilize)this.previousDirection=C.Cartesian3.clone(direction,this.previousDirection)
    const up = C.Cartesian3.normalize(C.Cartesian3.cross(right, direction, new C.Cartesian3()), new C.Cartesian3())
    this.texelWorld = 2 * extent / size
    // Unstabilized mode retains exact positioning for isolated light-camera callers.
    const center = C.Cartesian3.clone(origin)
    if (stabilize) {
      // Use an absolute light-space grid in JS double precision. A grid anchored
      // to the first receiver retains asynchronous terrain LOD history forever.
      for (const axis of [right, up]) {
        const coordinate = C.Cartesian3.dot(origin, axis)
        C.Cartesian3.add(center, C.Cartesian3.multiplyByScalar(axis,
          Math.round(coordinate / this.texelWorld) * this.texelWorld - coordinate, new C.Cartesian3()), center)
      }
    }
    const grid=Math.max(16,extent/8)
    const top=depthBounds?Math.ceil(depthBounds.max/grid)*grid+grid:extent*2
    const bottom=depthBounds?Math.floor(depthBounds.min/grid)*grid-grid:-extent*2
    const position = C.Cartesian3.add(center, C.Cartesian3.multiplyByScalar(direction, top, new C.Cartesian3()), new C.Cartesian3())
    // Camera.setView adjusts orthographic zoom using scene depth picking. Calling
    // it inside rendering re-enters the main scene and clears its command/pass state.
    C.Cartesian3.clone(position, this.camera.position)
    C.Cartesian3.negate(direction, this.camera.direction)
    C.Cartesian3.clone(up, this.camera.up)
    C.Cartesian3.cross(this.camera.direction, this.camera.up, this.camera.right)
    Object.assign(this.camera.frustum, { width: extent * 2, aspectRatio: 1, near: 1, far: top-bottom })
    this.depthSpan = top-bottom-1
    this.cullingVolume = this.camera.frustum.computeCullingVolume(this.camera.positionWC, this.camera.directionWC, this.camera.upWC)
    C.Matrix4.multiply(this.camera.frustum.projectionMatrix, this.camera.viewMatrix, this.viewProjection)
  }

  receiverMatrix(camera) {
    return this.C.Matrix4.multiply(this.viewProjection, camera.inverseViewMatrix, this.eyeToShadow)
  }
}
