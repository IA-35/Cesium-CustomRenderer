const fs=require('fs'),path=require('path'),{spawn}=require('child_process'),{chromium}=require('C:/Users/Administrator/node_modules/playwright')
const out=path.resolve('docs/verification/rendering-performance/traa-r186-2026-10-16/fixes-20261019/mouse');fs.mkdirSync(out,{recursive:true})
async function main(){
 const server=spawn(process.execPath,['scripts/dev-server.cjs','--port','8995'],{windowsHide:true,stdio:'ignore'});let browser
 try{
  for(let i=0;i<50;i++){try{if((await fetch('http://127.0.0.1:8995/')).ok)break}catch{}await new Promise(r=>setTimeout(r,100))}
  browser=await chromium.launch({channel:'chrome',headless:true,args:['--use-angle=d3d11']});const page=await browser.newPage({viewport:{width:640,height:420}})
  await page.goto('http://127.0.0.1:8995/tests/rendering/taa-r186-fixture.html');await page.waitForFunction(()=>window.fixture)
  await page.evaluate(async()=>{const r=await import('/tests/rendering/taa-r186-fixture.js');await r.startR186Fixture(fixture);await fixture.configure(8);await fixture.steps(512)})
  const report=[]
  for(const mode of ['none','mouse-only','pick-model','pick-empty','pick-position','drill-empty']){
   await page.evaluate(async()=>{await fixture.steps(64)})
   if(mode==='mouse-only')await page.mouse.move(240,160)
   report.push(await page.evaluate(async mode=>{
    const f=fixture,s=f.viewer.scene,t=f.pipeline.taa,C=Cesium
    const snap=()=>({frame:s.frameState.frameNumber,passes:{...s.frameState.passes},frustums:s._view.frustumCommandsList.length,history:t.historyValid,age:t.historyAge,static:t.staticFrames,healthy:t.healthy,overlay:t.overlay.active,jitter:t.jitter.index,stats:{...t.stats},motion:{active:t.motion.active,records:t.motion.records.size,...t.motion.stats}})
    const r={mode,before:snap(),frames:[],images:[{frame:'before',png:f.image(f.read())}]},execute=t._execute;let entry
    t._execute=function(...args){entry=snap();return execute.apply(this,args)}
    try{
     if(mode==='pick-model')r.picked=!!s.pick(new C.Cartesian2(320,210))
     if(mode==='pick-empty')r.picked=!!s.pick(new C.Cartesian2(2,2))
     if(mode==='pick-position')r.picked=!!s.pickPosition(new C.Cartesian2(320,210))
     if(mode==='drill-empty')r.picked=s.drillPick(new C.Cartesian2(2,2)).length
     r.after=snap()
     for(let i=0;i<5;i++){f.step();r.frames.push({entry,after:snap()});r.images.push({frame:i,png:f.image(f.read())});await new Promise(requestAnimationFrame)}
    }finally{t._execute=execute}
    return r
   },mode))
  }
  for(const r of report)for(const image of r.images){const file=r.mode+'-'+image.frame+'.png';fs.writeFileSync(path.join(out,file),Buffer.from(image.png.split(',')[1],'base64'));delete image.png;image.file=file}
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report.map(r=>({mode:r.mode,picked:r.picked,frustumsAfterPick:r.after.frustums,frames:r.frames.map(f=>({age:f.entry.age,valid:f.entry.history,motion:f.after.motion}))})),null,2))
 }finally{await browser?.close();server.kill()}
}
main().catch(e=>{console.error(e);process.exitCode=1})

