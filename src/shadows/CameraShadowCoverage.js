// The camera selects the geographic region; no business/campus anchor is needed.
export default class CameraShadowCoverage {
  constructor(C) { this.C=C; this.center=new C.Cartesian3(); this.extent=0 }
  update(camera, distance, ellipsoid = this.C.Ellipsoid.WGS84) {
    const C=this.C, position=camera.positionWC, direction=camera.directionWC
    const ray=new C.Ray(position,direction), interval=C.IntersectionTests.rayEllipsoid(ray,ellipsoid)
    const focus=interval&&interval.start>0?interval.start:distance*.35
    C.Ray.getPoint(ray,focus,this.center)
    const frustum=camera.frustum, fovy=frustum.fovy||Math.PI/3
    const footprint=focus*Math.tan(fovy/2)*Math.max(1,frustum.aspectRatio||1)
    const requested=Math.max(distance*.5,footprint*1.3)
    const tier=2**Math.ceil(Math.log2(requested))
    if(!this.extent||requested>this.extent||requested<this.extent*.4)this.extent=tier
    return {center:this.center,extent:this.extent,focusDistance:focus}
  }
}
