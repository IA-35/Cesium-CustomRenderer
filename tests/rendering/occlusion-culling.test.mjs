import test from 'node:test'
import assert from 'node:assert/strict'
import OcclusionCulling143,{projectOcclusionBounds,acceptOcclusionResult} from '../../src/visibility/OcclusionCulling143.js'
import {createRequire} from 'node:module'
const C=createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')
const camera={positionWC:C.Cartesian3.ZERO,viewMatrix:C.Matrix4.IDENTITY,frustum:new C.PerspectiveFrustum({fov:Math.PI/3,aspectRatio:1,near:1,far:1000})}
test('camera-inside and near-plane crossing bounds fail open',()=>{
 assert.equal(projectOcclusionBounds(C,camera,new C.BoundingSphere(new C.Cartesian3(0,0,-.5),2),640,480),null)
 assert.equal(projectOcclusionBounds(C,camera,new C.BoundingSphere(new C.Cartesian3(0,0,-2),1.5),640,480),null)
})
test('projected proxies conservatively enclose sphere corners and use nearest depth',()=>{
 const b=projectOcclusionBounds(C,camera,new C.BoundingSphere(new C.Cartesian3(0,0,-10),1),640,480)
 assert.ok(b.rect.x<-.19&&b.rect.z>.19);assert.equal(b.near,9);assert.ok(b.area>0)
})
test('two same-state available hidden results are required; stale and visible reset state',()=>{
 const state={hidden:false,misses:0}
 acceptOcclusionResult(state,false,'a','a');assert.equal(state.hidden,false)
 acceptOcclusionResult(state,false,'a','a');assert.equal(state.hidden,true)
 acceptOcclusionResult(state,false,'a','b');assert.equal(state.hidden,false);assert.equal(state.misses,0)
 acceptOcclusionResult(state,true,'b','b');assert.equal(state.hidden,false)
})

test('partial installation failure retires the draw hook and primitive before reporting failure',()=>{
 const native=()=>{},primitives=new Set()
 const scene={context:{webgl2:true,_gl:{createQuery(){}},draw:native},
  primitives:{add(p){primitives.add(p)},remove(p){primitives.delete(p)}},
  preUpdate:{addEventListener(){throw new Error('injected install failure')}},requestRender(){}}
 const pass=new OcclusionCulling143(C,scene,()=>null)
 assert.doesNotThrow(()=>pass.setEnabled(true))
 assert.equal(pass.enabled,false);assert.equal(pass.failed,true)
 assert.equal(scene.context.draw,native);assert.equal(primitives.size,0)
 assert.match(pass.getDiagnostics().reason,/injected install failure/)
 pass.destroy();pass.destroy()
})
