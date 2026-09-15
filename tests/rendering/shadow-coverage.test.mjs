import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import CameraShadowCoverage from '../../src/shadows/CameraShadowCoverage.js'
const C=createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')
function camera(lon,lat,height){const position=C.Cartesian3.fromDegrees(lon,lat,height);return {positionWC:position,directionWC:C.Cartesian3.negate(C.Cartesian3.normalize(position,new C.Cartesian3()),new C.Cartesian3()),frustum:{fovy:Math.PI/3,aspectRatio:1.5}}}
test('shadow coverage is available without a campus origin and follows remote camera regions',()=>{
 const coverage=new CameraShadowCoverage(C)
 const first=coverage.update(camera(116,40,500),4000)
 const a=C.Cartesian3.clone(first.center)
 const second=coverage.update(camera(114,26,500),4000)
 assert.ok(C.Cartesian3.distance(a,second.center)>1000000)
 assert.ok(Math.abs(C.Cartographic.fromCartesian(second.center).height)<1)
})
test('zooming out expands coverage; static cameras retain an identical center and extent',()=>{
 const coverage=new CameraShadowCoverage(C),cam=camera(114,26,500)
 const a=coverage.update(cam,4000),radius=a.extent,center=C.Cartesian3.clone(a.center)
 const b=coverage.update(cam,4000)
 assert.deepEqual(b.center,center);assert.equal(b.extent,radius)
 assert.ok(coverage.update(camera(114,26,10000),4000).extent>radius)
})
test('sky-facing cameras have no stale receiver region',()=>{
 const coverage=new CameraShadowCoverage(C),cam=camera(114,26,500)
 cam.directionWC=C.Cartesian3.normalize(cam.positionWC,new C.Cartesian3())
 const region=coverage.update(cam,4000)
 assert.ok(region.center&&Number.isFinite(region.extent))
 assert.ok(C.Cartesian3.distance(region.center,cam.positionWC)<4000)
})
