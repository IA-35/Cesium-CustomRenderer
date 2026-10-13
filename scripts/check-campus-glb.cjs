const fs=require('node:fs'),crypto=require('node:crypto'),assert=require('node:assert/strict')
const {chromium}=require(process.env.CESIUM_PLAYWRIGHT||'playwright')
const folder='docs/verification/campus-mobile-glb',hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
async function main(){
 fs.mkdirSync(folder,{recursive:true})
 const report={viewport:[1912,956],sdk:hash('build/0.1.0/CCR.min.js'),runs:[],scope:'Local example, default tree/grass/CCR settings, imagery disabled equally; different building geometry, not a format-only comparison'}
 const browser=await chromium.launch({channel:'chrome',headless:true})
 try{
  for(const mode of ['tiles','glb','glb']){
   const page=await browser.newPage({viewport:{width:1912,height:956}}),errors=[],failed=[]
   page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.status()>=400)failed.push({url:r.url(),status:r.status()})})
   await page.goto(`http://127.0.0.1:8877/examples/campus.html?imagery=none&models=${mode}`)
   await page.waitForFunction(()=>window.campus?.assetsReady()&&campus.treeReady&&campus.grassReady,null,{timeout:180000})
   await page.evaluate(async()=>{await campus.treeReady;await campus.grassReady})
   const result=await page.evaluate(async()=>{
    const {viewer:v,pipeline:p,models,tiles}=campus,s=v.scene,C=Cesium
    p.setOptions({environmentAnimation:false})
    const wait=n=>new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{off();reject(Error('render stalled'))},90000),off=s.postRender.addEventListener(()=>{if(!--n){off();clearTimeout(timeout);resolve()}})})
    campus.look(-.55,1000);await wait(120)
    const {default:Timer}=await import('/src/diagnostics/GpuTimer.js'),timer=new Timer(s.context._gl),frames=[],gl=s.context._gl,render=s.render,originals=new Map();let active,count=0,last
    for(const key of ['drawElements','drawArrays','drawElementsInstanced','drawArraysInstanced']){const fn=gl[key];originals.set(key,fn);gl[key]=function(...args){if(active)count++;return fn.apply(this,args)}}
    s.render=function(...args){timer.poll();const start=performance.now();count=0;active=true;try{return timer.measure('frame',()=>render.apply(this,args))}finally{frames.push({cpu:performance.now()-start,interval:last?start-last:null,draws:count});last=start;active=false}}
    try{for(let i=0;i<180;i++){v.camera.lookAt(campus.cameraCenter,new C.HeadingPitchRange(i/180*Math.PI*2,-.55,1000));await wait(1)}}
    finally{s.render=render;for(const [key,fn]of originals)gl[key]=fn}
    await wait(5);timer.poll()
    const stats=a=>{a=a.filter(Number.isFinite).sort((a,b)=>a-b);return {n:a.length,p50:a[Math.floor(a.length*.5)],p95:a[Math.floor(a.length*.95)],mean:a.reduce((n,x)=>n+x,0)/a.length}}
    const modelBytes=models.reduce((n,m)=>n+m.statistics.geometryByteLength+m.statistics.texturesByteLength,0),tileBytes=tiles.reduce((n,t)=>n+t.totalMemoryUsageInBytes,0)
    const ext=gl.getExtension('WEBGL_debug_renderer_info')
    const result={modelMode:campus.modelMode,modelCount:models.length,tiles:tiles.map(t=>t.name),assetsReady:campus.assetsReady(),errors:campus.errors,
     renderer:ext&&gl.getParameter(ext.UNMASKED_RENDERER_WEBGL),options:p.getOptions(),buffer:[s.drawingBufferWidth,s.drawingBufferHeight],
     cpu:stats(frames.map(x=>x.cpu)),frame:stats(frames.map(x=>x.interval)),draws:stats(frames.map(x=>x.draws)),gpu:stats(timer.samples.map(x=>x.milliseconds)),
     modelBytes,tileBytes,trees:campus.trees.getDiagnostics(),grass:campus.grass.getDiagnostics(),cameraCenter:[campus.cameraCenter.x,campus.cameraCenter.y,campus.cameraCenter.z]}
    timer.destroy();campus.look(-.65,1800);await wait(5);return result
   })
   await page.screenshot({path:`${folder}/${mode}-enu.png`})
   report.runs.push({...result,pageErrors:errors,failed});fs.writeFileSync(`${folder}/comparison.json`,JSON.stringify(report,null,2))
   console.log(JSON.stringify({mode,models:result.modelCount,draws:result.draws.p50,cpu:result.cpu,gpu:result.gpu,fps:1000/result.frame.mean,modelBytes:result.modelBytes,tileBytes:result.tileBytes,errors,failed}))
   assert.deepEqual(errors,[]);assert.deepEqual(result.errors,[]);assert.deepEqual(failed,[]);assert.ok(result.assetsReady)
   assert.equal(result.modelCount,mode==='glb'?70:0)
   await page.close()
  }
  assert.equal(hash('build/0.1.0/CCR.min.js'),report.sdk,'SDK changed during comparison')
  for(const run of report.runs){assert.deepEqual(run.options,report.runs[0].options);assert.deepEqual(run.cameraCenter,report.runs[0].cameraCenter)}
 }finally{await browser.close()}
}
main().catch(e=>{console.error(e);process.exitCode=1})
