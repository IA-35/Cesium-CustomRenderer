const fs=require('fs'),path=require('path'),{chromium}=require('C:/Users/Administrator/node_modules/playwright')
const out=path.resolve('docs/verification/rendering-performance/traa-r186-2026-10-16/static-gates-20261019'),camera=JSON.parse(fs.readFileSync(path.join(out,'live-campus.json'))).camera
async function main(){const browser=await chromium.launch({channel:'chrome',headless:true,args:['--use-angle=d3d11']});try{
 const page=await browser.newPage({viewport:{width:1280,height:720}})
 await page.addInitScript(()=>{const Native=window.WebSocket;window.WebSocket=new Proxy(Native,{construct(target,args){const s=Reflect.construct(target,args);if(String(args[0]).endsWith('/examples/campus.html/ws'))s.addEventListener('message',e=>e.stopImmediatePropagation());return s}})})
 await page.goto('http://127.0.0.1:5501/examples/campus.html',{waitUntil:'domcontentloaded',timeout:60000})
 await page.waitForFunction(()=>window.campus?.models.length===70&&campus.models.every(m=>m.ready)&&campus.traffic?.vehicles.length===60&&campus.traffic.vehicles.every(v=>v.model?.ready),null,{timeout:180000})
 const report=await page.evaluate(async camera=>{
  const f=campus,s=f.viewer.scene;await f.trafficReady;f.viewer.useDefaultRenderLoop=false;s.camera.setView({destination:camera.position,orientation:{direction:camera.direction,up:camera.up}})
  document.querySelector('#hud').style.display='none';document.querySelectorAll('.lil-gui').forEach(n=>n.style.display='none')
  f.pipeline.setTaa({enabled:true,jitterSamples:8});const step=()=>{f.viewer.render();if(f.errors.length)throw Error(f.errors.join('\n'))}
  for(let i=0;i<640;i++){step();if(i%8===7)await new Promise(requestAnimationFrame)}
  const t=f.pipeline.taa,results=[];let saved=t.stableCoverage,globalGate=false
  Object.defineProperty(t,'stableCoverage',{get(){return saved&&(!globalGate||t.motion.stationary)},set(v){saved=v},configurable:true})
  const points=[];for(let y=100;y<=185;y++)for(let x=1110;x<1220;x++)points.push({x,y})
  const w=s.drawingBufferWidth,h=s.drawingBufferHeight,n=128
  for(const mode of ['global-gate','local-gate']){
   globalGate=mode==='global-gate';t.resetHistory()
   for(let i=0;i<256;i++){step();if(i%8===7)await new Promise(requestAnimationFrame)}
   const frames=[],states=[]
   for(let i=0;i<n;i++){step();const p=s.context.readPixels({width:w,height:h});frames.push(points.map(({x,y})=>{const j=(y*w+x)*4;return p[j]*.2126+p[j+1]*.7152+p[j+2]*.0722}));states.push({eligible:t.stableCoverage,draws:t.motion.stats.draws,maskDraws:t.motion.stats.previousFootprints,static:t.staticFrames});if(i%8===7)await new Promise(requestAnimationFrame)}
   const metrics=points.map((p,j)=>{let sum=0,sq=0,ty=0,jump=0;for(let i=0;i<n;i++){const y=frames[i][j];sum+=y;sq+=y*y;ty+=i*y;if(i)jump=Math.max(jump,Math.abs(y-frames[i-1][j]))}const variance=Math.max(0,sq/n-(sum/n)**2),covariance=ty/n-(n-1)/2*sum/n;return {...p,std:Math.sqrt(variance),detrended:Math.sqrt(Math.max(0,variance-covariance*covariance/((n*n-1)/12))),jump}})
   const worst=[...metrics].sort((a,b)=>b.detrended-a.detrended)
   results.push({mode,states,metrics,worst:worst.slice(0,10),point:metrics.find(p=>p.x===1174&&p.y===136),maxJump:Math.max(...metrics.map(p=>p.jump)),meanDetrended:metrics.reduce((a,p)=>a+p.detrended,0)/metrics.length,over2:metrics.filter(p=>p.detrended>2).length})
  }
  return {url:location.href,models:f.models.length,traffic:f.traffic.getDiagnostics().playing,vehicles:f.traffic.vehicles.length,size:[w,h],camera,results,manifest:await fetch('/build/0.1.0/manifest.json').then(r=>r.json())}
 },camera)
 await page.screenshot({path:path.join(out,'paired-final.png')});fs.writeFileSync(path.join(out,'paired-ground.json'),JSON.stringify(report));console.log(JSON.stringify(report.results.map(r=>({mode:r.mode,eligible:r.states.filter(s=>s.eligible).length,mean:r.meanDetrended,over2:r.over2,point:r.point,worst:r.worst.slice(0,2),jump:r.maxJump}))))
}finally{await browser.close()}}
main().catch(e=>{console.error(e);process.exitCode=1})
