const {chromium}=require(process.env.CESIUM_PLAYWRIGHT||'playwright'),fs=require('node:fs'),assert=require('node:assert/strict')
const umd=process.argv.includes('--umd')
;(async()=>{const b=await chromium.launch({channel:'chrome',headless:true}),report={};try{
 const page=await b.newPage({viewport:{width:640,height:420}}),errors=[];page.on('pageerror',e=>errors.push(e.message))
 await page.goto('http://127.0.0.1:'+(process.env.CCR_TEST_PORT||8877)+'/tests/rendering/stage1-fixture.html'+(umd?'?mode=umd':''));await page.waitForFunction(()=>window.fixture)
 Object.assign(report,await page.evaluate(async()=>{
  const C=Cesium,f=fixture,{startStage1Scene}=await import('/tests/rendering/stage1-scene.js'),{waitFrames}=await import('/tests/rendering/deferred-lighting-fixture.js')
  const {registerHdrEffect}=await import('/src/environment/HdrCoordinator143.js'),{framePixels}=await import('/tests/rendering/shadow-cascades-fixture.js')
  await startStage1Scene(f);const p=f.pipeline,s=f.viewer.scene,wait=n=>waitFrames(s,n,f.errors)
  p.setOptions({environment:true,clouds:false,fog:false,environmentAnimation:false,shadows:false,antialiasing:'off',renderTargetPoolEnabled:false});await wait(35)
  for(const model of f.models)model.imageBasedLighting.imageBasedLightingFactor=new C.Cartesian2(0,0)
  await wait(20);const reference=framePixels(C,s)
  const nativeTargets=new Set([...Object.values(p.screenSpaceAO.stages),...p.hdrBloom.stages].map(stage=>stage.outputTexture).filter(Boolean))
  const nativeBytes=[...nativeTargets].reduce((n,t)=>n+t.sizeInBytes,0)
  p.setOptions({renderTargetPoolEnabled:true});await wait(40);const pooled=framePixels(C,s),enabled=p.getResourcePoolDiagnostics()
  let delta=0;for(let i=0;i<reference.length;i++)delta=Math.max(delta,Math.abs(reference[i]-pooled[i]))
  const ledger={ao:p.screenSpaceAO.pooled.getLedger(),bloom:p.hdrBloom.pooled.getLedger()}
  p.setOptions({environment:false});await wait(20)
  const noEnvironmentStart=p.getResourcePoolDiagnostics();await wait(10)
  const noEnvironmentEnd=p.getResourcePoolDiagnostics()
  const pool=p.hdrBloom.pooled.pool,acquire=pool.acquire
  pool.acquire=function(owner,spec){if(owner.kind==='bloom')throw new Error('injected pool allocation failure');return acquire.call(this,owner,spec)}
  await wait(2);pool.acquire=acquire
  const failure={bloom:p.getHdrBloomDiagnostics(),ao:p.getScreenSpaceAODiagnostics(),pool:p.getResourcePoolDiagnostics()}
  p.setHdrBloom({enabled:false});p.setHdrBloom({enabled:true});await wait(12)
  const retry=p.getHdrBloomDiagnostics().valid
  p.setOptions({environment:true});await wait(20)
  const cycles=[]
  for(let i=0;i<10;i++){
    p.setScreenSpaceAO({enabled:false});p.setHdrBloom({enabled:false});const off=p.getResourcePoolDiagnostics()
    f.viewer.resolutionScale=i%2?.75:1
    p.setScreenSpaceAO({enabled:true,algorithm:'hbao'});p.setHdrBloom({enabled:true});await wait(12)
    cycles.push({off,active:p.getResourcePoolDiagnostics(),ao:p.getScreenSpaceAODiagnostics().valid,bloom:p.getHdrBloomDiagnostics().valid})
  }
  p.setScreenSpaceAO({enabled:false});p.setHdrBloom({enabled:false});const final=p.getResourcePoolDiagnostics()
  return {delta,nativeBytes,enabled,ledger,noEnvironmentStart,noEnvironmentEnd,failure,retry,cycles,final,errors:f.errors}
 }))
 report.pageErrors=errors
 fs.mkdirSync('docs/verification/stage1-B05',{recursive:true});fs.writeFileSync('docs/verification/stage1-B05/'+(umd?'pool-umd':'pool')+'.json',JSON.stringify(report,null,2))
 assert.deepEqual(errors,[]);assert.deepEqual(report.errors,[]);assert.equal(report.delta,0,'pool must preserve every displayed pixel');assert.ok(report.enabled.crossReused>0,'real cross-effect reuse required')
 assert.ok(report.enabled.currentBytes<report.nativeBytes,'actual resident saving required')
 assert.equal(report.noEnvironmentEnd.crossReused,report.noEnvironmentStart.crossReused,'overlapping AO/Bloom colors must not alias')
 assert.equal(report.failure.bloom.failed,true);assert.equal(report.failure.ao.valid,true);assert.ok(report.failure.pool.live<=1);assert.equal(report.retry,true)
 for(const c of report.cycles){assert.equal(c.off.live,0);assert.equal(c.off.currentBytes,0);assert.equal(c.ao,true);assert.equal(c.bloom,true)}
 assert.equal(report.final.live,0);assert.equal(report.final.currentBytes,0)
 console.log(JSON.stringify({delta:report.delta,pool:report.enabled,final:report.final}))
}finally{await b.close()}})().catch(e=>{console.error(e.message);process.exitCode=1})
