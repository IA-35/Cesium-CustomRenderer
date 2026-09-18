const {chromium}=require(process.env.CESIUM_PLAYWRIGHT||'playwright'),fs=require('node:fs'),assert=require('node:assert/strict')
const source=process.argv.includes('--source'),before=process.argv.includes('--before')
const out='docs/verification/campus-shadow-motion'+(before?'':'-fixed');fs.mkdirSync(out,{recursive:true})
;(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true}),report={};try{
 const page=await browser.newPage({viewport:{width:960,height:540}})
 if(before)await page.route('**/build/0.1.0/CCR.min.js',r=>r.fulfill({contentType:'text/javascript',body:fs.readFileSync('docs/verification/campus-shadow-before.min.js')}))
 if(source)await page.route('**/build/0.1.0/CCR.min.js',r=>r.fulfill({contentType:'text/javascript',body:"import * as CCR from '/src/index.js';globalThis.CCR=CCR;"}))
 page.on('pageerror',e=>console.error(e.message))
 await page.goto('http://127.0.0.1:'+(process.env.CCR_TEST_PORT||8877)+'/examples/campus.html?imagery=none&assets=http%3A%2F%2F127.0.0.1%3A8083%2FDongda')
 await page.waitForFunction(()=>window.campus?.tiles.length===window.campus?.expectedTiles||window.campus?.errors.length,null,{timeout:90000})
 for(const view of ['overview','near','morning','evening']){
  console.log('Capturing '+view)
  const result=await page.evaluate(async view=>{
   const C=Cesium,f=campus,p=f.pipeline,s=f.viewer.scene,{waitFrames}=await import('/tests/rendering/ssr-surfaces-fixture.js'),{framePixels}=await import('/tests/rendering/shadow-cascades-fixture.js')
   if(f.errors.length)throw new Error(JSON.stringify(f.errors))
   const wait=n=>waitFrames(s,n,f.errors,120000),base=C.JulianDate.fromIso8601(view==='morning'?'2026-09-07T22:30:00Z':view==='evening'?'2026-09-08T09:30:00Z':'2026-09-08T03:00:00Z')
   f.viewer.clock.shouldAnimate=false;s.screenSpaceCameraController.enableInputs=false
   f.look(view==='overview'?-.65:-.45,view==='overview'?1800:750)
   let stable=0,deadline=performance.now()+120000
   while(stable<15&&performance.now()<deadline){await wait(1);stable=f.tiles.concat(f.contextTiles).every(t=>t.tilesLoaded)?stable+1:0}
   if(stable<15)throw new Error('Tiles still changing')
   const cases=[]
   for(const mode of ['static','dynamic','dynamic-no-shadows']){
    f.viewer.clock.currentTime=C.JulianDate.clone(base);p.setOptions({shadows:mode!=='dynamic-no-shadows'});await wait(80)
    let previous;const frames=[],images=[],signs=new Int8Array(s.drawingBufferWidth*s.drawingBufferHeight),flips=new Uint16Array(signs.length)
    for(let i=0;i<90;i++){
     f.viewer.clock.currentTime=C.JulianDate.addSeconds(base,mode==='static'?0:i/6,new C.JulianDate());await wait(1)
     const pixels=framePixels(C,s);let changed=0,max=0,sum=0
     if(previous)for(let j=0;j<pixels.length;j+=4){let d=0;for(let c=0;c<3;c++)d=Math.max(d,Math.abs(pixels[j+c]-previous[j+c]));if(d>3)changed++;max=Math.max(max,d);sum+=d;const luma=(pixels[j]+pixels[j+1]+pixels[j+2]-previous[j]-previous[j+1]-previous[j+2])/3;if(Math.abs(luma)>3){const sign=Math.sign(luma);if(signs[j/4]&&signs[j/4]!==sign)flips[j/4]++;signs[j/4]=sign}}
     const shadow=p.customShadow,light=shadow?.light
     frames.push({changed,max,mean:sum/(pixels.length/4),ready:shadow?.ready,casters:shadow?.stats.casters,extent:shadow?.stats.coverage?.extent,
      sun:light?C.Cartesian3.clone(light.camera.directionWC):null,matrix:light?C.Matrix4.toArray(light.viewProjection):null})
     if(i%5===0)images.push({index:i,png:s.canvas.toDataURL('image/png')})
     previous=pixels
    }
    cases.push({mode,frames,images,repeatedFlickerPixels:flips.filter(n=>n>=2).length})
   }
   return {cases,options:p.getOptions(),errors:f.errors}
  },view)
  for(const c of result.cases){const dir=out+'/'+view+'-'+c.mode;fs.mkdirSync(dir,{recursive:true});for(const im of c.images)fs.writeFileSync(dir+'/'+String(im.index).padStart(3,'0')+'.png',Buffer.from(im.png.split(',')[1],'base64'));delete c.images}
  report[view]=result
  fs.writeFileSync(out+'/report.json',JSON.stringify(report,null,2))
  assert.deepEqual(result.errors,[])
  for(const c of result.cases.filter(c=>c.mode!=='dynamic-no-shadows'))assert.ok(c.frames.every(f=>f.ready&&f.casters>500),'Actual business casters must remain active')
  console.log(JSON.stringify(result.cases.map(c=>({mode:c.mode,repeatedFlickerPixels:c.repeatedFlickerPixels,changedMean:c.frames.slice(1).reduce((n,f)=>n+f.changed,0)/89,max:Math.max(...c.frames.map(f=>f.max)),casterChanges:new Set(c.frames.map(f=>f.casters)).size}))))
 }
 if(!before){
  const baseline=JSON.parse(fs.readFileSync('docs/verification/campus-shadow-motion/report.json','utf8'))
  for(const view of Object.keys(report)){
   const current=report[view].cases.find(c=>c.mode==='dynamic'),old=baseline[view].cases.find(c=>c.mode==='dynamic')
   assert.ok(current.repeatedFlickerPixels<old.repeatedFlickerPixels*(view==='morning'||view==='evening'?.6:.1),view+': repeated flicker must materially decrease')
  }
 }
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1})
