const {chromium}=require(process.env.CESIUM_PLAYWRIGHT||'playwright'),fs=require('node:fs'),assert=require('node:assert/strict')
;(async()=>{const b=await chromium.launch({channel:'chrome',headless:true}),report={};try{
 const page=await b.newPage({viewport:{width:800,height:500}}),errors=[];page.on('pageerror',e=>errors.push(e.message))
 await page.goto('http://127.0.0.1:'+(process.env.CCR_TEST_PORT||8877)+'/tests/rendering/stage1-fixture.html');await page.waitForFunction(()=>window.fixture)
 Object.assign(report,await page.evaluate(async()=>{
  const C=Cesium,f=fixture,{startOcclusionFixture}=await import('/tests/rendering/occlusion-fixture.js'),{waitFrames}=await import('/tests/rendering/deferred-lighting-fixture.js'),{framePixels}=await import('/tests/rendering/shadow-cascades-fixture.js')
  await startOcclusionFixture(f);const p=f.pipeline,s=f.viewer.scene,wait=n=>waitFrames(s,n,f.errors)
  const baseline=framePixels(C,s);p.setOcclusionCulling({enabled:true});await wait(45)
  const pixels=framePixels(C,s);let delta=0;for(let i=0;i<pixels.length;i++)delta=Math.max(delta,Math.abs(pixels[i]-baseline[i]))
  const stable=p.getOcclusionDiagnostics(),groups=p.occlusionCulling.groups.map(g=>({id:g.owner.id,projected:g.projected,state:p.occlusionCulling.states.get(g.owner)}))
  f.wall.show=false;await wait(1);const restored=p.getOcclusionDiagnostics();await wait(12)
  p.setOcclusionCulling({enabled:false});await wait(3)
  return {delta,stable,groups,restored,disabled:p.getOcclusionDiagnostics(),errors:f.errors}
 }))
 report.pageErrors=errors;fs.mkdirSync('docs/verification/stage1-B06',{recursive:true});fs.writeFileSync('docs/verification/stage1-B06/report.json',JSON.stringify(report,null,2))
 assert.deepEqual(errors,[]);assert.deepEqual(report.errors,[]);assert.equal(report.delta,0);assert.ok(report.stable.hidden>10,'real hidden groups required');assert.ok(report.stable.skippedDraws>10,'real main draws must be skipped');assert.equal(report.restored.hidden,0,'occluder removal restores visibility immediately');assert.equal(report.disabled.pending,0)
 console.log(JSON.stringify({delta:report.delta,stable:report.stable,restored:report.restored}))
}finally{await b.close()}})().catch(e=>{console.error(e.message);process.exitCode=1})
