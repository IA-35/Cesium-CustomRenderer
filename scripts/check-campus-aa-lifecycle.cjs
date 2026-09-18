const {chromium}=require(process.env.CESIUM_PLAYWRIGHT||'playwright'),fs=require('node:fs'),assert=require('node:assert/strict')
;(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true})
 try{
  const page=await browser.newPage({viewport:{width:1000,height:700}}),errors=[]
  page.on('pageerror',e=>errors.push(e.message))
  await page.goto('http://127.0.0.1:8877/examples/campus.html?imagery=none')
  await page.waitForFunction(()=>window.campus?.tiles.length===window.campus?.expectedTiles&&campus.tiles.every(t=>t.tilesLoaded),null,{timeout:120000})
  const result=await page.evaluate(async()=>{
   const {viewer,pipeline}=campus,frames=n=>new Promise(resolve=>{const off=viewer.scene.postRender.addEventListener(()=>{if(--n===0){off();resolve()}})})
   pipeline.setOptions({environmentAnimation:false})
   const checks={},set=async(mode,quality)=>{pipeline.setAntiAliasing({mode,quality});if(mode==='smaa')await pipeline.smaa.readyPromise;await frames(8)}
   await set('fxaa','balanced');const first=pipeline.fxaa.collection
   await set('fxaa','smooth');checks.qualityReleasesOld=first.isDestroyed()
   await set('smaa','balanced');checks.smaaAfterFxaa=pipeline.smaa.getDiagnostics().effective==='smaa'&&!pipeline.fxaa.collection
   const position=Cesium.Cartesian3.clone(viewer.camera.positionWC)
   for(let i=0;i<12;i++){viewer.camera.moveRight(.25);await frames(2)}
   checks.movingSmaa=pipeline.smaa.getDiagnostics().effective==='smaa'
   viewer.camera.position=position
   await set('taa');await set('fxaa','sharp');checks.fxaaAfterTaa=pipeline.fxaa.getDiagnostics().effective==='fxaa'
   pipeline.setEnabled(false);await frames(4);checks.disabled=!pipeline.fxaa.collection&&!pipeline.smaa.collection
   pipeline.setEnabled(true);await frames(8);checks.restored=pipeline.fxaa.getDiagnostics().effective==='fxaa'
   pipeline.setAntiAliasing({mode:'msaa',msaaSamples:4});await frames(8)
   const hardware=pipeline.getRenderDiagnostics().antiAliasing
   checks.msaaAllocated=hardware.allocatedAttachments.scene.colorRenderbufferSamples===hardware.msaa.selected
   await set('fxaa','balanced')
   return {checks,hardware,errors:campus.errors}
  })
  await page.setViewportSize({width:801,height:603})
  await page.waitForFunction(()=>campus.pipeline.fxaa.getDiagnostics().outputDimensions?.width===801)
  result.resize=await page.evaluate(()=>campus.pipeline.fxaa.getDiagnostics())
  assert.ok(Object.values(result.checks).every(Boolean),JSON.stringify(result));assert.equal(errors.length,0);assert.equal(result.errors.length,0)
  fs.writeFileSync('docs/verification/campus-aa-lifecycle.json',JSON.stringify(result,null,2));console.log(JSON.stringify({checks:result.checks,resize:result.resize.outputDimensions,errors}))
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1})
