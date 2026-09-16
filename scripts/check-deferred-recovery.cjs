// Exercise faults after successful startup, including partially captured frames.
const {chromium}=require(process.env.CESIUM_PLAYWRIGHT||'playwright')
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const output=path.join(__dirname,'../docs/verification/stage1-B02-recovery')
const cases=['geometry-before','geometry-after','geometry-multifrustum','lighting-ao','scope-ao','compatibility-ao','geometry-umd']
;(async()=>{
 fs.mkdirSync(output,{recursive:true})
 const browser=await chromium.launch({channel:'chrome',headless:true}),report={cases:[]}
 try{
  const selected=process.argv.includes('--case')
  const only=selected?process.argv[process.argv.indexOf('--case')+1]:null
  if(selected)assert.ok(cases.includes(only),'unknown recovery case')
  for(const name of cases.filter(name=>!selected||name===only)){
   const page=await browser.newPage({viewport:{width:800,height:500}}),errors=[]
   page.on('pageerror',e=>errors.push(e.message))
   const origin='http://127.0.0.1:'+(process.env.CCR_TEST_PORT||8877)
   await page.goto(origin+'/tests/rendering/deferred-lighting-fixture.html');await page.waitForFunction(()=>window.fixture)
   if(name==='geometry-umd'){await page.addScriptTag({url:origin+'/build/0.1.0/CCR.min.js'});await page.evaluate(()=>{fixture.CCR=CCR})}
   const r=await page.evaluate(async name=>{
    const C=Cesium,f=fixture,m=await import('/tests/rendering/deferred-lighting-fixture.js')
    await m.startDeferredFixture(f)
    const p=f.pipeline,s=f.viewer.scene,ctx=s.context,wait=n=>m.waitFrames(s,n,f.errors)
    if(name==='geometry-multifrustum'){s.farToNearRatio=1.05;s.logarithmicDepthFarToNearRatio=1.05}
    await wait(35)
    const points=m.samplePoints(f).points
    // HDR values, rather than tonemapped screenshot equality.
    const texture=new C.Texture({context:ctx,width:1,height:1,pixelFormat:C.PixelFormat.RGBA,pixelDatatype:C.PixelDatatype.FLOAT})
    const fb=new C.Framebuffer({context:ctx,colorTextures:[texture],destroyAttachments:false})
    const options={viewport:new C.BoundingRectangle(0,0,1,1),depthTest:{enabled:false},depthMask:false}
    let source,uv=new C.Cartesian2()
    const probe=ctx.createViewportQuadCommand('uniform sampler2D src;uniform vec2 uv;void main(){out_FragColor=texture(src,uv);}',{
      framebuffer:fb,renderState:C.RenderState.fromCache(options),uniformMap:{src:()=>source,uv:()=>uv}})
    const samples=()=>{
      const gl=ctx._gl,read=gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),draw=gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),cached=ctx._currentFramebuffer,viewport=C.BoundingRectangle.clone(ctx.uniformState.viewport)
      source=s._view.sceneFramebuffer._colorFramebuffer.getColorTexture(0)
      try{return points.map(point=>{uv.x=(point.x+.5)/source.width;uv.y=(source.height-1-point.y+.5)/source.height;probe.execute(ctx);return Array.from(ctx.readPixels({framebuffer:fb,width:1,height:1})).slice(0,3)})}
      finally{gl.bindFramebuffer(gl.READ_FRAMEBUFFER,read);gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,draw);ctx._currentFramebuffer=cached;ctx.uniformState.viewport=viewport}
    }
    const native=samples()
    p.setLighting({mode:'deferred'});await wait(8)
    if(name.endsWith('-ao')){p.setScreenSpaceAO({enabled:true,algorithm:'hbao'});await wait(8)}
    const d=p.deferredLighting,g=d.materials,originalCapture=g.capture,originalWrite=d.writeTarget,originalScope=g.scopeReason,originalNeutral=g.neutralFeatures
    const r={name,aoBefore:p.getScreenSpaceAODiagnostics().valid,frustums:s._view.frustumCommandsList.length}
    let trigger=false,priorCaptured=0
    if(name==='compatibility-ao')g.neutralFeatures=()=>{trigger=true;return false}
    else if(name==='scope-ao')g.scopeReason=()=>{trigger=true;return 'injected runtime scope fallback'}
    else if(name==='lighting-ao')d.writeTarget=()=>{trigger=true;throw new Error('injected lighting failure')}
    else g.capture=function(draw,command,ps){
      if(!trigger&&this.captured.length>=2){
        trigger=true;priorCaptured=this.captured.length
        if(name==='geometry-before')throw new Error('injected geometry failure')
        originalCapture.call(this,draw,command,ps)
        throw new Error('injected geometry failure')
      }
      return originalCapture.call(this,draw,command,ps)
    }
    f.viewer.useDefaultRenderLoop=false;s.requestRender();f.viewer.render()
    const actual=samples()
    r.triggered=trigger;r.priorCaptured=priorCaptured;r.failed=d.failed;r.enabled=d.enabled;r.reason=d.reason
    r.sameFrameParity=actual.every((sample,i)=>sample.every((v,c)=>Number.isFinite(v)&&Math.abs(v-native[i][c])<=Math.max(.01,Math.abs(native[i][c])*.02)))
    r.maxError=Math.max(...actual.flatMap((sample,i)=>sample.map((v,c)=>Math.abs(v-native[i][c]))))
    g.capture=originalCapture;d.writeTarget=originalWrite
    f.viewer.useDefaultRenderLoop=true;await wait(6)
    r.aoAfter=p.getScreenSpaceAODiagnostics();r.legacyEnabled=p.materialChannels?.enabled
    g.scopeReason=originalScope;g.neutralFeatures=originalNeutral
    if(name!=='scope-ao'&&name!=='compatibility-ao'){p.setLighting({mode:'enhanced'});p.setLighting({mode:'deferred'})}
    s.requestRender();await wait(8)
    r.retry=p.getLightingDiagnostics().valid;r.legacyAfterRetry=!!p.materialChannels?.enabled;r.renderErrors=f.errors.slice()
    probe.shaderProgram.destroy();C.RenderState.removeFromCache(options);fb.destroy();texture.destroy()
    return r
   },name)
   r.pageErrors=errors;report.cases.push(r);await page.close()
  }
  for(const r of report.cases){
   assert.deepEqual(r.pageErrors,[],r.name);assert.deepEqual(r.renderErrors,[],r.name+' render errors')
   const soft=r.name==='scope-ao'||r.name==='compatibility-ao'
   assert.equal(r.triggered,true);assert.equal(r.failed,!soft);assert.equal(r.enabled,soft)
   assert.match(r.reason,r.name==='compatibility-ao'?/No supported PBR draws/:/injected/)
   assert.equal(r.sameFrameParity,true,r.name+' same-frame color recovery: '+r.maxError);assert.equal(r.retry,true,r.name+' retry')
   if(r.name.endsWith('-ao')){assert.equal(r.aoBefore,true);assert.equal(r.aoAfter.valid,true);assert.equal(r.legacyEnabled,true);assert.equal(r.legacyAfterRetry,false)}
   else assert.ok(r.priorCaptured>=2)
  }
  console.log(JSON.stringify(report.cases.map(r=>({name:r.name,recovered:r.sameFrameParity,retry:r.retry,ao:r.aoAfter.valid}))))
 }finally{fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));await browser.close()}
})().catch(e=>{console.error(e.message);process.exitCode=1})
