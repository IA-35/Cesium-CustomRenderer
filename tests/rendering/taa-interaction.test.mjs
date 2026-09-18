import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import TaaPass143 from '../../src/antialiasing/TaaPass143.js'
import TaaJitter143 from '../../src/antialiasing/TaaJitter143.js'
const C=createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')

test('silhouette ID raster stays on the display grid while color retains all jitter samples',()=>{
 const frustum=new C.PerspectiveFrustum({fov:1,aspectRatio:1,near:1,far:1000}),id={}
 const scene={camera:{frustum},drawingBufferWidth:100,drawingBufferHeight:100,isDestroyed:()=>false,
  _view:{passState:{framebuffer:null},sceneFramebuffer:{idFramebuffer:id}},context:{uniformState:{updateFrustum(){}}}}
 const jitter=new TaaJitter143(C,scene);jitter.setEnabled(true)
 for(let i=0;i<8;i++){
  jitter.apply();const drawn=frustum.clone();drawn.near=10
  scene._view.passState.framebuffer=id;scene.context.uniformState.updateFrustum(drawn)
  assert.equal(drawn.xOffset,0);assert.equal(drawn.yOffset,0,'ID edges must not move with the Halton sequence')
  scene._view.passState.framebuffer=null;scene.context.uniformState.updateFrustum(drawn)
  assert.ok(Math.abs(-drawn.projectionMatrix[9]*50-jitter.pixel.y)<1e-8,'color raster still samples the pixel')
  jitter.restore()
 }
 jitter.destroy()
})

test('camera navigation and picking see the stable frustum outside the render interval',()=>{
 const frustum=new C.PerspectiveFrustum({fov:1,aspectRatio:1,near:1,far:1000})
 const scene={camera:{frustum},drawingBufferWidth:100,drawingBufferHeight:100,isDestroyed:()=>false,
  context:{uniformState:{updateFrustum(){}}},preUpdate:new C.Event(),preRender:new C.Event(),postRender:new C.Event()}
 const jitter=new TaaJitter143(C,scene);jitter.setEnabled(true)
 const pass=Object.assign(Object.create(TaaPass143.prototype),{scene,jitter,enabled:true,healthy:true,getOptions:()=>({})})
 pass._attachJitter()
 for(let i=0;i<8;i++){
  scene.preUpdate.raiseEvent()
  assert.equal(frustum.xOffset,0,'Cesium camera comparison must not see TAA movement')
  assert.equal(frustum.yOffset,0,'Cesium camera comparison must not see TAA movement')
  scene.preRender.raiseEvent()
  assert.equal(jitter.holding,true)
  scene.postRender.raiseEvent()
  assert.equal(frustum.xOffset,0,'public picking uses stable camera')
  assert.equal(frustum.yOffset,0,'public picking uses stable camera')
 }
 jitter.destroy()
})
