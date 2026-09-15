const {chromium}=require(process.env.CESIUM_PLAYWRIGHT||'playwright')
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto')
const {compareGolden,assertRequests,safeUrl}=require('./baseline-utils.cjs')
const port=process.env.CCR_TEST_PORT||8877,origin='http://127.0.0.1:'+port
const root=path.resolve(__dirname,'..'),output=path.join(root,'docs/verification/B00-guards.json')
;(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),result={}
 try{
  const page=await browser.newPage({viewport:{width:1280,height:720}})
  await page.goto(origin+'/tests/rendering/stage1-fixture.html');await page.waitForFunction(()=>window.fixture)
  const rendered=await page.evaluate(async()=>{
   const {startStage1Scene}=await import('/tests/rendering/stage1-scene.js')
   const m=await import('/tests/rendering/stage1-baseline-fixture.js')
   await startStage1Scene(fixture)
   const s=fixture.viewer.scene
   fixture.pipeline.setOptions({environmentAnimation:false})
   await m.waitFrames(s,20,[])
   const before=m.hashBytes(m.readDrawingBuffer(fixture.viewer).data)
   fixture.pipeline.setColorGrading({exposure:.1})
   await m.waitFrames(s,20,[])
   const after=m.hashBytes(m.readDrawingBuffer(fixture.viewer).data)
   const host={viewer:fixture.viewer,tiles:[],errors:[]}
   s.imageryLayers.removeAll()
   const empty=m.baselineReadiness(host,true)
   return {before,after,empty}
  })
  assert.notEqual(rendered.before,rendered.after,'injected exposure change must alter the rendered frame')
  const file=path.join(root,'tests/rendering/baselines/fixtures-ccr-default.json')
  const hash=()=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),beforeHash=hash()
  assert.throws(()=>compareGolden({target:'fixture',configuration:'test',captures:[rendered.before]},
    {target:'fixture',configuration:'test',captures:[rendered.after]}),/baseline mismatch/)
  assert.equal(beforeHash,hash());assert.equal(rendered.empty.ready,false)
  result.exposureRegressionRejected=true;result.goldenUnchanged=true;result.emptyImageryRejected=true
  await page.close()
  const bad=await browser.newPage(),httpErrors=[]
  await bad.route('**/examples/runtime-config.js',route=>route.fulfill({contentType:'text/javascript',
   body:'window.CCR_EXAMPLE_CONFIG = '+JSON.stringify({imageryUrl:origin+'/failed-tiles/{z}/{x}/{y}.png'})}))
  await bad.route('**/failed-tiles/**',route=>route.fulfill({status:503,body:'injected imagery failure'}))
  bad.on('response',r=>{if(r.url().includes('/failed-tiles/')&&r.status()===503)httpErrors.push({url:safeUrl(r.url()),status:r.status()})})
  await bad.goto(origin+'/examples/campus.html')
  await bad.waitForFunction(()=>window.campus)
  await bad.waitForResponse(r=>r.url().includes('/failed-tiles/')&&r.status()===503,{timeout:30000})
  assert.throws(()=>assertRequests({httpErrors,failed:[],providerErrors:[]}),/resource/)
  result.imagery503Rejected=true
  await bad.close()
 }finally{fs.writeFileSync(output,JSON.stringify(result,null,2));await browser.close()}
 console.log(JSON.stringify(result))
})().catch(e=>{console.error(e.message);process.exitCode=1})
