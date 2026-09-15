// Real B01 matrix: linear HDR composition, actual object IDs, resources and fail-closed modes.
const {chromium}=require(process.env.CESIUM_PLAYWRIGHT||'playwright')
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const root=path.resolve(__dirname,'..'),out=path.join(root,'docs/verification/stage1-B01-fixed')
const origin='http://127.0.0.1:'+(process.env.CCR_TEST_PORT||8877)
const modes=[['mrt',''],['msaa4','?msaa=4'],['multipass',''],['multifrustum',''],['sorted','?oit=0'],['no-glass','?glass=0'],['umd','']]
;(async()=>{
 fs.mkdirSync(out,{recursive:true})
 const browser=await chromium.launch({channel:'chrome',headless:true}),report={modes:[],errors:[]}
 try{
  for(const [id,query] of modes){
   const page=await browser.newPage({viewport:{width:640,height:400}}),errors=[]
   page.on('pageerror',e=>errors.push(e.message))
   await page.goto(origin+'/tests/rendering/frame-bridge-fixture.html'+query)
   await page.waitForFunction(()=>window.fixture)
   const result=await page.evaluate(async id=>{
    const m=await import('/tests/rendering/frame-bridge-fixture.js'),f=fixture,C=Cesium
    if(id==='umd'){
      await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='/build/0.1.0/CCR.min.js';script.onload=resolve;script.onerror=reject;document.head.append(script)})
      f.CCR=window.CCR
    }
    if(id==='multipass'){
      const s=f.viewer.scene,old=s._view.oit
      s._view.oit=new old.constructor(new Proxy(s.context,{get:(target,key)=>key==='drawBuffers'?false:Reflect.get(target,key,target)}))
      old.destroy()
    }
    await m.startFrameBridgeFixture(f)
    const s=f.viewer.scene,ctx=s.context,gl=ctx._gl,wait=n=>m.waitFrames(s,n,f.errors)
    if(id==='multifrustum'){s.farToNearRatio=2;s.logarithmicDepthFarToNearRatio=2}
    await wait(8)
    const p=C.SceneTransforms.worldToWindowCoordinates(s,f.glassPoint)
    const point={x:Math.round(p.x),y:Math.round(p.y)},opaque={x:560,y:120}
    // Read linear input before the native tonemapper; use a separate FBO and restore both caches.
    const {registerHdrEffect}=await import('/src/environment/HdrCoordinator143.js')
    const unpack=v=>{const e=(v>>10)&31,m=v&1023;return (v&32768?-1:1)*(e===0?m*2**-24:(1+m/1024)*2**(e-15))}
    let hdr={},cacheOK=true,attachments=new Map()
    const stop=registerHdrEffect(s,-1000,(context,color)=>{
      const g=context._gl,rd=g.getParameter(g.READ_FRAMEBUFFER_BINDING),dr=g.getParameter(g.DRAW_FRAMEBUFFER_BINDING),prev=context._currentFramebuffer
      try{
       let fb=attachments.get(color)
       if(!fb){fb=new C.Framebuffer({context,colorTextures:[color],destroyAttachments:false});attachments.set(color,fb)}
       const sample=pt=>Array.from(context.readPixels({framebuffer:fb,x:pt.x,y:color.height-1-pt.y,width:1,height:1}),v=>color.pixelDatatype===C.PixelDatatype.HALF_FLOAT?unpack(v):v)
       hdr={glass:sample(point),opaque:sample(opaque)}
      }finally{g.bindFramebuffer(g.READ_FRAMEBUFFER,rd);g.bindFramebuffer(g.DRAW_FRAMEBUFFER,dr);context._currentFramebuffer=prev}
      return color
    })
    const ids=[]
    for(const model of f.models){
      const world=C.Matrix4.getTranslation(model.modelMatrix,new C.Cartesian3())
      const pt=C.SceneTransforms.worldToWindowCoordinates(s,world)
      if(pt)ids.push({model,pt})
    }
    if(f.glass)f.glass.show=false
    await wait(4)
    const beforePicks=ids.map(x=>s.pick(x.pt)?.id),beforePositions=ids.map(x=>s.pickPosition(x.pt))
    if(f.glass)f.glass.show=true
    await wait(4)
    const b=m.attachBridge(f,{replacement:[.15,.35,.1,1]})
    let readValues
    const offRead=b.on('translucent',()=>{
      const cached=ctx._currentFramebuffer,rd=gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),dr=gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)
      readValues=b.readOpaqueColor(10,10)
      cacheOK &&=ctx._currentFramebuffer===cached && rd===gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) && dr===gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)
    },{priority:10})
    const mixes=[]
    for(const alpha of (f.glass?[0,.5,1]:[0])){
      if(f.glass)f.setGlassAlpha(alpha)
      await wait(8)
      mixes.push({alpha,actual:hdr.glass.slice(0,3),opaque:hdr.opaque.slice(0,3),
        expected:[.2,.5,.8].map((v,i)=>alpha*v+(1-alpha)*[.15,.35,.1][i])})
    }
    const phaseContexts=f.bridgeLog.slice(-8),environment={useOIT:s._environmentState.useOIT,mrt:s._view.oit?._translucentMRTSupport,
      multipass:s._view.oit?._translucentMultipassSupport,samples:s._view.oit?._opaqueFBO?._numSamples,frustums:s._view.frustumCommandsList.length}
    const rejectedOutside=b.uploadOpaqueColor([1,0,0,1])
    if(f.glass)f.glass.show=false
    await wait(4)
    const afterPicks=ids.map(x=>s.pick(x.pt)?.id),afterPositions=ids.map(x=>s.pickPosition(x.pt))
    const pickIdentity=beforePicks.every((v,i)=>v===afterPicks[i])
    const uniquePicks=[...new Set(beforePicks.filter(Boolean))]
    const depthDelta=beforePositions.reduce((max,a,i)=>Math.max(max,a&&afterPositions[i]?C.Cartesian3.distance(a,afterPositions[i]):a===afterPositions[i]?0:Infinity),0)
    const oldFramebuffer=b.state.scratch.framebuffer
    b.setEnabled(false);await wait(4);const disabled=hdr.opaque.slice(0,3)
    b.setEnabled(true);await wait(4)
    f.checkState={b,stop,attachments,oldFramebuffer,wait,offRead}
    return {id,point,mixes,environment,pickIdentity,uniquePicks,depthDelta,cacheOK,readValues,
      rejectedOutside,disabled,phaseContexts,lastReplacement:f.lastReplacement,errors:[...f.errors,...b.getDiagnostics().errors]}
   },id)
   if(id==='mrt'){
    await page.setViewportSize({width:801,height:603})
    result.lifecycle=await page.evaluate(async()=>{
      const f=fixture,{b,wait,oldFramebuffer}=f.checkState
      f.viewer.resize();await wait(8)
      const size=[f.viewer.scene.drawingBufferWidth,f.viewer.scene.drawingBufferHeight]
      const target=b.state.scratch.framebuffer,texture=b.state.scratch.texture
      const cached=f.viewer.scene.context._currentFramebuffer
      const read=b.readOpaqueColor(10,10)
      const cacheRestored=cached===f.viewer.scene.context._currentFramebuffer
      const oldReleased=oldFramebuffer.isDestroyed()
      b.uninstall()
      const released=target.isDestroyed(),borrowedAlive=!texture.isDestroyed()
      b.install();await wait(4)
      const errors=b.getDiagnostics().errors
      return {size,read,cacheRestored,oldReleased,released,borrowedAlive,errors}
    })
   }
   result.pageErrors=errors
   report.modes.push(result)
   await page.screenshot({path:path.join(out,id+'.png')})
   result.contextLoss=await page.evaluate(async id=>{
     const {b,stop,attachments}=fixture.checkState
     let retired = null
     if(id==='no-glass'){
       const canvas=fixture.viewer.canvas,gl=fixture.viewer.scene.context._gl
       await new Promise(resolve=>{canvas.addEventListener('webglcontextlost',resolve,{once:true});gl.getExtension('WEBGL_lose_context').loseContext()})
       retired=!b.installed&&!b.state.scratch.framebuffer
     }
     stop();b.destroy()
     fixture.cleanup={released:!b.state.scratch.framebuffer,errors:fixture.errors}
     for(const fb of attachments.values())fb.destroy()
     return retired
   },id)
   if(id==='no-glass')assert.equal(result.contextLoss,true,'context loss must retire bridge')
   assert.deepEqual(result.errors,[],id+' callback/render errors')
   assert.deepEqual(errors,[],id+' page errors')
   assert.equal(result.rejectedOutside.applied,false,id+' outside write')
   if(id!=='sorted'){
    assert.equal(result.lastReplacement.applied,true,id+' replacement')
    assert.equal(result.cacheOK,true,id+' bindings')
    for(const mix of result.mixes){
      assert.ok(mix.actual.every((v,i)=>Math.abs(v-mix.expected[i])<.015),id+' linear mix '+JSON.stringify(mix))
    }
    assert.ok(result.readValues.value.slice(0,3).every((v,i)=>Math.abs(v-[.15,.35,.1][i])<.002),id+' half float decode')
   }else{
    assert.ok(result.phaseContexts.every(x=>x.phase==='resolve'),'sorted fabricated phase')
    assert.equal(result.lastReplacement,undefined)
   }
   assert.equal(result.pickIdentity,true,id+' pick identity')
   assert.ok(result.uniquePicks.length>=2,id+' discriminates model IDs')
   assert.ok(result.depthDelta<.25,id+' depth')
   if(id==='msaa4')assert.equal(result.environment.samples,4)
   if(id==='multipass'){assert.equal(result.environment.mrt,false);assert.equal(result.environment.multipass,true)}
   if(id==='multifrustum')assert.ok(result.environment.frustums>1)
   if(result.lifecycle){for(const k of ['oldReleased','released','borrowedAlive','cacheRestored'])assert.equal(result.lifecycle[k],true,k);assert.deepEqual(result.lifecycle.errors,[])}
   await page.close()
  }
 }catch(e){report.errors.push(e.message);throw e}
 finally{fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));await browser.close()}
 console.log(JSON.stringify({modes:report.modes.map(x=>({id:x.id,...x.environment,point:x.point})),errors:report.errors}))
})().catch(e=>{console.error(e);process.exitCode=1})
