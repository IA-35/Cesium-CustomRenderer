const {chromium}=require(process.env.CESIUM_PLAYWRIGHT),fs=require('node:fs'),assert=require('node:assert/strict'),crypto=require('node:crypto')
const manifest=JSON.parse(fs.readFileSync('build/0.1.0/manifest.json'));for(const [file,hash]of Object.entries(manifest.sourceHashes))assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),hash,'Stale UMD: '+file)
;(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true}),report={};try{
for(const mode of ['esm','umd']){const page=await browser.newPage({viewport:{width:640,height:420}}),errors=[];page.on('pageerror',e=>errors.push(e.message))
await page.goto('http://127.0.0.1:8877/tests/rendering/stage1-fixture.html'+(mode==='umd'?'?mode=umd':''));await page.waitForFunction(()=>window.fixture)
report[mode]=await page.evaluate(async()=>{
 const f=fixture,C=Cesium,s=f.viewer.scene,{waitFrames}=await import('/tests/rendering/ssr-surfaces-fixture.js');const wait=n=>waitFrames(s,n,f.errors)
 const p=f.CCR.createVisualPipeline({Cesium:C,viewer:f.viewer,options:{environment:true,environmentAnimation:false,clouds:false,shadows:false,antialiasing:'off'}});await wait(20)
 p.setLensEffects({depthOfFieldEnabled:true});await wait(10)
 const dofViaApi={hasDepth:!!p.lensEffects._depthTexture(),valid:p.getLensEffectsDiagnostics().valid}
 p.setOptions({depthOfFieldEnabled:true});await wait(10)
 const dofViaOptions={hasDepth:!!p.lensEffects._depthTexture(),valid:p.getLensEffectsDiagnostics().valid}
 p.setLensEffects({depthOfFieldEnabled:false,toneMappingCurve:'unrealFilmicApprox'});await wait(15)
 let nativeCalls=0,customCalls=0;const native=s.postProcessStages._tonemapping,custom=p.lensEffects.stages.tone,a=native.execute,b=custom.execute
 native.execute=function(...x){nativeCalls++;return a.apply(this,x)};custom.execute=function(...x){customCalls++;return b.apply(this,x)};await wait(10)
 const tone={nativeEnabled:native.enabled,nativeCalls,customCalls};native.execute=a;custom.execute=b
 const collection=s.postProcessStages,retained=collection.update
 let foreignCalls=0;const foreign=function(...args){foreignCalls++;return retained.apply(this,args)};collection.update=foreign
 p.setLensEffects({toneMappingCurve:'aces',sunFlareEnabled:true});await wait(10)
 const wrapper={foreignPreserved:collection.update===foreign,foreignCalls}
 const direction=C.Cartesian3.normalize(s.context.uniformState.sunPositionWC,new C.Cartesian3()),right=C.Cartesian3.normalize(C.Cartesian3.cross(direction,C.Cartesian3.UNIT_Z,new C.Cartesian3()),new C.Cartesian3()),up=C.Cartesian3.cross(right,direction,new C.Cartesian3())
 s.camera.setView({orientation:{direction,up}});s.camera.lookUp(.2);await wait(5)
 const view=C.Matrix4.multiplyByPointAsVector(s.camera.viewMatrix,direction,new C.Cartesian3()),clip=C.Matrix4.multiplyByVector(s.camera.frustum.projectionMatrix,new C.Cartesian4(view.x,view.y,view.z,0),new C.Cartesian4())
 const sun={actual:p.lensEffects._sunScreen(),textureUv:{x:clip.x/clip.w*.5+.5,y:clip.y/clip.w*.5+.5}}
 return {dofViaApi,dofViaOptions,tone,wrapper,sun,renderErrors:f.errors}
});report[mode].pageErrors=errors;await page.close()}
for(const r of Object.values(report)){assert.deepEqual(r.renderErrors,[]);assert.deepEqual(r.pageErrors,[]);assert.equal(r.dofViaApi.hasDepth,true);assert.equal(r.dofViaOptions.hasDepth,true);assert.equal(r.tone.nativeCalls,0);assert.equal(r.tone.customCalls,10);assert.equal(r.wrapper.foreignPreserved,true);assert.ok(r.wrapper.foreignCalls>=10);assert.ok(Math.abs(r.sun.actual.y-r.sun.textureUv.y)<1e-10)}
fs.writeFileSync('docs/verification/review-remediation.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1})
