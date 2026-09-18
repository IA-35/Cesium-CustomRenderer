const {chromium}=require(process.env.CESIUM_PLAYWRIGHT||'playwright'),fs=require('node:fs'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process')
const original=execFileSync('git',['show','60538e0:src/shadows/LightFrustum.js'],{maxBuffer:1e6})
;(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true}),report={};try{
 for(const version of ['before','current']){
  const page=await browser.newPage({viewport:{width:640,height:420}}),errors=[];page.on('pageerror',e=>errors.push(e.message))
  if(version==='before')await page.route('**/src/shadows/LightFrustum.js',r=>r.fulfill({contentType:'text/javascript',body:original}))
  await page.goto('http://127.0.0.1:'+(process.env.CCR_TEST_PORT||8877)+'/tests/rendering/stage1-fixture.html');await page.waitForFunction(()=>window.fixture)
  report[version]=await page.evaluate(async()=>{
   const f=fixture,C=Cesium,s=f.viewer.scene,m=await import('/tests/rendering/shadow-cascades-fixture.js'),{waitFrames}=await import('/tests/rendering/ssr-surfaces-fixture.js')
   await m.startCascadeFixture(f);const light=s.light,p=f.pipeline,wait=n=>waitFrames(s,n,f.errors)
   p.setOptions({shadowCascades:1,shadowSize:4096,shadowStatic:false});s.light=light;await wait(15)
   const frame=C.Transforms.eastNorthUpToFixedFrame(f.origin),runs=[]
   for(const cascades of [1,3]){
   p.setOptions({shadowCascades:cascades});s.light=light;await wait(10)
   for(const step of [1e-7,1e-5]){
    let previous,totalChanged=0,maxDelta=0,frames=0
    for(let i=0;i<90;i++){
     const direction=C.Cartesian3.normalize(C.Matrix4.multiplyByPointAsVector(frame,new C.Cartesian3(-.4+i*step,-.3,1),new C.Cartesian3()),new C.Cartesian3())
     C.Cartesian3.negate(direction,s.light.direction);await wait(1)
     if(!p.customShadow.ready)throw new Error('Shadow unavailable during solar motion')
     const pixels=m.framePixels(C,s)
     if(previous){frames++;for(let j=0;j<pixels.length;j+=4){let d=0;for(let c=0;c<3;c++)d=Math.max(d,Math.abs(pixels[j+c]-previous[j+c]));maxDelta=Math.max(maxDelta,d);if(d>3)totalChanged++}}
     previous=pixels
    }
    runs.push({cascades,step,frames,totalChanged,changedPixelsPerFrame:totalChanged/frames,maxDelta})
   }
   }
   return {runs,errors:f.errors,camera:{position:s.camera.positionWC,direction:s.camera.directionWC},casters:p.customShadow.stats.casters}
  });report[version].pageErrors=errors;await page.close()
 }
 fs.writeFileSync('docs/verification/solar-shadow-motion.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))
 for(const run of Object.values(report)){assert.deepEqual(run.errors,[]);assert.deepEqual(run.pageErrors,[]);assert.ok(run.casters>0)}
 for(let i=0;i<4;i++)assert.ok(report.current.runs[i].changedPixelsPerFrame<report.before.runs[i].changedPixelsPerFrame*.5,'solar shadow flicker must decrease by at least 50%')
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1})
