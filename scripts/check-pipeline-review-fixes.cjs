// Read-only runtime review probes. No production options or files are persisted.
const {chromium}=require(process.env.CESIUM_PLAYWRIGHT||'playwright'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const root=path.resolve(__dirname,'../docs/verification/pipeline-review-fixed'),report={};fs.mkdirSync(root,{recursive:true})
;(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true});try{
 async function run(name,fn){ if(process.argv[2]&&process.argv[2]!==name)return
  const page=await browser.newPage({viewport:{width:640,height:360}}),errors=[];page.on('pageerror',e=>errors.push(e.message))
  try{await page.goto('http://127.0.0.1:'+(process.env.CCR_TEST_PORT||8894)+'/tests/rendering/stage1-fixture.html?mode='+(process.env.CCR_TEST_MODE||'esm'));await page.waitForFunction(()=>window.fixture);report[name]={result:await page.evaluate(fn),errors}}
  catch(e){report[name]={error:e.message,errors};process.exitCode=1}
  finally{await page.close();fs.writeFileSync(root+'/probes-'+(process.env.CCR_TEST_MODE||'esm')+'.json',JSON.stringify(report,null,2));console.log(name,JSON.stringify(report[name]))}
 }
 await run('toneDepthFallback',async()=>{
  const f=fixture,C=Cesium,s=f.viewer.scene,{startStage1Scene}=await import('/tests/rendering/stage1-scene.js'),{waitFrames}=await import('/tests/rendering/stage1-baseline-fixture.js')
  await startStage1Scene(f);await waitFrames(s,50,f.errors);const p=f.pipeline
  p.setOptions({screenSpaceAoEnabled:false,hdrBloomEnabled:false,toneMappingCurve:'unrealFilmicApprox',depthOfFieldEnabled:true});await waitFrames(s,20,f.errors)
  let native=0,custom=0;const n=s.postProcessStages._tonemapping,t=p.lensEffects.stages.tone,a=n.execute,b=t.execute
  n.execute=function(...args){native++;return a.apply(this,args)};t.execute=function(...args){custom++;return b.apply(this,args)}
  await waitFrames(s,10,f.errors);const before={native,custom,depth:!!p.getActiveMaterialChannels().getTextures()?.eyeDepth}
  s.morphTo2D(0);await waitFrames(s,15,f.errors);native=custom=0;await waitFrames(s,10,f.errors)
  return {before,after:{mode:s.mode,hdr:s.highDynamicRange,native,custom,nativeEnabled:n.enabled,reason:p.lensEffects.scopeReason(),depth:!!p.getActiveMaterialChannels().getTextures()?.eyeDepth},renderErrors:f.errors}
 })
 await run('staleMedium',async()=>{
  const f=fixture,C=Cesium,s=f.viewer.scene,{startStage1Scene}=await import('/tests/rendering/stage1-scene.js'),{waitFrames}=await import('/tests/rendering/stage1-baseline-fixture.js')
  await startStage1Scene(f);const p=f.pipeline;p.setOptions({environment:true,lightShaftEnabled:true,screenSpaceAoEnabled:false,hdrBloomEnabled:false});await waitFrames(s,60,f.errors)
  const e=p.environmentRenderer,initial=e.getMediumOcclusionDiagnostics(),texture=initial.texture,before={frame:s.frameState.frameNumber,mediumValid:initial.valid,hdrValid:e.hdr.getDiagnostics().valid}
  s.camera.frustum=new C.OrthographicFrustum({width:300,aspectRatio:640/360,near:.1,far:1000000});await waitFrames(s,10,f.errors)
  const medium=e.getMediumOcclusionDiagnostics();return {before,after:{frame:s.frameState.frameNumber,mediumValid:medium.valid,sameTexture:texture===medium.texture,hdr:e.hdr.getDiagnostics(),lensValid:p.lensEffects.getDiagnostics().valid},renderErrors:f.errors}
 })
 await run('deferredDiagnostics',async()=>{
  const f=fixture,s=f.viewer.scene,{startStage1Scene}=await import('/tests/rendering/stage1-scene.js'),{waitFrames}=await import('/tests/rendering/stage1-baseline-fixture.js')
  await startStage1Scene(f);f.pipeline.setOptions({lightingMode:'deferred',screenSpaceAoEnabled:false,hdrBloomEnabled:false});await waitFrames(s,60,f.errors)
  return {actual:f.pipeline.deferredLighting.getDiagnostics(),policy:f.pipeline.getCapabilityDiagnostics().defaults.deferred,renderErrors:f.errors}
 })
 await run('taaBillboardScope',async()=>{
  const f=fixture,C=Cesium,v=f.viewer,s=v.scene,{waitFrames}=await import('/tests/rendering/stage1-baseline-fixture.js')
  v.clock.currentTime=C.JulianDate.fromIso8601('2026-06-21T04:00:00Z');v.clock.shouldAnimate=true
  const p=f.CCR.createVisualPipeline({Cesium:C,viewer:v,options:{antialiasing:'taa',environment:false,shadows:false,fog:false,hdrBloomEnabled:true,hdrBloomThreshold:.1,hdrBloomStrength:2}})
  s.globe.show=false;s.skyBox.show=false;s.skyAtmosphere.show=false;s.backgroundColor=C.Color.BLACK
  const origin=C.Cartesian3.fromDegrees(123.42,41.77,100),frame=C.Transforms.eastNorthUpToFixedFrame(origin)
  v.camera.lookAt(origin,new C.HeadingPitchRange(0,-.6,100));v.camera.lookAtTransform(C.Matrix4.IDENTITY)
  const canvas=document.createElement('canvas');canvas.width=canvas.height=16;const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,16,16)
  const particle=s.primitives.add(new C.ParticleSystem({image:canvas,imageSize:new C.Cartesian2(12,12),emitter:new C.CircleEmitter(.1),emissionRate:10,particleLife:10,speed:0,modelMatrix:frame}))
  await waitFrames(s,120,f.errors);v.clock.shouldAnimate=false;await waitFrames(s,30,f.errors)
  const pixels=()=>s.context.readPixels({width:s.drawingBufferWidth,height:s.drawingBufferHeight}),sum=a=>a.reduce((n,x,i)=>n+(i%4===3?0:x),0)
  const overlay=p.taa.overlay,commands=s.frameState.commandList.filter(c=>c.owner===particle._billboardCollection)
  const before={particles:particle._billboardCollection.length,commands:commands.length,classifiedAsUi:commands.every(c=>overlay.isOverlay(c)),overlay:overlay.getDiagnostics(),lumaSum:sum(pixels())}
  const previous=overlay.isOverlay;overlay.isOverlay=function(c){return c.owner===particle._billboardCollection?false:previous.call(this,c)};p.resetTaaHistory();await waitFrames(s,120,f.errors)
  const after={lumaSum:sum(pixels()),overlay:overlay.getDiagnostics()}
  return {before,particleAllowedIntoHdrChain:after,renderErrors:f.errors}
 })
 await run('globeLessViewer',async()=>{
  const {viewer,CCR}=fixture;viewer.destroy();const host=document.createElement('div');document.body.append(host)
  const v=new Cesium.Viewer(host,{globe:false,baseLayer:false,baseLayerPicker:false,animation:false,timeline:false});let error=null
  let pipeline;try{pipeline=CCR.createVisualPipeline({Cesium,viewer:v});await new Promise(resolve=>{let count=12;const off=v.scene.postRender.addEventListener(()=>{if(--count===0){off();resolve()}})});}catch(e){error=e.message}pipeline?.destroy();v.destroy();return {error}
 })
for(const [name,value]of Object.entries(report)){
 assert.ok(!value.error,name+': '+value.error);assert.deepEqual(value.errors,[]);assert.deepEqual(value.result.renderErrors||[],[])
 const r=value.result
 if(name==='toneDepthFallback'){assert.equal(r.before.custom,10);assert.equal(r.after.custom,10);assert.equal(r.after.native,0);assert.equal(r.after.hdr,true)}
 if(name==='staleMedium'){assert.equal(r.before.mediumValid,true);assert.equal(r.after.mediumValid,false)}
 if(name==='deferredDiagnostics'){assert.equal(r.actual.activeMode,'deferred');assert.equal(r.policy.effectiveMode,'deferred');assert.equal(r.policy.active,true)}
 if(name==='taaBillboardScope'){assert.ok(r.before.particles>0);assert.equal(r.before.classifiedAsUi,false);assert.ok(Math.abs(r.before.lumaSum-r.particleAllowedIntoHdrChain.lumaSum)<r.before.lumaSum*.02)}
 if(name==='globeLessViewer')assert.equal(r.error,null)
}
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1})
