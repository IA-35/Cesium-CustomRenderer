import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import EnvironmentRenderer from '../../src/environment/EnvironmentRenderer.js'
import HdrEnvironmentPass143 from '../../src/environment/HdrEnvironmentPass143.js'
import {resolveEnvironmentState} from '../../src/environment/environmentState.js'

const C=createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')

test('host reprojects material motion, remains continuous across old wind wraps and ignores continuous sun intensity changes',()=>{
  const renderer=Object.create(EnvironmentRenderer.prototype)
  renderer.C=C;renderer.epoch=C.JulianDate.fromIso8601('2026-01-01T00:00:00Z')
  renderer.scene={frameState:{frameNumber:1}};renderer.frame=C.Matrix4.IDENTITY
  renderer.origin=new C.Cartesian3();renderer.getOptions=()=>({sunIntensity:2.2})
  renderer.state=resolveEnvironmentState({},0.5,7999.99)
  renderer.viewer={clock:{currentTime:C.JulianDate.addSeconds(renderer.epoch,7999.99,new C.JulianDate())},camera:{
    positionWC:new C.Cartesian3(),directionWC:new C.Cartesian3(0,0,-1),viewMatrix:C.Matrix4.IDENTITY,
    frustum:new C.PerspectiveFrustum({near:1,far:50000,aspectRatio:16/9,fov:1})}}
  const first=renderer.temporalFrame()
  renderer.viewer.clock.currentTime=C.JulianDate.addSeconds(renderer.epoch,8000,new C.JulianDate())
  renderer.state.sunIntensity=1.1
  const second=renderer.temporalFrame()
  const displacement=C.Cartesian3.subtract(second.windOffsetWC,first.windOffsetWC,new C.Cartesian3())
  assert.ok(Math.abs(displacement.x+0.08)<1e-8)
  assert.ok(Math.abs(displacement.y+0.02)<1e-8)
  assert.ok(Math.abs(displacement.z-Math.sqrt(68)*0.0025)<1e-8)
  assert.equal(first.resetKey,second.resetKey,'continuous sun motion must not reset cloud history each frame')
  renderer.state.skyLightIntensity=0
  assert.notEqual(renderer.temporalFrame().resetKey,second.resetKey,'changed sky lighting rejects old cloud radiance')
  renderer.state.skyLightIntensity=3.2
  renderer.atmosphereLut={keys:{medium:'new-medium'}}
  assert.notEqual(renderer.temporalFrame().resetKey,second.resetKey,'only a committed medium version resets cloud history')
  renderer.state.environmentAnimation=false
  const paused=renderer.temporalFrame()
  assert.deepEqual(paused.windOffsetWC,C.Cartesian3.ZERO)
  assert.notEqual(paused.resetKey,second.resetKey,'a changed density animation mode must reject old history')
})

test('HDR owner releases independent cloud collection and history exactly once',()=>{
  const pass=Object.create(HdrEnvironmentPass143.prototype),released=[]
  const resource=name=>({isDestroyed:()=>released.includes(name),destroy:()=>{assert.ok(!released.includes(name));released.push(name)}})
  Object.assign(pass,{cloudTemporal:resource('history'),cloudCollection:resource('clouds'),
    _cloudComposite:resource('owned-by-cloud-collection'),collection:resource('atmosphere'),
    releaseFrame(){released.push('frame')},_cloudColorStage:{},_cloudDepthStage:{},cloudOutput:{}})
  pass._release()
  assert.deepEqual(released,['history','clouds','atmosphere','frame'])
  assert.equal(pass.cloudOutput,undefined)
  assert.equal(pass._cloudColorStage,undefined)
  assert.equal(pass._cloudComposite,undefined)
  pass._release()
  assert.deepEqual(released,['history','clouds','atmosphere','frame','frame'])
})
