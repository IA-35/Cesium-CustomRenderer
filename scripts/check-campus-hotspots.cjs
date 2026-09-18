const {chromium}=require(process.env.CESIUM_PLAYWRIGHT||'playwright'),fs=require('node:fs')
;(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true});try{
 const page=await browser.newPage({viewport:{width:1280,height:720}})
 page.on('pageerror',e=>console.error(e.message))
 await page.route('**/build/0.1.0/CCR.min.js',r=>r.fulfill({contentType:'text/javascript',body:"import * as CCR from '/src/index.js'; globalThis.CCR=CCR;"}))
 await page.goto('http://127.0.0.1:'+(process.env.CCR_TEST_PORT||8877)+'/examples/campus.html?imagery=none&assets='+encodeURIComponent(process.env.CCR_BUSINESS_ASSETS||'http://127.0.0.1:8083/Dongda'))
 await page.waitForFunction(()=>window.campus?.tiles.length>=13||window.campus?.errors.length,null,{timeout:45000})
 const result=await page.evaluate(async()=>{
  const f=campus,p=f.pipeline,s=f.viewer.scene,C=Cesium,{waitFrames}=await import('/tests/rendering/ssr-surfaces-fixture.js'),{default:Profiler}=await import('/src/diagnostics/RenderProfiler143.js'),{freezeTime}=await import('/tests/rendering/stage1-baseline-fixture.js')
  const wait=n=>waitFrames(s,n,f.errors,120000);freezeTime(f.viewer,'2026-09-08T03:00:00Z');p.setOptions({environmentAnimation:false});f.look(-.65,1800)
  if(f.errors.length||f.tiles.length!==f.expectedTiles)throw new Error('Full business assets were not loaded')
  const deadline=performance.now()+120000;let stable=0
  while(performance.now()<deadline&&stable<15){await wait(1);stable=f.tiles.concat(f.contextTiles).every(t=>t.tilesLoaded)?stable+1:0}
  if(stable<15)throw new Error('Full campus did not settle')
  const baseline=p.getOptions(),runs=[]
  for(const [name,patch]of [['default',{}],['without-shadows',{shadows:false}],['without-environment',{environment:false}],['base',{shadows:false,environment:false}],['default-repeat',{}],['dynamic-time',{}]]) {
   if(name==='dynamic-time'){f.viewer.__baselineFreezeOff?.();f.viewer.clock.shouldAnimate=true;f.viewer.clock.multiplier=10}
   p.setOptions({...baseline,...patch});await wait(20)
   const intervals=[];let last
   const off=s.preRender.addEventListener(()=>{const now=performance.now();if(last)intervals.push(now-last);last=now})
   const profiler=new Profiler(C,p);profiler.labels=['frame','shadow','environment'];await wait(120);const r=profiler.getReport();profiler.destroy();off()
   const median=a=>[...a].sort((a,b)=>a-b)[Math.floor(a.length/2)]
   runs.push({name,cpu:median(r.frames.map(x=>x.milliseconds)),fps:1000/(intervals.reduce((a,b)=>a+b,0)/intervals.length),p95:[...intervals].sort((a,b)=>a-b)[Math.floor(intervals.length*.95)],draws:median(r.frames.map(x=>x.drawCalls)),
    gpu:Object.fromEntries(['frame','shadow','environment'].map(label=>[label,median(r.gpu.filter(x=>x.label===label).map(x=>x.milliseconds))])),
    passes:Object.fromEntries(['shadow','environment'].map(label=>[label,median(r.cpu.filter(x=>x.label===label).map(x=>x.milliseconds))])),
    shadow:structuredClone(p.customShadow?.stats),resources:p.getResourcePoolDiagnostics()})
  }
  return {runs,tiles:f.tiles.map(t=>({name:t.name,bytes:t.totalMemoryUsageInBytes})),errors:f.errors}
 });fs.writeFileSync('docs/verification/campus-hotspots.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result.runs.map(({shadow,resources,...r})=>r),null,2))
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1})
