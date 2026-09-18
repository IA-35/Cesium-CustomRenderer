const {chromium}=require(process.env.CESIUM_PLAYWRIGHT||'playwright'),fs=require('node:fs'),crypto=require('node:crypto'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process')
const port=process.env.CCR_TEST_PORT||8877,reference='b94a9b8'
const baseline=execFileSync('git',['show',reference+':build/0.1.0/CCR.min.js'],{maxBuffer:8e6})
const inputHash=()=>crypto.createHash('sha256').update(fs.readFileSync('examples/campus.js')).update(fs.readFileSync('examples/campus.html')).digest('hex')
;(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true}),report={reference,exampleHash:inputHash(),viewport:[1280,720],imagery:'none; same local assets for both versions',runs:[]};try{
 for(const version of ['b03','current','b03','current']) {
  const page=await browser.newPage({viewport:{width:1280,height:720}}),errors=[];page.on('pageerror',e=>errors.push(e.message))
  if(version==='b03')await page.route('**/build/0.1.0/CCR.min.js',r=>r.fulfill({contentType:'text/javascript',body:baseline}))
  await page.goto('http://127.0.0.1:'+port+'/examples/campus.html?imagery=none')
  await page.waitForFunction(()=>window.campus?.tiles.length&&document.querySelector('#status').textContent.includes('已加载'),null,{timeout:120000})
  const run=await page.evaluate(async()=>{
   const C=Cesium,f=campus,p=f.pipeline,s=f.viewer.scene,{waitFrames}=await import('/tests/rendering/ssr-surfaces-fixture.js'),{default:Timer}=await import('/src/diagnostics/GpuTimer.js')
   const wait=n=>waitFrames(s,n,f.errors,120000),time=C.JulianDate.clone(f.viewer.clock.currentTime)
   s.postUpdate.addEventListener(()=>{f.viewer.clock.currentTime=C.JulianDate.clone(time)})
   p.setOptions({environmentAnimation:false});s.screenSpaceCameraController.enableInputs=false
   const shots=[]
   for(const [name,pitch,range]of [['panorama',-.65,1800],['near',-.55,900]]) {
    f.look(pitch,range);await wait(60)
    let stable=0
    const deadline=performance.now()+90000
    while(performance.now()<deadline&&stable<20){await wait(1);stable=f.tiles.concat(f.contextTiles).every(t=>t.tilesLoaded)?stable+1:0}
    if(stable<20)throw new Error('Campus tiles did not settle: '+JSON.stringify(f.tiles.concat(f.contextTiles).filter(t=>!t.tilesLoaded).map(t=>({name:t.name,pending:t._statistics?.numberOfPendingRequests,processing:t._statistics?.numberOfTilesProcessing,loaded:t._statistics?.numberOfTilesWithContentReady,bytes:t.totalMemoryUsageInBytes}))))
    const timer=new Timer(s.context._gl),cpu=[],intervals=[],draws=[],previous=s.render,draw=s.context.draw;let last,count=0
    s.context.draw=function(...args){count++;return draw.apply(this,args)}
    s.render=function(...args){timer.poll();const start=performance.now();if(last)intervals.push(start-last);last=start;count=0
      try{return timer.measure('frame',()=>previous.apply(this,args))}finally{cpu.push(performance.now()-start);draws.push(count)}}
    try{await wait(120)}finally{s.render=previous;s.context.draw=draw}
    await wait(3);timer.poll()
    const sorted=a=>[...a].sort((a,b)=>a-b),stats=a=>{const x=sorted(a);return {samples:x.length,p50:x[Math.floor(x.length*.5)],p95:x[Math.floor(x.length*.95)],mean:x.reduce((a,b)=>a+b,0)/x.length}}
    const result={name,cpu:stats(cpu),frame:stats(intervals),gpu:stats(timer.samples.map(x=>x.milliseconds)),draws:stats(draws),
      camera:[s.camera.positionWC,s.camera.directionWC,s.camera.upWC].map(v=>[v.x,v.y,v.z]),tiles:f.tiles.map(t=>t.name),options:p.getOptions()}
    timer.destroy();shots.push(result)
   }
   return {shots,errors:f.errors}
  });report.runs.push({version,...run,pageErrors:errors});await page.close()
 }
 assert.equal(inputHash(),report.exampleHash,'Campus files changed during the comparison')
 report.summary=['panorama','near'].map(name=>{const mean=a=>a.reduce((x,y)=>x+y,0)/a.length;const sample=v=>report.runs.filter(r=>r.version===v).map(r=>r.shots.find(s=>s.name===name));const old=sample('b03'),now=sample('current');return {name,b03FrameMs:mean(old.map(s=>s.frame.mean)),currentFrameMs:mean(now.map(s=>s.frame.mean)),b03CpuMs:mean(old.map(s=>s.cpu.p50)),currentCpuMs:mean(now.map(s=>s.cpu.p50)),b03GpuMs:mean(old.map(s=>s.gpu.p50)),currentGpuMs:mean(now.map(s=>s.gpu.p50))}})
 fs.writeFileSync('docs/verification/campus-b03-performance.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report.summary,null,2))
 for(const run of report.runs){assert.deepEqual(run.errors,[]);assert.deepEqual(run.pageErrors,[]);for(const s of run.shots)assert.ok(s.draws.p50>10)}
 for(let i=1;i<report.runs.length;i++)for(let j=0;j<2;j++){for(let axis=0;axis<3;axis++)for(let k=0;k<3;k++)assert.ok(Math.abs(report.runs[i].shots[j].camera[axis][k]-report.runs[0].shots[j].camera[axis][k])<(axis===0?1e-7:1e-11),'Camera mismatch');assert.deepEqual(report.runs[i].shots[j].tiles,report.runs[0].shots[j].tiles)}
 for(const s of report.summary)assert.ok(s.currentFrameMs<=Math.max(18.5,s.b03FrameMs*1.15),'Campus frame-time regression: '+s.name)
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1})
