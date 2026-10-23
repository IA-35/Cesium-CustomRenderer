const fs = require('fs'), path = require('path'), {spawn} = require('child_process')
const {chromium} = require('C:/Users/Administrator/node_modules/playwright')
const root = process.cwd(), out = path.join(root,'docs/verification/rendering-performance/traa-r186-2026-10-16/flicker-diagnosis-20261019')
fs.mkdirSync(out,{recursive:true})
const sparse = process.argv.includes('--sparse'), port = 8994
const campusMode=process.argv.includes('--campus')
const requested=process.argv.find(a=>a.startsWith('--variants='))?.slice(11).split(',')
const source = fs.readFileSync(path.join(root,'src/antialiasing/taaShaders143.js'),'utf8')
const sourceHash=require('crypto').createHash('sha256').update(source).digest('hex')
const variants = {
 current: source,
 'no-reject': source.replace('if (!hasValidHistory) {','if (false) {'),
 'no-clip': source.replace('vec4 clippedHistoryColor = taaVarianceClipping(pixel, size, currentColor, historyColor, varianceGamma);','vec4 clippedHistoryColor = historyColor;'),
 'no-subpixel': source.replace('if (u_useSubpixelCorrection)', 'if (false)'),
 // 修复前语义：最近深度比较 + 天空漏采直接清色。用于判定新出现的闪烁像素是回归还是既有。
 // 拆分两个新语义：只保留天空保持（near）或只保留最远比较（no-sky-hold）。
 'span-no-skyhold': source.replace('if (closestEyeDepth == 0.0 && storedEyeDepth > 0.0 && inBounds && u_cameraStill) {','if (false) {'),
 'skyhold-near': source.replace('expectedPreviousEyeDepth > storedFarthestEyeDepth + max(0.1, 0.02 * expectedPreviousEyeDepth)','expectedPreviousEyeDepth > storedEyeDepth + max(0.1, 0.02 * expectedPreviousEyeDepth)'),
 'old-near': source.replace('expectedPreviousEyeDepth > storedFarthestEyeDepth + max(0.1, 0.02 * expectedPreviousEyeDepth)','expectedPreviousEyeDepth > storedEyeDepth + max(0.1, 0.02 * expectedPreviousEyeDepth)').replace('if (closestEyeDepth == 0.0 && storedEyeDepth > 0.0 && inBounds && u_cameraStill) {','if (false) {'),
 'no-reject-no-clip': source.replace('if (!hasValidHistory) {','if (false) {').replace('vec4 clippedHistoryColor = taaVarianceClipping(pixel, size, currentColor, historyColor, varianceGamma);','vec4 clippedHistoryColor = historyColor;'),
}
async function main(){
 const server=spawn(process.execPath,['scripts/dev-server.cjs','--port',String(port)],{cwd:root,windowsHide:true,stdio:'ignore'})
 let browser
 try {
  for(let i=0;i<50;i++){try{if((await fetch(`http://127.0.0.1:${port}/`)).ok)break}catch{} await new Promise(r=>setTimeout(r,100))}
  browser=await chromium.launch({channel:'chrome',headless:true,args:['--use-angle=d3d11']})
  for(const [name,shader] of Object.entries(variants)){
   if(requested?!requested.includes(name):campusMode&&name!=='current')continue
   const page=await browser.newPage({viewport:{width:640,height:420}})
   await page.route('**/src/antialiasing/taaShaders143.js',route=>route.fulfill({body:shader,contentType:'application/javascript'}))
   if(campusMode)await page.route('**/build/0.1.0/CCR.min.js',r=>r.fulfill({contentType:'application/javascript',body:'import * as CCR from "/src/index.js";globalThis.CCR=CCR;'}))
   await page.goto(`http://127.0.0.1:${port}/`+(campusMode?'examples/campus.html?imagery=none&singleFrustum=1&traffic=none':'tests/rendering/taa-r186-fixture.html'))
   await page.waitForFunction(campusMode?()=>window.campus?.models?.length===70&&campus.models.every(m=>m.ready):()=>window.fixture,null,{timeout:180000})
   const result=await page.evaluate(async ({sparse,name,campusMode})=>{
    const f=campusMode?campus:fixture,C=Cesium,s=f.viewer.scene, lib=await import('/tests/rendering/taa-r186-fixture.js')
    if(!campusMode)await lib.startR186Fixture(f)
    else{
     await Promise.all([f.treeReady,f.waterReady]);f.viewer.clock.shouldAnimate=false;f.viewer.useDefaultRenderLoop=false
     const model=f.models.find(m=>m.id?.file==='SM_NH_JZXG.glb')||f.models[0]
     s.camera.lookAt(model.boundingSphere.center,new C.HeadingPitchRange(-.3,-.4,Math.max(60,model.boundingSphere.radius*1.8)));s.camera.lookAtTransform(C.Matrix4.IDENTITY)
     f.step=()=>{f.viewer.render();if(f.errors.length)throw Error(f.errors.join('\n'))}
     f.steps=async n=>{for(let i=0;i<n;i++){f.step();if(i%8===7)await new Promise(requestAnimationFrame)}}
     f.configure=async n=>{f.pipeline.setTaa({enabled:true,jitterSamples:n});await f.steps(128)}
     f.read=texture=>{const ctx=s.context,gl=ctx._gl,rd=gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),dr=gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),cached=ctx._currentFramebuffer;let fb;try{
      if(!texture)return ctx.readPixels({width:640,height:420})
      fb=new C.Framebuffer({context:ctx,colorTextures:[texture],destroyAttachments:false});const p=new Float32Array(640*420*4);fb._bind();gl.readPixels(0,0,640,420,gl.RGBA,gl.FLOAT,p);return p
     }finally{fb?.destroy();gl.bindFramebuffer(gl.READ_FRAMEBUFFER,rd);gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,dr);ctx._currentFramebuffer=cached}}
     f.image=p=>{const c=document.createElement('canvas');c.width=640;c.height=420;const cx=c.getContext('2d'),d=cx.createImageData(640,420);for(let y=0;y<420;y++)d.data.set(p.subarray(y*640*4,(y+1)*640*4),(419-y)*640*4);cx.putImageData(d,0,0);return c.toDataURL()}
    }
    if(sparse){
     f.geometry.forEach(m=>m.show=false)
     for(let x=-20;x<=20;x+=5)await f.addPlane('tiny-'+x,x,0,12,.045,.045,[.95,.95,.95],{emissive:[1,1,1]})
     for(let i=0;i<120&&!f.geometry.every(m=>m.ready);i++){f.step();await new Promise(requestAnimationFrame)}
     if(!f.geometry.every(m=>m.ready))throw Error('Geometry not ready')
    }
    await f.configure(8)
    await f.steps(512)
    const initial=f.pipeline.getTaaDiagnostics()
    if(!initial.valid||initial.staticFrames<32||initial.jitter.samples!==8)throw Error('TAA diagnostic preconditions failed: '+JSON.stringify(initial))
    const n=640*420, sum=new Float64Array(n),sq=new Float64Array(n),lo=new Float32Array(n).fill(1e9),hi=new Float32Array(n)
    const frames=[]
    for(let t=0;t<64;t++){
     f.step();const p=f.read();frames.push(p)
     for(let i=0;i<n;i++){const v=p[4*i]*.2126+p[4*i+1]*.7152+p[4*i+2]*.0722;sum[i]+=v;sq[i]+=v*v;lo[i]=Math.min(lo[i],v);hi[i]=Math.max(hi[i],v)}
     if(t%8===7)await new Promise(requestAnimationFrame)
    }
    const stats=Array.from(sum,(v,i)=>({i,std:Math.sqrt(Math.max(0,sq[i]/64-(v/64)**2)),range:hi[i]-lo[i]})).sort((a,b)=>b.std-a.std)
    const top=stats.slice(0,20).map(p=>({...p,x:p.i%640,y:Math.floor(p.i/640),values:frames.map(f=>Array.from(f.slice(4*p.i,4*p.i+3)))}))
    const tracked=[[252,65],[379,199],[267,309],[631,289],[632,264],[599,246],[491,356]].map(([x,y])=>({...stats.find(p=>p.i===y*640+x),x,y,values:frames.map(f=>Array.from(f.slice(4*(y*640+x),4*(y*640+x)+3)))}))
    const report={name,sparse,campusMode,models:campusMode?f.models.filter(m=>m.ready).length:f.geometry.length,gpu:f.gpu,diagnostics:f.pipeline.getTaaDiagnostics(),max:stats[0].std,p99:stats[Math.floor(n*.01)].std,pixelsStdOver1:stats.filter(p=>p.std>1).length,pixelsRangeOver10:stats.filter(p=>p.range>10).length,top,tracked,image:f.image(frames[0])}
    if(name==='current'){
     const taa=f.pipeline.taa,stage=taa.frames[0].resolve;let active=stage
     const uniforms=Object.fromEntries(Object.keys(stage._uniformMap).filter(k=>k.startsWith('u_')&&!k.endsWith('Dimensions')).map(k=>[k,()=>active._uniformMap[k]()]))
     const probes=[
      stage.fragmentShader.replace('if (!hasValidHistory) {','out_FragColor=vec4(hasValidHistory?0.0:1.0,relativeDisocclusion?1.0:0.0,closestEyeDepth,storedEyeDepth);return; if (!hasValidHistory) {'),
      // 拒因拆位：x=localValid y=inBounds z=edge w=disocclusion。
      stage.fragmentShader.replace('if (!hasValidHistory) {','out_FragColor=vec4(localValid?1.0:0.0,inBounds?1.0:0.0,edge?1.0:0.0,disocclusion?1.0:0.0);return; if (!hasValidHistory) {'),
      stage.fragmentShader.replace('out_FragColor = vec4(taaFlickerReduction(currentColor, clippedHistoryColor, currentWeight).rgb,','out_FragColor=vec4(currentWeight,length(clippedHistoryColor.rgb-historyColor.rgb),length(offsetUV*vec2(size)),acquisitionAge);return; out_FragColor = vec4(taaFlickerReduction(currentColor, clippedHistoryColor, currentWeight).rgb,')
     ].map((shader,i)=>{const p=new C.PostProcessStage({name:'flicker_probe_'+i,fragmentShader:shader,uniforms,pixelFormat:C.PixelFormat.RGBA,pixelDatatype:C.PixelDatatype.FLOAT});return {p,c:taa._collection('flicker_probe_'+i,p)}})
     report.probes=[];let sample
     for(const frame of taa.frames){const execute=frame.collection.execute;frame.collection.execute=function(context,color,depth,id){
      const r=execute.call(this,context,color,depth,id);active=frame.resolve
      sample={jitter:{...taa.jitter.pixel},points:top.map(p=>({x:p.x,y:p.y}))}
      for(let j=0;j<probes.length;j++){const {p,c}=probes[j];c.update(context,s.frameState.useLogDepth,false);c.clear(context);if(!c.ready)continue;c.execute(context,color,depth,id);const a=f.read(p.outputTexture);top.forEach((v,i)=>sample.points[i]['probe'+j]=Array.from(a.slice(v.i*4,v.i*4+4)))}
      return r
     }}
     for(let t=0;t<16;t++){f.step();report.probes.push(sample);await new Promise(requestAnimationFrame)}
    }
    return report
   },{sparse,name,campusMode})
   const label=(campusMode?'campus-':sparse?'sparse-':'rails-')+name
   fs.writeFileSync(path.join(out,label+'.png'),Buffer.from(result.image.split(',')[1],'base64'));delete result.image
   fs.writeFileSync(path.join(out,label+'.json'),JSON.stringify({...result,sourceHash,date:new Date().toISOString()},null,2))
   console.log(label,JSON.stringify({max:result.max,p99:result.p99,pixelsStdOver1:result.pixelsStdOver1,pixelsRangeOver10:result.pixelsRangeOver10,top:result.top.slice(0,3).map(({x,y,std,range})=>({x,y,std,range}))}))
   await page.close()
  }
 }finally{await browser?.close();server.kill()}
}
main().catch(e=>{console.error(e);process.exitCode=1})
