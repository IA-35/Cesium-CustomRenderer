const {chromium}=require(process.env.CESIUM_PLAYWRIGHT||'playwright')
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const phase=process.argv[2]||'after',output=path.resolve(__dirname,'../docs/verification/campus-aa-'+phase)
fs.mkdirSync(output,{recursive:true})
;(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true})
 try{
  const page=await browser.newPage({viewport:{width:1280,height:720}}),errors=[]
  page.on('pageerror',e=>errors.push(e.message))
  // Local campus tiles stay identical; suppress the external imagery request for repeatability.
  await page.goto('http://127.0.0.1:8877/examples/campus.html?imagery=none')
  await page.waitForFunction(()=>window.campus?.tiles.length===3,null,{timeout:60000})
  await page.evaluate(()=>campus.look(-0.45,750))
  // 左下角的 Stats 面板同样会落进对比截图里（它与画质无关），一并隐藏。
  await page.evaluate(()=>{campus.pipeline.setOptions({environmentAnimation:false});campus.viewer.scene.screenSpaceCameraController.enableCollisionDetection=false;campus.viewer.scene.screenSpaceCameraController.enableInputs=false;document.querySelectorAll('.lil-gui.lil-root,#hud').forEach(x=>x.style.display='none');campus.stats.dom.style.display='none'})
  await page.waitForFunction(()=>campus.tiles.every(t=>t.tilesLoaded)&&campus.contextTiles.every(t=>t.tilesLoaded),null,{timeout:60000})
  const configs=phase==='before'?[
   ['off',{mode:'off'}],['fxaa',{mode:'fxaa'}],['smaa',{mode:'smaa'}],['msaa4',{mode:'msaa',msaaSamples:4}],['smaa-msaa4',{mode:'smaa',msaaSamples:4,msaaCombine:true}]
  ]:[['off',{mode:'off'}],['fxaa-sharp',{mode:'fxaa',quality:'sharp'}],['fxaa-balanced',{mode:'fxaa',quality:'balanced'}],['fxaa-smooth',{mode:'fxaa',quality:'smooth'}],
   ['smaa-sharp',{mode:'smaa',quality:'sharp'}],['smaa-balanced',{mode:'smaa',quality:'balanced'}],['smaa-smooth',{mode:'smaa',quality:'smooth'}],['msaa4',{mode:'msaa',msaaSamples:4}],['msaa8',{mode:'msaa',msaaSamples:8}],['smaa-msaa4',{mode:'smaa',quality:'balanced',msaaSamples:4,msaaCombine:true}]]
  const results=[]
  for(const [name,options] of configs){
   const result=await page.evaluate(async options=>{
    const {viewer,pipeline}=campus,scene=viewer.scene
    const frames=n=>new Promise(resolve=>{const off=scene.postRender.addEventListener(()=>{if(--n===0){off();resolve()}})})
    pipeline.setAntiAliasing({msaaSamples:1,msaaCombine:false,resolutionScale:1,...options})
    if(options.mode==='smaa')await pipeline.smaa.readyPromise
    await frames(30)
    const snapshot=()=>JSON.stringify({position:viewer.camera.positionWC,direction:viewer.camera.directionWC,up:viewer.camera.upWC,time:Cesium.JulianDate.toIso8601(viewer.clock.currentTime),buffer:[viewer.canvas.width,viewer.canvas.height]})
    const before=snapshot(),samples=[]
    const {default:GpuTimer}=await import('/src/diagnostics/GpuTimer.js')
    const timer=new GpuTimer(scene.context._gl),render=scene.render
    scene.render=function(...args){timer.poll();return timer.measure('frame',()=>render.apply(this,args))}
    let last;const off=scene.postRender.addEventListener(()=>{const now=performance.now();if(last)samples.push(now-last);last=now})
    await frames(80);off();scene.render=render;timer.poll()
    const gpu=timer.samples.map(x=>x.milliseconds).sort((a,b)=>a-b);timer.destroy();samples.sort((a,b)=>a-b)
    return {requested:options,actual:pipeline.getRenderDiagnostics().antiAliasing,buffer:[viewer.canvas.width,viewer.canvas.height],unchanged:before===snapshot(),before,after:snapshot(),
     tilesLoaded:campus.tiles.every(t=>t.tilesLoaded),gpu:{supported:timer.supported,count:gpu.length,p50:gpu[Math.floor(gpu.length*.5)],p95:gpu[Math.floor(gpu.length*.95)]},
     frameInterval:{p50:samples[Math.floor(samples.length*.5)],p95:samples[Math.floor(samples.length*.95)]},errors:campus.errors}
   },options)
   assert.ok(result.unchanged&&result.tilesLoaded,JSON.stringify(result));assert.equal(result.errors.length,0)
   await page.screenshot({path:path.join(output,name+'.png')});results.push({name,...result});console.log(JSON.stringify({name,gpu:result.gpu,actual:result.actual.postProcess.effective,samples:result.actual.allocatedAttachments?.scene}))
  }
  assert.equal(errors.length,0)
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({scope:'1280x720 headless Chrome, fixed campus camera; diagnostic comparison, not foreground performance acceptance',results,errors},null,2))
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1})
