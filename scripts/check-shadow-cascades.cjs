const {chromium}=require(process.env.CESIUM_PLAYWRIGHT||'playwright'),fs=require('node:fs'),assert=require('node:assert/strict')
const umd=process.argv.includes('--umd')
;(async()=>{const b=await chromium.launch({channel:'chrome',headless:true}),report={};try{
 const page=await b.newPage({viewport:{width:640,height:420}}),errors=[];page.on('pageerror',e=>errors.push(e.message))
 await page.goto('http://127.0.0.1:'+(process.env.CCR_TEST_PORT||8877)+'/tests/rendering/stage1-fixture.html'+(umd?'?mode=umd':''));await page.waitForFunction(()=>window.fixture)
 Object.assign(report,await page.evaluate(async()=>{
  const C=Cesium,f=fixture,m=await import('/tests/rendering/shadow-cascades-fixture.js'),{waitFrames}=await import('/tests/rendering/deferred-lighting-fixture.js')
  await m.startCascadeFixture(f);const p=f.pipeline,s=f.viewer.scene,wait=n=>waitFrames(s,n,f.errors)
  const ready=p.customShadow.ready,stats=structuredClone(p.customShadow.stats)
  if(!ready)return {ready,stats,errors:f.errors}
  const stable=await m.stationaryFrames(C,s,300)
  const light=s.light,before=m.framePixels(C,s);p.setOptions({shadows:false});s.light=light;await wait(8);const off=m.framePixels(C,s)
  let darker=0;for(let i=0;i<before.length;i+=4)if(off[i]+off[i+1]+off[i+2]-before[i]-before[i+1]-before[i+2]>10)darker++
  p.setOptions({shadows:true});s.light=light;p.setLighting({mode:'deferred'});await wait(15)
  const content=await m.cascadeContentChecks(f)
  const motion=await m.cascadeMotionChecks(f)
  const locations=await m.cascadeLocationChecks(f),gpu=await m.cascadeGpuComparison(f),contact=await m.cascadeContactChecks(f),receivers=await m.cascadeReceiverChecks(f)
  return {ready,stats,stable,darker,content,motion,locations,gpu,contact,receivers,deferred:p.getLightingDiagnostics(),finalShadow:structuredClone(p.customShadow.stats),errors:f.errors}
 }))
 report.pageErrors=errors
 const sequenceDir='docs/verification/stage1-B04/motion'+(umd?'-umd':'');fs.mkdirSync(sequenceDir,{recursive:true})
 for(const frame of report.motion?.sequence||[]){const file=sequenceDir+'/'+String(frame.index).padStart(3,'0')+'.png';fs.writeFileSync(file,Buffer.from(frame.png.split(',')[1],'base64'));delete frame.png;frame.image=file}
 assert.deepEqual(errors,[]);assert.deepEqual(report.errors,[]);assert.equal(report.ready,true,JSON.stringify(report.stats));assert.equal(report.stats.cascades.length,3)
 assert.deepEqual(report.stats.cascades.map(c=>c.size),[2048,1024,1024]);assert.equal(report.stable.changedFrames,0);assert.ok(report.darker>20);assert.equal(report.deferred.valid,true);assert.equal(report.finalShadow.error,null)
 assert.equal(report.content.offscreen.outside,true);assert.ok(report.content.offscreen.casters>0)
 assert.ok(report.content.offscreen.before.some((v,i)=>v-report.content.offscreen.after[i]>.05),'offscreen caster must cast a visible shadow')
 assert.ok(report.content.offscreen.before.every((v,i)=>Math.abs(v-report.content.offscreen.restored[i])<.01))
 assert.ok(report.content.mask.lit.solid.some((v,i)=>v-report.content.mask.shadow.solid[i]>.05),'MASK solid casts')
 assert.ok(report.content.mask.lit.hole.every((v,i)=>Math.abs(v-report.content.mask.shadow.hole[i])<.01),'MASK hole stays open')
 assert.ok(report.motion.samples>500);assert.ok(report.motion.crossings>0);assert.ok(report.motion.maxStep<=.05,'smooth split-crossing brightness must stay within 5%')
 for(const r of report.locations){assert.equal(r.near.ready,true);assert.equal(r.originIndependent,true);assert.equal(r.beyondDistance,true);assert.equal(r.high.ready,true);assert.equal(r.orbit,true);if(r.height)assert.ok(r.near.centerHeight>r.height-500)}
 assert.ok(report.gpu.every(r=>r.gpuSupported&&r.timing.frame.samples>=20&&r.timing.shadow.samples>=20))
 assert.ok(report.contact.results.every(r=>r.firstShadow!==null));assert.ok(report.contact.results[1].firstShadow<=report.contact.results[0].firstShadow+.2,'no new contact gap')
 assert.ok(report.contact.multi.frustums>1);assert.equal(report.contact.multi.shadow,true);assert.equal(report.contact.multi.lighting,true);assert.equal(report.contact.multi.error,null)
 assert.equal(report.receivers.forward.valid,true);assert.ok(report.receivers.bindings.includes(3));assert.equal(report.receivers.released,true)
 assert.ok(report.receivers.lit.some((v,i)=>v-report.receivers.shadowed[i]>.03));assert.ok(report.receivers.restored.every((v,i)=>Math.abs(v-report.receivers.shadowed[i])<.01))
 console.log(JSON.stringify({cascades:report.stats.cascades,stable:report.stable,darker:report.darker}))
}finally{fs.mkdirSync('docs/verification/stage1-B04',{recursive:true});fs.writeFileSync('docs/verification/stage1-B04/'+(umd?'report-umd':'report')+'.json',JSON.stringify(report,null,2));await b.close()}})().catch(e=>{console.error(e.message);process.exitCode=1})
