// B00: explicit golden updates, read-only comparisons, and separate imagery visual checks.
const {chromium}=require(process.env.CESIUM_PLAYWRIGHT||'playwright')
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto')
const {safeUrl,sourceSnapshot,compareGolden,assertRequests}=require('./baseline-utils.cjs')
const argv=process.argv.slice(2),arg=(key,fallback)=>{const i=argv.indexOf(key);return i<0?fallback:argv[i+1]}
const root=path.resolve(__dirname,'..'),port=process.env.CCR_TEST_PORT||8877
const target=arg('--target','campus-geometry'),mode=arg('--mode',target==='campus'?'visual':'compare')
const configuration=arg('--configuration','ccr-default'),repeat=Number(arg('--repeat','2'))
const goldenDir=path.join(root,'tests/rendering/baselines')
const output=path.join(root,'docs/verification/stage1-B00-fixed',target+'-'+configuration+'-'+mode)
function assetManifest(){
 const dir=path.join(root,'assets/campus-assets'),files=[]
 function walk(p){for(const e of fs.readdirSync(p,{withFileTypes:true})){
  const file=path.join(p,e.name)
  if(e.isDirectory())walk(file)
  else if(e.isFile())files.push({path:path.relative(dir,file).replace(/\\/g,'/'),sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')})
 }}
 if(target!=='fixtures')walk(dir)
 return files.sort((a,b)=>a.path.localeCompare(b.path))
}
;(async()=>{
 assert.ok(['campus','campus-geometry','fixtures'].includes(target),'unknown target')
 assert.ok(['update','compare','visual'].includes(mode),'unknown mode')
 assert.ok(['isolated','ccr-default','campus-quality'].includes(configuration),'unknown configuration')
 assert.ok(Number.isInteger(repeat)&&repeat>=1&&repeat<=5,'repeat must be 1..5')
 assert.ok(mode!=='update'||repeat>=2,'updating a golden requires two cold-start runs')
 assert.ok(target!=='campus'||mode==='visual','external imagery is visual-only; never overwrite deterministic goldens')
 fs.mkdirSync(output,{recursive:true})
 const goldenFile=path.join(goldenDir,target+'-'+configuration+'.json')
 const reference=mode==='compare'?JSON.parse(fs.readFileSync(goldenFile,'utf8')):null
 const sources=sourceSnapshot(root),assets=assetManifest()
 const report={target,configuration,mode,generatedAt:new Date().toISOString(),sources,assets,runs:[],errors:[],
  determinism:repeat>=2?'pending':'not-tested',goldenCompared:false,valid:false}
 const browser=await chromium.launch({channel:'chrome',headless:true})
 report.browserVersion=browser.version()
 try{
  for(let round=0;round<repeat;round++){
   // A new context, not just a navigation: discard application/storage state between runs.
   const context=await browser.newContext({viewport:{width:1280,height:720},deviceScaleFactor:1})
   const page=await context.newPage(),requests={httpErrors:[],failed:[],providerErrors:[]},pageErrors=[]
   report.activeRequests=requests
   const mark=()=>page.evaluate(()=>{globalThis.__baselineHttpFailure=true}).catch(()=>{})
   page.on('response',r=>{
    if(r.status()>=400&&!r.url().endsWith('/favicon.ico')){requests.httpErrors.push({url:safeUrl(r.url()),status:r.status()});mark()}
   })
   page.on('requestfailed',r=>{requests.failed.push({url:safeUrl(r.url()),error:r.failure()?.errorText});mark()})
   page.on('pageerror',e=>pageErrors.push(e.message.replace(/https?:\/\/[^\s]+/g,safeUrl)))
   const route=target==='fixtures'?'/tests/rendering/stage1-fixture.html':
     '/examples/campus.html'+(target==='campus-geometry'?'?imagery=none':'')
   await page.goto('http://127.0.0.1:'+port+route)
   await page.waitForFunction(target==='fixtures'?()=>!!window.fixture:
     ()=>window.campus?.tiles.length===3&&window.campus.contextTiles.length===1,null,{timeout:90000})
   const run=await page.evaluate(async ({target,configuration})=>{
    const m=await import('/tests/rendering/stage1-baseline-fixture.js')
    const host=globalThis.campus||globalThis.fixture,scene=host.viewer.scene
    host.baselineProviderErrors=[]
    for(let i=0;i<scene.imageryLayers.length;i++){
     const provider=scene.imageryLayers.get(i).imageryProvider
     provider?.errorEvent?.addEventListener(()=>host.baselineProviderErrors.push('required imagery provider failed'))
    }
    if(target==='campus-geometry'){
     scene.imageryLayers.removeAll();scene.globe.baseColor=Cesium.Color.fromCssColorString('#647580')
    }
    scene.screenSpaceCameraController.enableInputs=false
    scene.screenSpaceCameraController.enableCollisionDetection=false
    for(const e of document.querySelectorAll('.lil-gui.lil-root,#hud,.stats-panel'))e.style.display='none'
    if(host.stats?.dom)host.stats.dom.style.display='none'
    const options=m.baselineConfigurations().filter(c=>c.id===configuration)
    const result=await m.runBaseline(host,{configurations:options,requireImagery:target==='campus'})
    return {...result,providerErrors:host.baselineProviderErrors,options,
      hardware:{renderer:result.measurements.configurations[0].runtime.renderer,cesium:Cesium.VERSION}}
   },{target,configuration})
   requests.providerErrors=run.providerErrors
   report.runs.push({...run,requests,pageErrors})
   assertRequests(requests);assert.deepEqual(pageErrors,[],'page errors')
   assert.ok(Object.values(run.checks).every(Boolean),'scene checks failed')
   await page.screenshot({path:path.join(output,'round-'+(round+1)+'.png')})
   await context.close()
  }
  const capture=run=>({target,configuration,captures:run.measurements.captures})
  const candidate=capture(report.runs[0])
  if(target!=='campus'&&repeat>1){
   for(const run of report.runs.slice(1))compareGolden(candidate,capture(run))
   report.determinism='passed'
  }else if(target==='campus')report.determinism='visual-only'
  if(reference){
   assert.deepEqual(reference.assets,assets,'baseline asset set changed')
   assert.deepEqual(reference.hardware,report.runs[0].hardware,'baseline GPU/runtime changed; revalidate before updating')
   compareGolden(reference,candidate);report.goldenCompared=true
  }
  assert.equal(sourceSnapshot(root).contentHash,sources.contentHash,'source changed during capture')
  if(mode==='update'){
   fs.mkdirSync(goldenDir,{recursive:true})
   fs.writeFileSync(goldenFile,JSON.stringify({...candidate,options:report.runs[0].options,hardware:report.runs[0].hardware,
    assets,sources},null,2)+'\n')
  }
  report.valid=true
 }catch(e){report.errors.push(e.message.replace(/https?:\/\/[^\s]+/g,safeUrl));throw e}
 finally{fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));await browser.close()}
 console.log(JSON.stringify({target,configuration,mode,determinism:report.determinism,goldenCompared:report.goldenCompared,valid:report.valid}))
})().catch(e=>{console.error(e.message.replace(/https?:\/\/[^\s]+/g,safeUrl));process.exitCode=1})
