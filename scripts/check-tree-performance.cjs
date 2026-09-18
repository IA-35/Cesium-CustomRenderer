const {chromium}=require(process.env.CESIUM_PLAYWRIGHT||'playwright')
const fs=require('node:fs'),path=require('node:path')
const phase=process.argv[2]||'after',dir=path.resolve('docs/verification/ez-tree'),port=process.env.CCR_TEST_PORT||8878
fs.mkdirSync(dir,{recursive:true})
;(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true});try{
  const page=await browser.newPage({viewport:{width:1912,height:956}}),errors=[]
  page.on('pageerror',e=>errors.push(e.message))
  page.on('console',m=>{if(m.type()==='error'){errors.push(m.text());console.error(m.text())}})
  await page.goto(`http://127.0.0.1:${port}/examples/campus.html?imagery=none&contextTiles=none&trees=1`)
  await page.waitForFunction(()=>window.campus?.trees?.getDiagnostics().state==='ready',null,{timeout:180000})
  await page.evaluate(()=>{
    document.querySelectorAll('.lil-gui.lil-root,#hud').forEach(e=>e.style.display='none');campus.stats.dom.style.display='none'
    campus.pipeline.setOptions({environmentAnimation:false});campus.viewer.clock.shouldAnimate=false
    const p=campus.trees._points?.find(p=>p.prototypeId==='pine-02c')||null
    // Fixed surveyed avenue, independent of the selected rendering implementation.
    campus.viewer.camera.lookAt(Cesium.Cartesian3.fromDegrees(123.4118,41.7641,7),new Cesium.HeadingPitchRange(0,-0.06,42))
  })
  await page.waitForTimeout(2500)
  const results=[]
  for(const show of [true,false,true]){
    await page.evaluate(show=>campus.trees.setVisible(show),show)
    const result=await page.evaluate(async()=>{
      const s=campus.viewer.scene,wait=n=>new Promise(resolve=>{const off=s.postRender.addEventListener(()=>{if(--n===0){off();resolve()}})})
      await wait(30)
      const {default:GpuTimer}=await import('/src/diagnostics/GpuTimer.js'),timer=new GpuTimer(s.context._gl),render=s.render,intervals=[],cpu=[]
      s.render=function(...args){timer.poll();const start=performance.now();const r=timer.measure('frame',()=>render.apply(this,args));cpu.push(performance.now()-start);return r}
      let last;const off=s.postRender.addEventListener(()=>{const now=performance.now();if(last)intervals.push(now-last);last=now})
      await wait(180);off();s.render=render;timer.poll()
      const summarize=a=>{a.sort((a,b)=>a-b);return {count:a.length,p50:a[Math.floor(a.length*.5)],p95:a[Math.floor(a.length*.95)]}}
      const result={frame:summarize(intervals),cpu:summarize(cpu),gpu:summarize(timer.samples.map(x=>x.milliseconds)),diag:campus.trees.getDiagnostics(),shadow:campus.pipeline.customShadow?.stats.casters,errors:campus.errors,options:campus.pipeline.getOptions()}
      timer.destroy();return result
    })
    results.push({show,...result})
    await page.screenshot({path:path.join(dir,`${phase}-${show?'on':'off'}.png`)})
  }
  fs.writeFileSync(path.join(dir,`${phase}.json`),JSON.stringify({scope:'1912x956 headless Chrome; same fixed avenue; 180 sampled frames per case; not foreground FPS acceptance',errors,results},null,2))
  console.log(JSON.stringify({phase,errors,results:results.map(({show,frame,cpu,gpu,diag,shadow,errors})=>({show,frame,cpu,gpu,diag,shadow,errors}))}))
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1})
