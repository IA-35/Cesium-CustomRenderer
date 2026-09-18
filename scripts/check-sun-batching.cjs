const {chromium}=require(process.env.CESIUM_PLAYWRIGHT||'playwright'),fs=require('node:fs'),assert=require('node:assert/strict')
;(async()=>{const b=await chromium.launch({channel:'chrome',headless:true});try{
 const page=await b.newPage({viewport:{width:1280,height:720}}),errors=[];page.on('pageerror',e=>errors.push(e.message))
 await page.goto('http://127.0.0.1:'+(process.env.CCR_TEST_PORT||8877)+'/tests/rendering/stage1-fixture.html');await page.waitForFunction(()=>window.fixture)
 const report=await page.evaluate(async()=>{
  const f=fixture,C=Cesium,s=f.viewer.scene,{loadPerformanceScene,applyPerformanceTrack}=await import('/tests/rendering/performance-scene.js'),{waitFrames}=await import('/tests/rendering/ssr-surfaces-fixture.js'),{default:Profiler}=await import('/src/diagnostics/RenderProfiler143.js')
  const wait=n=>waitFrames(s,n,f.errors);await loadPerformanceScene(f)
  ;(await import('/tests/rendering/stage1-baseline-fixture.js')).freezeTime(f.viewer)
  const p=f.CCR.createVisualPipeline({Cesium:C,viewer:f.viewer,options:{lightingMode:'deferred',environment:false,environmentAnimation:false,clouds:false,shadows:false,antialiasing:'off',screenSpaceReflectionEnabled:true}})
  await wait(70)
  // Freeze asynchronous native probe production before comparing binding alone.
  for(const model of f.models)if(model.environmentMapManager)model.environmentMapManager.shouldUpdate=false
  s.globe.show=false;s.skyAtmosphere.show=false;s.skyBox.show=false;s.sun.show=false;s.moon.show=false
  await wait(15);const lighting=p.deferredLighting,original=lighting.sunUniforms.withPrograms,runs=[]
  const ctx=s.context,gl=ctx._gl
  const readLighting=()=>{
   const framebuffer=lighting.programs.values().next().value.command.framebuffer
   const read=gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),draw=gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),cached=ctx._currentFramebuffer
   try{return ctx.readPixels({framebuffer,width:s.drawingBufferWidth,height:s.drawingBufferHeight})}
   finally{gl.bindFramebuffer(gl.READ_FRAMEBUFFER,read);gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,draw);ctx._currentFramebuffer=cached}
  }
  // Compare exact HDR outputs with identical same-frame material/IBL inputs.
  // Separate frames have native input drift (also measured by false/false below).
  let sameFrameDelta=0,parityFrames=0
  lighting.sunUniforms.withPrograms=(programs,draw)=>{
   draw();const before=readLighting();original(programs,draw);const after=readLighting()
   for(let i=0;i<before.length;i++)sameFrameDelta=Math.max(sameFrameDelta,Math.abs(after[i]-before[i]))
   parityFrames++
  }
  await wait(3);lighting.sunUniforms.withPrograms=original
  const median=a=>[...a].sort((x,y)=>x-y)[Math.floor(a.length/2)]
  for(const [track,t]of [['orbit',0],['orbit',2],['pitch',1]]) {
   let reference
   applyPerformanceTrack(f,track,t);await wait(30)
   for(const enabled of [false,false,true]) {
    lighting.sunUniforms.withPrograms=enabled?original:(programs,callback)=>callback();await wait(12)
    const profiler=new Profiler(C,p);profiler.labels=['frame'];await wait(35);const r=profiler.getReport();profiler.destroy()
    const pixels=s.context.readPixels({width:s.drawingBufferWidth,height:s.drawingBufferHeight});let delta=0
    if(!reference)reference=pixels;else for(let i=0;i<pixels.length;i++)delta=Math.max(delta,Math.abs(pixels[i]-reference[i]))
    runs.push({track,t,enabled,delta,groups:lighting.groups.length,mode:p.getLightingDiagnostics().activeMode,gpu:median(r.gpu.map(x=>x.milliseconds)),cpu:median(r.frames.map(x=>x.milliseconds))})
   }
  }
  lighting.sunUniforms.withPrograms=original;return {runs,sameFrameDelta,parityFrames,errors:f.errors}
 });report.pageErrors=errors;fs.writeFileSync('docs/verification/sun-batching.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))
 assert.deepEqual(errors,[]);assert.deepEqual(report.errors,[])
 assert.ok(report.parityFrames>=3);assert.equal(report.sameFrameDelta,0)
 for(const run of report.runs)assert.equal(run.mode,'deferred')
 for(let i=0;i<report.runs.length;i+=3)assert.ok(report.runs[i+2].gpu<report.runs[i].gpu*.8,'batching must reduce GPU cost by at least 20%')
}finally{await b.close()}})().catch(e=>{console.error(e);process.exitCode=1})
