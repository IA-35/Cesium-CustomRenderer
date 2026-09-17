import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import CascadedShadowCoverage,{cascadeSplits,terrainDepthRange} from '../../src/shadows/CascadedShadowCoverage.js'
import LightFrustum from '../../src/shadows/LightFrustum.js'
const C=createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')
function camera(height=200){
 const position=C.Cartesian3.fromDegrees(120,40,height),direction=C.Cartesian3.negate(C.Cartesian3.normalize(position,new C.Cartesian3()),new C.Cartesian3())
 const right=C.Cartesian3.normalize(C.Cartesian3.cross(direction,C.Cartesian3.UNIT_Z,new C.Cartesian3()),new C.Cartesian3()),up=C.Cartesian3.cross(right,direction,new C.Cartesian3())
 return {positionWC:position,directionWC:direction,rightWC:right,upWC:up,frustum:{near:1,far:1e9,fovy:Math.PI/3,aspectRatio:1.6}}
}
function bounds(cam,depth,radius){return {center:C.Cartesian3.add(cam.positionWC,C.Cartesian3.multiplyByScalar(cam.directionWC,depth,new C.Cartesian3()),new C.Cartesian3()),radius}}
test('three practical splits use independent linear/log reference and monotone intervals',()=>{
 const actual=cascadeSplits(2,2000,3,.6)
 assert.equal(actual.length,4);assert.equal(actual[0],2);assert.equal(actual[3],2000)
 for(let i=1;i<3;i++)assert.ok(Math.abs(actual[i]-(.6*2*(1000**(i/3))+.4*(2+1998*i/3)))<1e-9)
})
test('visible receivers constrain shadow depth independently of sky far',()=>{
 const cam=camera(),coverage=new CascadedShadowCoverage(C),receivers=[bounds(cam,120,30),bounds(cam,280,20)]
 const a=coverage.update(cam,4000,receivers)
 assert.equal(a.cascades.length,3);assert.ok(a.far>=300&&a.far<450)
 cam.frustum.far=1e12;const b=coverage.update(cam,4000,receivers)
 assert.deepEqual(a,b)
 assert.equal(coverage.update(cam,4000,[]).cascades.length,0)
})
test('each stable sphere encloses receiver points in its slice and transition overlap',()=>{
 const cam=camera(),coverage=new CascadedShadowCoverage(C),receiver=bounds(cam,1500,500),r=coverage.update(cam,4000,[receiver])
 const right=C.Cartesian3.normalize(C.Cartesian3.cross(cam.directionWC,C.Cartesian3.UNIT_Z,new C.Cartesian3()),new C.Cartesian3()),up=C.Cartesian3.cross(right,cam.directionWC,new C.Cartesian3())
 let checked=0
 for(const c of r.cascades)for(let z=0;z<=10;z++)for(let x=-5;x<=5;x++)for(let y=-5;y<=5;y++){
   const depth=c.near+(c.far-c.near)*z/10,half=depth*Math.tan(cam.frustum.fovy/2)
   let point=C.Cartesian3.add(cam.positionWC,C.Cartesian3.multiplyByScalar(cam.directionWC,depth,new C.Cartesian3()),new C.Cartesian3())
   C.Cartesian3.add(point,C.Cartesian3.multiplyByScalar(right,x/5*half*cam.frustum.aspectRatio,new C.Cartesian3()),point)
   C.Cartesian3.add(point,C.Cartesian3.multiplyByScalar(up,y/5*half,new C.Cartesian3()),point)
   if(C.Cartesian3.distance(point,receiver.center)>receiver.radius)continue
   assert.ok(C.Cartesian3.distance(point,c.center)<=c.extent+1e-6);checked++
 }
 assert.ok(checked>10)
 assert.ok(r.cascades[1].near<r.splits[1]);assert.ok(r.cascades[2].near<r.splits[2])
})

test('a distant compact receiver does not waste resolution on empty frustum space',()=>{
 const cam=camera(10000),coverage=new CascadedShadowCoverage(C),r=coverage.update(cam,20000,[bounds(cam,10000,200)])
 const active=r.cascades.filter(c=>c.near<10200&&c.far>9800)
 assert.ok(active.length>0);assert.ok(active.every(c=>c.extent<=256))
})
test('invariant camera/receivers yield identical 300-frame coverage',()=>{
 const cam=camera(),coverage=new CascadedShadowCoverage(C),receivers=[bounds(cam,900,300)]
 const baseline=JSON.stringify(coverage.update(cam,4000,receivers))
 for(let i=0;i<300;i++)assert.equal(JSON.stringify(coverage.update(cam,4000,receivers)),baseline)
})

test('initial terrain LOD cannot permanently shift the final shadow texel grid',()=>{
 const scene={mapProjection:new C.GeographicProjection(),drawingBufferWidth:800,drawingBufferHeight:600,mode:C.SceneMode.SCENE3D}
 const a=new LightFrustum(C,scene),b=new LightFrustum(C,scene),origin=C.Cartesian3.fromDegrees(120,40,100)
 const earlier=C.Cartesian3.add(origin,new C.Cartesian3(100,200,300),new C.Cartesian3()),sun=C.Cartesian3.normalize(new C.Cartesian3(-.46,.79,.398),new C.Cartesian3())
 a.update(earlier,sun,512,2048,true)
 a.update(origin,sun,256,2048,true);b.update(origin,sun,256,2048,true)
 assert.deepEqual(Array.from(a.viewProjection),Array.from(b.viewProjection))
})
test('receivers outside shadow distance produce no work while elevated receivers retain altitude',()=>{
 const cam=camera(10000),coverage=new CascadedShadowCoverage(C)
 assert.equal(coverage.update(cam,4000,[bounds(cam,10000,100)]).cascades.length,0)
 const region=coverage.update(cam,20000,[bounds(cam,3000,300)])
 assert.ok(region.cascades.length===3)
 assert.ok(C.Cartographic.fromCartesian(region.cascades[0].center).height>6000)
})

test('light depth bounds include elevated and offscreen casters without changing XY resolution',()=>{
 const scene={mapProjection:new C.GeographicProjection(),drawingBufferWidth:800,drawingBufferHeight:600,mode:C.SceneMode.SCENE3D}
 const light=new LightFrustum(C,scene),origin=C.Cartesian3.fromDegrees(120,40,3000)
 light.update(origin,C.Cartesian3.UNIT_Z,100,2048,true,{min:-500,max:1800})
 for(const offset of [-500,1800]){
  const world=C.Cartesian3.add(origin,C.Cartesian3.multiplyByScalar(C.Cartesian3.UNIT_Z,offset,new C.Cartesian3()),new C.Cartesian3())
  const clip=C.Matrix4.multiplyByVector(light.viewProjection,new C.Cartesian4(world.x,world.y,world.z,1),new C.Cartesian4())
  assert.ok(Math.abs(clip.z/clip.w)<1,'caster must fit the light depth interval')
 }
 assert.equal(light.texelWorld,200/2048)
})

test('terrain height/ray range covers sampled ground without inheriting coarse tile radius',()=>{
 const cam=camera(),range=terrainDepthRange(C,cam,4000,0,0).depthRange
 assert.ok(range[1]<210)
 for(let x=-10;x<=10;x++)for(let y=-10;y<=10;y++){
   const ray=C.Cartesian3.clone(cam.directionWC),tan=Math.tan(cam.frustum.fovy/2)
   C.Cartesian3.add(ray,C.Cartesian3.multiplyByScalar(cam.rightWC,x/10*tan*cam.frustum.aspectRatio,new C.Cartesian3()),ray)
   C.Cartesian3.add(ray,C.Cartesian3.multiplyByScalar(cam.upWC,y/10*tan,new C.Cartesian3()),ray);C.Cartesian3.normalize(ray,ray)
   const hit=C.IntersectionTests.rayEllipsoid(new C.Ray(cam.positionWC,ray),C.Ellipsoid.WGS84)
   const depth=hit.start*C.Cartesian3.dot(ray,cam.directionWC)
   assert.ok(depth>=range[0]-.01&&depth<=range[1])
 }
 assert.equal(terrainDepthRange(C,camera(10000),4000,0,0),null)
 const elevated=terrainDepthRange(C,camera(2100),4000,2000,2000).depthRange
 assert.ok(elevated[1]<150)
})
