export function cascadeSplits(near,far,count=3,lambda=.6){
  const splits=[near]
  for(let i=1;i<count;i++){const t=i/count;splits.push(lambda*near*(far/near)**t+(1-lambda)*(near+(far-near)*t))}
  splits.push(far);return splits
}

// Terrain tiles can temporarily carry continent-sized ancestor bounds during
// LOD changes. Their height envelope and the view rays give a stable receiver
// depth interval without treating that loose sphere as foreground geometry.
export function terrainDepthRange(C,camera,distance,minHeight,maxHeight,ellipsoid=C.Ellipsoid.WGS84){
  if(!Number.isFinite(minHeight)||!Number.isFinite(maxHeight))return {depthRange:[camera.frustum.near,distance]}
  const position=camera.positionWC,carto=ellipsoid.cartesianToCartographic(position)
  if(!carto)return {depthRange:[camera.frustum.near,distance]}
  const up=ellipsoid.geodeticSurfaceNormal(position,new C.Cartesian3()),f=camera.frustum,tan=Math.tan(f.fovy/2),rays=[]
  let maxDown=0
  for(const x of [-1,1])for(const y of [-1,1]){
    const ray=C.Cartesian3.clone(camera.directionWC)
    C.Cartesian3.add(ray,C.Cartesian3.multiplyByScalar(camera.rightWC,x*tan*f.aspectRatio+(f.xOffset||0)/f.near,new C.Cartesian3()),ray)
    C.Cartesian3.add(ray,C.Cartesian3.multiplyByScalar(camera.upWC,y*tan+(f.yOffset||0)/f.near,new C.Cartesian3()),ray)
    maxDown=Math.max(maxDown,-C.Cartesian3.dot(ray,up));rays.push(ray)
  }
  if(carto.height>maxHeight&&maxDown<=0)return null
  const near=Math.max(f.near,carto.height>maxHeight?(carto.height-maxHeight)/maxDown:f.near)
  if(near>=distance)return null
  const scale=1+minHeight/(minHeight>=0?ellipsoid.maximumRadius:ellipsoid.minimumRadius)
  const radii=C.Cartesian3.multiplyByScalar(ellipsoid.radii,scale,new C.Cartesian3()),inner=new C.Ellipsoid(radii.x,radii.y,radii.z)
  let far=0
  for(const direction of rays){
    const normalized=C.Cartesian3.normalize(direction,new C.Cartesian3()),hit=C.IntersectionTests.rayEllipsoid(new C.Ray(position,normalized),inner)
    if(!hit||hit.start<=0){far=distance;break}
    far=Math.max(far,hit.start*C.Cartesian3.dot(normalized,camera.directionWC))
  }
  return {depthRange:[near,Math.min(distance,far*1.001+1)]}
}

// Spheres are camera-frustum slices in world space, not an ellipsoid-height-zero
// footprint. Rotation cannot change their radii. Empty/out-of-range receivers
// produce no cascade even when the scene's sky far plane is enormous.
export default class CascadedShadowCoverage {
  constructor(C){this.C=C;this.extents=[];this.far=0}
  update(camera,distance,receivers,count=3){
    const C=this.C,direction=camera.directionWC,position=camera.positionWC
    let near=Infinity,far=0
    for(const sphere of receivers){
      if(sphere.depthRange){near=Math.min(near,sphere.depthRange[0]);far=Math.max(far,sphere.depthRange[1]);continue}
      if(!sphere?.center||!Number.isFinite(sphere.radius)||sphere.radius<0)continue
      const depth=C.Cartesian3.dot(C.Cartesian3.subtract(sphere.center,position,new C.Cartesian3()),direction)
      const lo=Math.max(camera.frustum.near,depth-sphere.radius),hi=Math.min(distance,camera.frustum.far,depth+sphere.radius)
      if(hi<=lo)continue
      near=Math.min(near,lo);far=Math.max(far,hi)
    }
    if(!Number.isFinite(near)||far<=near)return {near:0,far:0,splits:[],cascades:[]}
    near=Math.max(camera.frustum.near,2**(Math.floor(Math.log2(near)*4)/4))
    if(!this.far||far>this.far||far<this.far*.7)this.far=2**(Math.ceil(Math.log2(far)*4)/4)
    far=Math.min(distance,camera.frustum.far,this.far)
    const splits=cascadeSplits(near,far,count)
    const k=Math.tan(camera.frustum.fovy/2)*Math.hypot(1,camera.frustum.aspectRatio)
    const cascades=[]
    for(let i=0;i<count;i++){
      const start=i?splits[i]-.1*(splits[i]-splits[i-1]):near,end=splits[i+1],centerDepth=(start+end)/2
      let radius=Math.hypot((end-start)/2,end*k)
      let center=C.Cartesian3.add(position,C.Cartesian3.multiplyByScalar(direction,centerDepth,new C.Cartesian3()),new C.Cartesian3())
      const relevant=receivers.filter(b=>{
        if(b.depthRange)return b.depthRange[1]>=start&&b.depthRange[0]<=end
        if(!b?.center||!Number.isFinite(b.radius))return false
        const depth=C.Cartesian3.dot(C.Cartesian3.subtract(b.center,position,new C.Cartesian3()),direction)
        return depth+b.radius>=start&&depth-b.radius<=end
      })
      // A receiver lies inside both its geometry bounds and the frustum slice.
      // Either enclosing sphere is conservative for their intersection; choose
      // the tighter one so a small distant scene does not spend all texels on sky.
      if(relevant.length&&!relevant.some(b=>b.depthRange)){
        const receiverSphere=C.BoundingSphere.fromBoundingSpheres(relevant)
        if(receiverSphere.radius<radius){radius=receiverSphere.radius;center=C.Cartesian3.clone(receiverSphere.center)}
      }
      const requested=Math.max(1,radius)*1.005
      if(!this.extents[i]||requested>this.extents[i]||requested<this.extents[i]*.7)this.extents[i]=2**(Math.ceil(Math.log2(requested)*8)/8)
      cascades.push({near:start,far:end,centerDepth,center,extent:this.extents[i],receivers:relevant.length})
    }
    return {near,far,splits,cascades}
  }
}
