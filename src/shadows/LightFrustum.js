export default class LightFrustum {
  constructor(C, scene) {
    this.C = C
    this.ellipsoid = scene.globe?.ellipsoid || C.Ellipsoid.WGS84
    this.camera = new C.Camera(scene)
    this.camera.frustum = new C.OrthographicFrustum({ width: 1, aspectRatio: 1, near: 1, far: 1000 })
    this.viewProjection = new C.Matrix4()
    this.eyeToShadow = new C.Matrix4()
    this.surfaceProjection = new C.Matrix4()
    const frustum=this.camera.frustum
    this.baseProjection=Object.getOwnPropertyDescriptor(C.OrthographicFrustum.prototype,'projectionMatrix').get.bind(frustum)
    const baseCulling=frustum.computeCullingVolume.bind(frustum)
    Object.defineProperty(frustum,'projectionMatrix',{get:()=>this.surfaceActive?this.surfaceProjection:this.baseProjection()})
    frustum.computeCullingVolume=(...args)=>this.surfaceActive?this.matrixCulling():baseCulling(...args)
  }

  matrixCulling() {
    const C=this.C,m=this.viewProjection,planes=[]
    // The surface projection is affine but its XY axes need not be orthogonal.
    // Derive the clipping planes from the exact matrix used by the depth draw.
    for(let axis=0;axis<3;axis++)for(const sign of [1,-1]){
      const p=new C.Cartesian4(m[3]+sign*m[axis],m[7]+sign*m[axis+4],m[11]+sign*m[axis+8],m[15]+sign*m[axis+12])
      C.Cartesian4.divideByScalar(p,Math.hypot(p.x,p.y,p.z),p);planes.push(p)
    }
    return new C.CullingVolume(planes)
  }

  surfaceGrid(reference,direction,extent,size,reset) {
    const C=this.C,point=this.ellipsoid.scaleToGeodeticSurface(reference,new C.Cartesian3())
    if(!point)return null
    const normal=this.ellipsoid.geodeticSurfaceNormal(point,new C.Cartesian3())
    if(!this.surfaceFrame||reset||C.Cartesian3.dot(normal,this.surfaceFrame.up)<.999){
      const frame=C.Transforms.eastNorthUpToFixedFrame(point,this.ellipsoid)
      let east=C.Cartesian3.cross(direction,normal,new C.Cartesian3())
      if(C.Cartesian3.magnitudeSquared(east)<.01){const v=C.Matrix4.getColumn(frame,0,new C.Cartesian4());east=new C.Cartesian3(v.x,v.y,v.z)}
      C.Cartesian3.normalize(east,east)
      this.surfaceFrame={east,north:C.Cartesian3.cross(normal,east,new C.Cartesian3()),up:normal}
      this.gridAnchor=C.Cartesian3.clone(point);this.surfaceExtents=null
    }
    const {east,north,up}=this.surfaceFrame,vertical=C.Cartesian3.dot(direction,up)
    // Near the horizon direct sunlight is already vanishing. Avoid an ill-
    // conditioned projection there; preserve the ordinary orthographic path.
    if(vertical<=.01)return null
    // u = east - (lightEast/lightUp)*height, likewise for north. A light ray
    // keeps the same UV; a ground point keeps the same UV as the sun moves.
    // Keep the ground axes fixed across frames instead of following solar yaw.
    const project=axis=>C.Cartesian3.subtract(axis,C.Cartesian3.multiplyByScalar(up,C.Cartesian3.dot(axis,direction)/vertical,new C.Cartesian3()),new C.Cartesian3())
    const axes=[project(east),project(north)],requested=axes.map(axis=>extent*C.Cartesian3.magnitude(axis)*1.005)
    if(this.surfaceBaseExtent!==extent){this.surfaceExtents=null;this.surfaceBaseExtent=extent}
    this.surfaceExtents??=[0,0]
    for(let i=0;i<2;i++)if(requested[i]>this.surfaceExtents[i]||requested[i]<this.surfaceExtents[i]*.7)
      this.surfaceExtents[i]=2**(Math.ceil(Math.log2(requested[i])*8)/8)
    return {axes,adjust:[east,north],steps:this.surfaceExtents.map(value=>2*value/size),point}
  }

  update(origin, toLight, extent, size, stabilize = false, depthBounds = null, gridReference = null) {
    const C = this.C
    const direction = C.Cartesian3.normalize(toLight, new C.Cartesian3())
    const resetSurface=this.previousDirection&&C.Cartesian3.dot(direction,this.previousDirection)<Math.cos(.01)
    this.surfaceActive=false
    const surface=stabilize&&gridReference?this.surfaceGrid(gridReference,direction,extent,size,resetSurface):null
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
      // Anchor the surface grid on the ellipsoid, independently of first-LOD
      // bounds. Legacy direct callers retain the deterministic local-cell grid.
      const reference=surface?.point||gridReference||origin
      const axes=surface?.axes||[right,up],adjust=surface?.adjust||axes,steps=surface?.steps||[this.texelWorld,this.texelWorld]
      let anchor=this.gridAnchor
      if(!gridReference||!anchor||C.Cartesian3.distance(reference,anchor)>5000){
        const next=surface?C.Cartesian3.clone(reference):new C.Cartesian3(Math.round(reference.x/1000)*1000,
          Math.round(reference.y/1000)*1000,Math.round(reference.z/1000)*1000)
        // Rebase a moving camera without changing the existing world-grid phase.
        if(gridReference&&anchor)for(let i=0;i<2;i++){
          const axis=axes[i],step=steps[i]
          const distance=C.Cartesian3.dot(C.Cartesian3.subtract(anchor,next,new C.Cartesian3()),axis)
          C.Cartesian3.add(next,C.Cartesian3.multiplyByScalar(adjust[i],distance-Math.round(distance/step)*step,new C.Cartesian3()),next)
        }
        anchor=next
        if(gridReference)this.gridAnchor=anchor
      }
      const relative=C.Cartesian3.subtract(origin,anchor,new C.Cartesian3())
      for (let i=0;i<2;i++) {
        const axis=axes[i],step=steps[i]
        const coordinate = C.Cartesian3.dot(relative, axis)
        C.Cartesian3.add(center, C.Cartesian3.multiplyByScalar(adjust[i],
          Math.round(coordinate / step) * step - coordinate, new C.Cartesian3()), center)
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
    if(surface){
      const projection=C.Matrix4.clone(this.baseProjection(),this.surfaceProjection),cameraRight=this.camera.rightWC,cameraUp=this.camera.upWC
      projection[0]=C.Cartesian3.dot(surface.axes[0],cameraRight)/this.surfaceExtents[0]
      projection[4]=C.Cartesian3.dot(surface.axes[0],cameraUp)/this.surfaceExtents[0]
      projection[1]=C.Cartesian3.dot(surface.axes[1],cameraRight)/this.surfaceExtents[1]
      projection[5]=C.Cartesian3.dot(surface.axes[1],cameraUp)/this.surfaceExtents[1]
      this.surfaceActive=true
    }
    C.Matrix4.multiply(this.camera.frustum.projectionMatrix, this.camera.viewMatrix, this.viewProjection)
    this.cullingVolume = this.camera.frustum.computeCullingVolume(this.camera.positionWC, this.camera.directionWC, this.camera.upWC)
  }

  receiverMatrix(camera) {
    return this.C.Matrix4.multiply(this.viewProjection, camera.inverseViewMatrix, this.eyeToShadow)
  }
}
