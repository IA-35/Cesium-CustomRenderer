const {chromium}=require(process.env.CESIUM_PLAYWRIGHT||'playwright'),fs=require('node:fs'),assert=require('node:assert/strict')
;(async()=>{const b=await chromium.launch({channel:'chrome',headless:true}),report={};try{
 const page=await b.newPage({viewport:{width:800,height:500}}),errors=[];page.on('pageerror',e=>errors.push(e.message))
 await page.goto('http://127.0.0.1:'+(process.env.CCR_TEST_PORT||8877)+'/tests/rendering/stage1-fixture.html');await page.waitForFunction(()=>window.fixture)
 Object.assign(report,await page.evaluate(async()=>{
  const C=Cesium,f=fixture,{startOcclusionFixture}=await import('/tests/rendering/occlusion-fixture.js'),{waitFrames}=await import('/tests/rendering/deferred-lighting-fixture.js'),{default:Profiler}=await import('/src/diagnostics/RenderProfiler143.js'),{framePixels}=await import('/tests/rendering/shadow-cascades-fixture.js')
  await startOcclusionFixture(f,{dense:true});const p=f.pipeline,s=f.viewer.scene,ctx=s.context,wait=n=>waitFrames(s,n,f.errors),models=new Set(f.models),native=ctx.draw
  let draws=0
  ctx.draw=function(command,ps,...args){const fb=command.framebuffer||ps?.framebuffer;if(models.has(command.owner)&&(fb===s._view.globeDepth?.colorFramebufferManager?.framebuffer||fb===s._view.sceneFramebuffer?._colorFramebuffer?.framebuffer))draws++;return native.call(this,command,ps,...args)}
  const reference=framePixels(C,s),runs=[]
  p.setOcclusionCulling({enabled:true});const warmupProfiler=new Profiler(C,p);warmupProfiler.labels=['occlusion'];await wait(25)
  const warmup=warmupProfiler.getReport();warmupProfiler.destroy();p.setOcclusionCulling({enabled:false});await wait(8)
  for(const enabled of [false,true,false,true,false,true]){
   p.setOcclusionCulling({enabled});await wait(40);draws=0
   const profiler=new Profiler(C,p);profiler.labels=['frame'];await wait(70)
   const data=profiler.getReport();profiler.destroy();const pixels=framePixels(C,s)
   let delta=0;for(let i=0;i<pixels.length;i++)delta=Math.max(delta,Math.abs(pixels[i]-reference[i]))
   runs.push({enabled,drawsPerFrame:draws/data.frames.length,gpu:data.gpu.filter(x=>x.label==='frame').map(x=>x.milliseconds),supported:data.gpuSupported,delta,culling:p.getOcclusionDiagnostics()})
  }
  const gl=ctx._gl,debug=gl.getExtension('WEBGL_debug_renderer_info')
  return {runs,warmup:{gpu:warmup.gpu,occlusion:warmup.occlusion},viewport:[s.drawingBufferWidth,s.drawingBufferHeight],options:p.getOptions(),
   camera:{position:s.camera.positionWC,direction:s.camera.directionWC,up:s.camera.upWC},time:C.JulianDate.toIso8601(f.viewer.clock.currentTime),
   renderer:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),errors:f.errors}
 }))
 const median=a=>{const b=[...a].sort((a,b)=>a-b);return b[Math.floor(b.length/2)]}
 const off=report.runs.filter(r=>!r.enabled).flatMap(r=>r.gpu),on=report.runs.filter(r=>r.enabled).flatMap(r=>r.gpu)
 const a=median(off),btime=median(on),noise=Math.max(median(off.map(x=>Math.abs(x-a))),median(on.map(x=>Math.abs(x-btime))))
 // Moving-block bootstrap retains short-range frame correlation; resampling
 // paired A/B runs also includes between-run clock/load variability.
 let seed=1947;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296}
 const sample=data=>{const out=[];while(out.length<data.length){const start=Math.floor(random()*data.length);for(let j=0;j<8&&out.length<data.length;j++)out.push(data[(start+j)%data.length])}return out}
 const gains=[]
 for(let i=0;i<2000;i++){const x=[],y=[];for(let k=0;k<3;k++){const pair=Math.floor(random()*3);x.push(...sample(report.runs[pair*2].gpu));y.push(...sample(report.runs[pair*2+1].gpu))}gains.push(median(x)-median(y))}
 gains.sort((a,b)=>a-b)
 report.result={offMedian:a,onMedian:btime,gain:a-btime,frameMad:noise,gain95:[gains[50],gains[1949]],method:'paired run / 8-frame moving-block bootstrap, 2000 samples, seed 1947',drawReduction:1-median(report.runs.filter(r=>r.enabled).map(r=>r.drawsPerFrame))/median(report.runs.filter(r=>!r.enabled).map(r=>r.drawsPerFrame))}
 report.pageErrors=errors;report.browser=b.version();report.sources=require('./baseline-utils.cjs').sourceSnapshot(require('node:path').resolve(__dirname,'..'))
 fs.mkdirSync('docs/verification/stage1-B06',{recursive:true});fs.writeFileSync('docs/verification/stage1-B06/performance.json',JSON.stringify(report,null,2))
 assert.deepEqual(errors,[]);assert.deepEqual(report.errors,[]);assert.ok(report.runs.every(r=>r.supported&&r.gpu.length>=50&&r.delta===0));assert.ok(report.result.drawReduction>=.2);assert.ok(report.result.gain95[0]>a*.05,'GPU gain confidence bound must exceed 5% baseline')
 console.log(JSON.stringify(report.result))
}finally{await b.close()}})().catch(e=>{console.error(e.message);process.exitCode=1})
