// Render the committed B03 sources and current sources with identical generated
// scenes. This records an intentional baseline change; it never updates goldens.
const {chromium}=require(process.env.CESIUM_PLAYWRIGHT||'playwright'),fs=require('node:fs'),{execFileSync}=require('node:child_process'),assert=require('node:assert/strict')
const reference='b94a9b8',out='docs/verification/stage1-B04/upgrade'
;(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true}),report={reference,captures:[],errors:[]},images=new Map();fs.mkdirSync(out,{recursive:true});try{
 for(const version of ['b03','current']){
  const page=await browser.newPage({viewport:{width:1280,height:720}});page.on('pageerror',e=>report.errors.push(e.message))
  if(version==='b03')await page.route('**/src/**',async route=>{
   const name=decodeURIComponent(new URL(route.request().url()).pathname).slice(1)
   await route.fulfill({contentType:'text/javascript',body:execFileSync('git',['show',reference+':'+name],{maxBuffer:4e6})})
  })
  await page.goto('http://127.0.0.1:'+(process.env.CCR_TEST_PORT||8877)+'/tests/rendering/stage1-fixture.html');await page.waitForFunction(()=>window.fixture)
  await page.evaluate(async()=>{
   const f=fixture,m=await import('/tests/rendering/stage1-baseline-fixture.js'),{startStage1Scene}=await import('/tests/rendering/stage1-scene.js');await startStage1Scene(f)
   m.freezeTime(f.viewer);f.viewer.scene.screenSpaceCameraController.enableInputs=false
   const p=f.pipeline;p.setEnabled(false);m.applyShot(f.viewer,m.BASELINE_SHOTS[0],f.origin)
   if(p.customShadow){p.customShadow.destroy();p.customShadow=null}p.setEnabled(true)
   const c=m.baselineConfigurations().find(c=>c.id==='ccr-default');p.setOptions(c.options);p.setScreenSpaceAO(c.screenSpaceAO);p.setScreenSpaceReflections(c.reflections);p.setHdrBloom(c.bloom);p.setAntiAliasing(c.antialiasing)
  })
  for(const id of ['near','panorama','horizon','high-altitude']){
   const sample=await page.evaluate(async id=>{
    const f=fixture,m=await import('/tests/rendering/stage1-baseline-fixture.js');m.applyShot(f.viewer,m.BASELINE_SHOTS.find(s=>s.id===id),f.origin);await m.waitFrames(f.viewer.scene,60,f.errors)
    const {data}=m.readDrawingBuffer(f.viewer);let binary='';for(let i=0;i<data.length;i+=8192)binary+=String.fromCharCode(...data.subarray(i,i+8192))
    return {pixels:btoa(binary),camera:{position:f.viewer.camera.positionWC,direction:f.viewer.camera.directionWC},errors:f.errors}
   },id)
   assert.deepEqual(sample.errors,[]);const bytes=Buffer.from(sample.pixels,'base64');delete sample.pixels
   await page.screenshot({path:out+'/'+version+'-'+id+'.png'})
   if(version==='b03')images.set(id,{bytes,camera:sample.camera})
   else{const old=images.get(id);assert.deepEqual(sample.camera,old.camera);let pixels=0,max=0,sum=0
    for(let i=0;i<bytes.length;i+=4){let changed=false;for(let c=0;c<3;c++){const d=Math.abs(bytes[i+c]-old.bytes[i+c]);max=Math.max(max,d);sum+=d;if(d)changed=true}if(changed)pixels++}
    report.captures.push({shot:id,changedPixels:pixels,ratio:pixels/(bytes.length/4),maxDelta:max,meanAbsoluteDelta:sum/(bytes.length/4*3),camera:sample.camera})
   }
  }
  await page.close()
 }
 assert.deepEqual(report.errors,[]);fs.writeFileSync(out+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report.captures.map(({camera,...x})=>x)))
}finally{await browser.close()}})().catch(e=>{console.error(e.stack);process.exitCode=1})
