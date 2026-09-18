import {startStage1Scene} from './stage1-scene.js'
import {waitFrames} from './deferred-lighting-fixture.js'

export async function startCascadeFixture(f){
  await startStage1Scene(f)
  const C=Cesium,s=f.viewer.scene,p=f.pipeline
  f.viewer.clock.shouldAnimate=false;f.viewer.clock.currentTime=C.JulianDate.fromIso8601('2026-06-21T04:00:00Z')
  s.skyBox.show=false;s.skyAtmosphere.show=false;s.sun.show=false;s.moon.show=false
  p.setScreenSpaceAO({enabled:false});p.setHdrBloom({enabled:false})
  p.setOptions({environment:false,clouds:false,shadows:true,shadowMode:'custom',shadowCascades:3,shadowSize:2048,shadowStatic:true,antialiasing:'off'})
  const frame=C.Transforms.eastNorthUpToFixedFrame(f.origin)
  f.toLight=C.Cartesian3.normalize(C.Matrix4.multiplyByPointAsVector(frame,new C.Cartesian3(-.4,-.3,1),new C.Cartesian3()),new C.Cartesian3())
  s.light=new C.DirectionalLight({direction:C.Cartesian3.negate(f.toLight,new C.Cartesian3()),intensity:2})
  await waitFrames(s,35,f.errors)
  for(const model of f.models)model.imageBasedLighting.imageBasedLightingFactor=new C.Cartesian2(0,0)
  await waitFrames(s,15,f.errors)
  return f
}

export function framePixels(C,scene){
  const ctx=scene.context,gl=ctx._gl,read=gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),draw=gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),cached=ctx._currentFramebuffer
  try{return ctx.readPixels({width:scene.drawingBufferWidth,height:scene.drawingBufferHeight})}
  finally{gl.bindFramebuffer(gl.READ_FRAMEBUFFER,read);gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,draw);ctx._currentFramebuffer=cached}
}

export async function stationaryFrames(C,scene,n){
  let first,changedFrames=0,maxDelta=0
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{off();reject(new Error('Stationary sequence timed out'))},45000)
    const off=scene.postRender.addEventListener(()=>{
      const data=framePixels(C,scene)
      if(!first)first=data
      else{let changed=false;for(let i=0;i<data.length;i++){const d=Math.abs(data[i]-first[i]);maxDelta=Math.max(maxDelta,d);changed||=d!==0}if(changed)changedFrames++}
      if(--n===0){off();clearTimeout(timer);resolve({changedFrames,maxDelta})}
    })
  })
}

export async function cascadeContentChecks(f){
  const C=Cesium,s=f.viewer.scene,p=f.pipeline,wait=n=>waitFrames(s,n,f.errors)
  const {cubeUrl}=await import('./stage1-scene.js'),{planeGlb}=await import('./deferred-lighting-fixture.js')
  const {readHdr}=await import('./deferred-transparency-fixture.js')
  const frame=C.Transforms.eastNorthUpToFixedFrame(f.origin),world=xyz=>C.Matrix4.multiplyByPoint(frame,new C.Cartesian3(...xyz),new C.Cartesian3())
  const sample=xyz=>{const q=C.SceneTransforms.worldToWindowCoordinates(s,world(xyz));return readHdr(C,s,Math.round(q.x),Math.round(q.y))}
  const matrix=(xyz,scale)=>C.Matrix4.multiplyByScale(C.Matrix4.multiply(frame,C.Matrix4.fromTranslation(new C.Cartesian3(...xyz)),new C.Matrix4()),new C.Cartesian3(...scale),new C.Matrix4())
  const before=sample([60,-30,.05])
  const caster=await C.Model.fromGltfAsync({url:cubeUrl(C),modelMatrix:matrix([-60,-120,300],[8,8,8])});s.primitives.add(caster);await wait(20)
  const after=sample([60,-30,.05]),outside=s.frameState.cullingVolume.computeVisibility(caster.boundingSphere)===C.Intersect.OUTSIDE
  const offscreen={outside,casters:p.customShadow.stats.selectedOffscreen,before,after}
  caster.show=false;await wait(8);offscreen.restored=sample([60,-30,.05]);s.primitives.remove(caster)
  const leaf=await C.Model.fromGltfAsync({url:planeGlb(C,{baseColor:[.1,.5,.1,1],metallic:0,roughness:.8,mask:true,backFacing:true}),modelMatrix:matrix([-40,0,10],[8,8,1]),upAxis:C.Axis.Z,forwardAxis:C.Axis.X})
  leaf.show=false;s.primitives.add(leaf);await wait(8)
  const lit={solid:sample([-36,3,.05]),hole:sample([-42,3,.05])};leaf.show=true;await wait(18)
  const mask={lit,shadow:{solid:sample([-36,3,.05]),hole:sample([-42,3,.05])}}
  s.primitives.remove(leaf);await wait(8)
  return {offscreen,mask}
}

export async function cascadeMotionChecks(f){
  const C=Cesium,s=f.viewer.scene,p=f.pipeline,wait=n=>waitFrames(s,n,f.errors),frame=C.Transforms.eastNorthUpToFixedFrame(f.origin)
  const points=[]
  for(let x=-80;x<=80;x+=16)for(let y=-80;y<=80;y+=16){
    // Keep the smooth reference region away from the independently known box
    // silhouettes and all their swept sun-shadow footprints.
    if(x>-24&&x<48&&y>-24&&y<48)continue
    points.push(C.Matrix4.multiplyByPoint(frame,new C.Cartesian3(x,y,.05),new C.Cartesian3()))
  }
  let previous=[],crossings=0,maxStep=0,samples=0,worst=null
  const sequence=[]
  const depthFramebuffer=new C.Framebuffer({context:s.context,colorTextures:[p.deferredLighting.materials.getTextures().eyeDepth],destroyAttachments:false})
  const depths=()=>{
    const ctx=s.context,gl=ctx._gl,read=gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),draw=gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),cached=ctx._currentFramebuffer
    try{return ctx.readPixels({framebuffer:depthFramebuffer,width:s.drawingBufferWidth,height:s.drawingBufferHeight})}
    finally{gl.bindFramebuffer(gl.READ_FRAMEBUFFER,read);gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,draw);ctx._currentFramebuffer=cached}
  }
  try{
  for(let i=0;i<60;i++){
    s.camera.lookAt(f.origin,new C.HeadingPitchRange(i*.01,-.6,160+i*2));s.camera.lookAtTransform(C.Matrix4.IDENTITY)
    const sun=C.Cartesian3.normalize(C.Matrix4.multiplyByPointAsVector(frame,new C.Cartesian3(-.4+i*.00025,-.3,1),new C.Cartesian3()),new C.Cartesian3())
    C.Cartesian3.negate(sun,s.light.direction);await wait(1)
    const pixels=framePixels(C,s),depthPixels=depths(),current=[],splits=p.customShadow.regions?.splits
    if(!p.customShadow.ready)throw new Error('Cascade became unavailable during motion: '+p.customShadow.stats.error)
    for(let j=0;j<points.length;j++){
      const point=points[j],q=C.SceneTransforms.worldToWindowCoordinates(s,point)
      if(!q||q.x<4||q.y<4||q.x>=s.drawingBufferWidth-4||q.y>=s.drawingBufferHeight-4)continue
      const index=((s.drawingBufferHeight-1-Math.round(q.y))*s.drawingBufferWidth+Math.round(q.x))*4
      const value=(pixels[index]+pixels[index+1]+pixels[index+2])/765
      const depth=-C.Matrix4.multiplyByPoint(s.camera.viewMatrix,point,new C.Cartesian3()).z,level=depth<splits[1]?0:depth<splits[2]?1:2
      // A world point outside the caster footprint can still be hidden by a
      // foreground roof/wall. Only compare pixels proven to show this ground.
      const footprint=2*depth*Math.tan(s.camera.frustum.fovy/2)/s.drawingBufferHeight
      if(Math.abs(depthPixels[index]-depth)>Math.max(.2,footprint*3))continue
      let smooth=true
      for(let oy=-2;oy<=2;oy++)for(let ox=-2;ox<=2;ox++){
        const neighbor=index+(oy*s.drawingBufferWidth+ox)*4
        if(Math.abs(depthPixels[neighbor]-depth)>Math.max(.3,footprint*6))smooth=false
      }
      if(!smooth)continue
      if(previous[j]){
        samples++;const step=Math.abs(value-previous[j].value)
        if(step>maxStep){maxStep=step;worst={frame:i,point:j,world:point,screen:q,previous:previous[j],current:{value,level,depth,actualDepth:depthPixels[index]},splits:splits.slice(),cascades:structuredClone(p.customShadow.stats.cascades)}}
        if(level!==previous[j].level)crossings++
      }
      current[j]={value,level}
    }
    sequence.push({index:i,png:s.canvas.toDataURL('image/png'),splits:splits.slice(),samples:current.filter(Boolean)})
    previous=current
  }
  }finally{depthFramebuffer.destroy()}
  return {frames:60,samples,crossings,maxStep,worst,sequence}
}

export async function cascadeLocationChecks(f){
  const C=Cesium,s=f.viewer.scene,p=f.pipeline,wait=n=>waitFrames(s,n,f.errors)
  const original=C.Transforms.eastNorthUpToFixedFrame(f.origin),inverse=C.Matrix4.inverseTransformation(original,new C.Matrix4()),matrices=f.models.map(model=>C.Matrix4.clone(model.modelMatrix))
  const results=[]
  for(const [longitude,latitude,height] of [[0,0,0],[120,-45,2000],[-60,78,1200]]){
    const origin=C.Cartesian3.fromDegrees(longitude,latitude,height),frame=C.Transforms.eastNorthUpToFixedFrame(origin),change=C.Matrix4.multiply(frame,inverse,new C.Matrix4())
    f.models.forEach((model,i)=>{model.modelMatrix=C.Matrix4.multiply(change,matrices[i],new C.Matrix4())})
    s.globe.show=false
    const light=new C.DirectionalLight({direction:C.Cartesian3.negate(C.Cartesian3.normalize(C.Matrix4.multiplyByPointAsVector(frame,new C.Cartesian3(-.4,-.3,1),new C.Cartesian3()),new C.Cartesian3()),new C.Cartesian3()),intensity:2})
    s.light=light;s.camera.lookAt(origin,new C.HeadingPitchRange(0,-.6,160));s.camera.lookAtTransform(C.Matrix4.IDENTITY);await wait(18)
    const near={ready:p.customShadow.ready,centerHeight:C.Cartographic.fromCartesian(p.customShadow.stats.coverage.center).height,stats:structuredClone(p.customShadow.stats)}
    const center=C.Cartesian3.clone(p.customShadow.stats.coverage.center);p.customShadow.setOrigin(f.origin);await wait(2)
    const originIndependent=C.Cartesian3.distance(center,p.customShadow.stats.coverage.center)<1e-6
    s.camera.setView({destination:C.Cartesian3.fromDegrees(longitude,latitude,height+10000),orientation:{heading:0,pitch:-Math.PI/2,roll:0}});await wait(8)
    const beyondDistance=!p.customShadow.ready
    p.setOptions({shadowDistance:20000});s.light=light;await wait(18)
    const high={ready:p.customShadow.ready,stats:structuredClone(p.customShadow.stats)}
    s.camera.setView({destination:C.Cartesian3.fromDegrees(longitude,latitude,height+2000000),orientation:{heading:0,pitch:-Math.PI/2,roll:0}});await wait(8)
    const orbit=!p.customShadow.ready
    p.setOptions({shadowDistance:4000});s.light=light
    results.push({longitude,latitude,height,near,originIndependent,beyondDistance,high,orbit})
  }
  f.models.forEach((model,i)=>{model.modelMatrix=matrices[i]});s.globe.show=true
  s.camera.lookAt(f.origin,new C.HeadingPitchRange(0,-.6,160));s.camera.lookAtTransform(C.Matrix4.IDENTITY)
  s.light=new C.DirectionalLight({direction:C.Cartesian3.negate(f.toLight,new C.Cartesian3()),intensity:2});await wait(18)
  return results
}

export async function cascadeGpuComparison(f){
  const {default:Profiler}=await import('../../src/diagnostics/RenderProfiler143.js')
  const C=Cesium,s=f.viewer.scene,p=f.pipeline,wait=n=>waitFrames(s,n,f.errors),light=s.light,results=[]
  for(const count of [1,3]){
    p.setOptions({shadowCascades:count,shadowSize:count===1?4096:2048,shadowStatic:false});s.light=light;await wait(25)
    const profiler=new Profiler(C,p);profiler.labels=['frame','shadow'];await wait(80)
    const report=profiler.getReport();profiler.destroy()
    const quantile=(a,q)=>a.sort((a,b)=>a-b)[Math.floor((a.length-1)*q)]
    const timing={}
    for(const label of ['frame','shadow']){const values=report.gpu.filter(x=>x.label===label).map(x=>x.milliseconds);timing[label]={samples:values.length,p50:quantile(values,.5),p95:quantile(values,.95)}}
    results.push({count,gpuSupported:report.gpuSupported,timing,bytes:p.customShadow.stats.bytes,cascades:structuredClone(p.customShadow.stats.cascades)})
  }
  p.setOptions({shadowStatic:true});s.light=light;await wait(8)
  return results
}

export async function cascadeContactChecks(f){
  const C=Cesium,s=f.viewer.scene,p=f.pipeline,wait=n=>waitFrames(s,n,f.errors),light=s.light
  const {readHdr,readTexture}=await import('./deferred-transparency-fixture.js')
  const frame=C.Transforms.eastNorthUpToFixedFrame(f.origin),up=C.Matrix4.multiplyByPointAsVector(frame,C.Cartesian3.UNIT_Z,new C.Cartesian3())
  const normal=C.Cartesian3.normalize(C.Matrix4.multiplyByPointAsVector(s.camera.viewMatrix,up,new C.Cartesian3()),new C.Cartesian3())
  const points=Array.from({length:20},(_,i)=>{
    const distance=(i+1)*.1,world=C.Matrix4.multiplyByPoint(frame,new C.Cartesian3(9+distance,-8,.01),new C.Cartesian3())
    const q=C.SceneTransforms.worldToWindowCoordinates(s,world);return {distance,x:Math.round(q.x),y:Math.round(q.y)}
  })
  const results=[]
  for(const count of [1,3]){
    p.setOptions({shadowCascades:count,shadowSize:count===1?4096:2048});s.light=light;p.setLighting({shadow:false});await wait(12)
    const materials=p.deferredLighting.materials.getTextures(),visible=[]
    for(const point of points){const n=readTexture(C,s,materials.normalRoughMetal,point.x,point.y);if(C.Cartesian3.dot(normal,new C.Cartesian3(...n))<.999)continue;visible.push({...point,lit:readHdr(C,s,point.x,point.y)})}
    p.setLighting({shadow:true});await wait(12)
    const samples=visible.map(point=>{const color=readHdr(C,s,point.x,point.y);return {distance:point.distance,ratio:color.reduce((a,b)=>a+b,0)/point.lit.reduce((a,b)=>a+b,0)}})
    results.push({count,samples,firstShadow:samples.find(x=>x.ratio<.9)?.distance??null})
  }
  s.logarithmicDepthFarToNearRatio=1.05;s.farToNearRatio=1.05;await wait(12)
  const multi={frustums:s._view.frustumCommandsList.length,shadow:p.customShadow.ready,lighting:p.getLightingDiagnostics().valid,error:p.customShadow.stats.error}
  s.logarithmicDepthFarToNearRatio=1e9;s.farToNearRatio=1000;await wait(5)
  return {results,multi}
}

export async function cascadeReceiverChecks(f){
  const C=Cesium,s=f.viewer.scene,p=f.pipeline,wait=n=>waitFrames(s,n,f.errors)
  const {planeGlb,readHdr}=await import('./deferred-transparency-fixture.js')
  const frame=C.Transforms.eastNorthUpToFixedFrame(f.origin),matrix=C.Matrix4.multiply(frame,C.Matrix4.fromTranslation(new C.Cartesian3(0,0,1)),new C.Matrix4())
  C.Matrix4.multiplyByScale(matrix,new C.Cartesian3(80,80,1),matrix)
  const glass=await C.Model.fromGltfAsync({url:planeGlb(C,{baseColor:[.3,.5,.7,.6],metallic:0,roughness:.5,blend:true}),modelMatrix:matrix,upAxis:C.Axis.Z,forwardAxis:C.Axis.X})
  s.primitives.add(glass);glass.imageBasedLighting.imageBasedLightingFactor=new C.Cartesian2(0,0);await wait(20)
  const world=C.Matrix4.multiplyByPoint(frame,new C.Cartesian3(12,0,1),new C.Cartesian3()),q=C.SceneTransforms.worldToWindowCoordinates(s,world)
  const read=()=>readHdr(C,s,Math.round(q.x),Math.round(q.y))
  const shadowed=read(),forward=p.getLightingDiagnostics().transparentForward
  const bindings=[...p.transparentForward.commands.values()].map(r=>r.mergedUniforms.campus_shadowCascadeCount?.())
  p.setLighting({shadow:false});await wait(8);const lit=read();p.setLighting({shadow:true});await wait(8);const restored=read()
  s.primitives.remove(glass)
  const old=p.customShadow.levels.map(l=>l.target.depth),light=s.light
  p.setOptions({shadows:false});s.light=light;await wait(3)
  const released=old.every(t=>t.isDestroyed())&&p.customShadow.stats.bytes===0
  p.setOptions({shadows:true});s.light=light;await wait(10)
  return {shadowed,lit,restored,forward,bindings,released}
}
